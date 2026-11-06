import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { open } from "node:fs/promises";
import { ContextAction, ContextItem, ContextState, contextStateSchema } from "@local-agent/protocol";
import { ContextDenied, containsSensitiveText, excludedByDefault, MAX_FILE_BYTES, WorkspaceGuard } from "./policy";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function rangeDto(range: vscode.Range) { return { startLine: range.start.line + 1, startCharacter: range.start.character, endLine: range.end.line + 1, endCharacter: range.end.character }; }

export class WorkspaceContextService implements vscode.Disposable {
  private selected: vscode.WorkspaceFolder | undefined;
  private lastEditor = vscode.window.activeTextEditor;
  private generation = 0;
  private disposed = false;
  private readonly handles = new Map<string, vscode.Uri>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private state: ContextState = { workspaceLabel: "No folder selected", trusted: false, busy: false, active: null, items: [], files: [], matches: [], truncated: false, notice: null };
  constructor(private readonly emit: (state: ContextState) => void) {
    this.selectInitial();
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => { if (editor) this.lastEditor = editor; this.refreshMetadata(); }),
      vscode.window.onDidChangeTextEditorSelection(() => this.refreshMetadata()),
      vscode.workspace.onDidChangeTextDocument((event) => event.contentChanges.length && this.invalidate(event.document.uri)),
      vscode.workspace.onDidCloseTextDocument((document) => this.invalidate(document.uri)),
      vscode.languages.onDidChangeDiagnostics((event) => { if (event.uris.some((uri) => this.state.items.some((item) => item.documentUri === uri.toString() && item.kind === "diagnostics"))) this.invalidate(); else this.refreshMetadata(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.selected = undefined; this.selectInitial(); this.invalidate(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.invalidate()),
    );
  }
  private selectInitial(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) this.selected = folders[0];
    this.watch();
  }
  private watch(): void {
    this.watcher?.dispose();
    if (!this.selected || this.selected.uri.scheme !== "file") return;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.selected, "**/*"));
    const changed = (uri: vscode.Uri) => { if (!excludedByDefault(path.relative(this.selected!.uri.fsPath, uri.fsPath))) this.invalidate(); };
    this.watcher.onDidChange(changed);
    this.watcher.onDidCreate(changed);
    this.watcher.onDidDelete(changed);
  }
  private scope(): { folder: vscode.WorkspaceFolder; guard: WorkspaceGuard } {
    if (!vscode.workspace.isTrusted) throw new ContextDenied("Trust this workspace in VS Code before reading context.");
    if (vscode.env.remoteName || !this.selected || this.selected.uri.scheme !== "file" || this.selected.uri.authority) throw new ContextDenied("Choose one opened local workspace folder to read context.");
    if (!vscode.workspace.workspaceFolders?.some((folder) => folder.uri.toString() === this.selected!.uri.toString())) throw new ContextDenied("The selected workspace is no longer open.");
    return { folder: this.selected, guard: new WorkspaceGuard(this.selected.uri.fsPath, (filename) => {
      const open = vscode.workspace.textDocuments.find((document) => document.uri.scheme === "file" && path.relative(document.uri.fsPath, filename) === "" && document.isDirty);
      return open?.getText();
    }) };
  }
  private checked(uri: vscode.Uri, guard: WorkspaceGuard) {
    if (uri.scheme !== "file" || uri.authority) throw new ContextDenied("Only saved local workspace file paths are supported; unsaved edits to those files are supported.");
    return guard.check(uri.fsPath);
  }
  private editor(): vscode.TextEditor {
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!editor || editor.document.isClosed) throw new ContextDenied("Focus an opened workspace file before adding context.");
    return editor;
  }
  approvalScope() {
    const { folder } = this.scope();
    return { root: folder.uri.fsPath, revision: digest(String(this.generation)) };
  }
  snapshot(): ContextState { return structuredClone(this.state); }
  private publish(): void { if (!this.disposed) this.emit(contextStateSchema.parse(this.state)); }
  refreshMetadata(): void {
    if (this.disposed) return;
    this.state.workspaceLabel = this.selected?.name.slice(0, 120) ?? ((vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? "Choose a workspace" : "No folder selected");
    this.state.trusted = vscode.workspace.isTrusted;
    try {
      const { guard } = this.scope(); const editor = this.editor();
      const target = this.checked(editor.document.uri, guard);
      this.state.active = { relativePath: target.relativePath, documentVersion: editor.document.version, dirty: editor.document.isDirty, selectionEmpty: editor.selection.isEmpty, range: rangeDto(editor.selection), diagnosticCount: Math.min(10000, vscode.languages.getDiagnostics(editor.document.uri).length) };
    } catch { this.state.active = null; }
    this.publish();
  }
  invalidate(uri?: vscode.Uri): void {
    if (uri && (uri.scheme !== "file" || !this.selected || vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== this.selected.uri.toString())) return;
    this.generation++;
    const hadItems = this.state.items.length > 0;
    // Rule changes, external filesystem changes and workspace changes invalidate all.
    const isRule = uri && [".gitignore", ".agentignore"].includes(path.basename(uri.fsPath));
    this.state.items = uri && !isRule ? this.state.items.filter((item) => item.documentUri !== uri.toString()) : [];
    this.state.files = []; this.state.matches = []; this.handles.clear();
    this.state.busy = false;
    if (hadItems && this.state.items.length === 0) this.state.notice = "Context changed or closed. Attach again to capture the latest version.";
    this.refreshMetadata();
  }
  private async document(uri: vscode.Uri, guard: WorkspaceGuard): Promise<vscode.TextDocument> {
    const target = this.checked(uri, guard);
    // VS Code can decode binary bytes as text before getText() sees them.
    const file = await open(target.filename, "r");
    try {
      const bytes = Buffer.alloc(target.size + 1);
      const { bytesRead } = await file.read(bytes);
      if (bytesRead > target.size || bytes.subarray(0, bytesRead).includes(0)) throw new ContextDenied("Binary or changing file cannot be captured.");
    } finally { await file.close(); }
    const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === uri.toString() && !item.isClosed) ?? await vscode.workspace.openTextDocument(uri);
    this.checked(uri, guard);
    const text = document.getText();
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES || text.includes("\0")) throw new ContextDenied("File is binary, unsupported, or larger than 256 KiB.");
    if (containsSensitiveText(text)) throw new ContextDenied("Possible credentials detected; this file was not added to context.");
    return document;
  }
  private item(document: vscode.TextDocument, kind: ContextItem["kind"], guard: WorkspaceGuard, selection?: vscode.Selection): ContextItem {
    const { relativePath } = this.checked(document.uri, guard);
    const full = document.getText();
    if (Buffer.byteLength(full, "utf8") > MAX_FILE_BYTES || full.includes("\0") || containsSensitiveText(full)) throw new ContextDenied("Document changed or contains unsupported/sensitive content. Capture a safe excerpt again.");
    let range: vscode.Range = selection ?? new vscode.Range(0, 0, Math.min(document.lineCount, 200), 0);
    range = document.validateRange(range);
    let content = document.getText(range);
    let truncated = false;
    if (kind === "selection" && (range.end.line - range.start.line > 200 || content.length > 16000)) throw new ContextDenied("Selection is too large. Select at most 200 lines and 16,000 characters.");
    if (kind === "file") {
      const original = content;
      content = content.slice(0, 16000);
      truncated = original.length > content.length || document.offsetAt(range.end) < full.length;
      range = new vscode.Range(range.start, document.positionAt(document.offsetAt(range.start) + content.length));
    }
    if (kind === "diagnostics") {
      range = document.validateRange(new vscode.Range(0, 0, document.lineCount, 0));
      const diagnostics = vscode.languages.getDiagnostics(document.uri);
      content = diagnostics.slice(0, 100).map((diagnostic) => {
        const message = containsSensitiveText(diagnostic.message) ? "[Sensitive diagnostic omitted]" : diagnostic.message.slice(0, 500);
        return `L${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${vscode.DiagnosticSeverity[diagnostic.severity]}: ${message}`;
      }).join("\n") || "No diagnostics reported for this document.";
      truncated = diagnostics.length > 100 || content.length > 16000;
      content = content.slice(0, 16000);
    }
    return { id: randomUUID(), kind, relativePath, documentUri: document.uri.toString(), language: document.languageId.slice(0, 100), documentVersion: document.version, dirty: document.isDirty, range: rangeDto(range), sourceBytes: Buffer.byteLength(full, "utf8"), sourceHash: digest(full), excerptHash: digest(content), content, truncated };
  }
  private async candidates(guard: WorkspaceGuard, folder: vscode.WorkspaceFolder) {
    const token = new vscode.CancellationTokenSource(); const timer = setTimeout(() => token.cancel(), 5000);
    try {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), "**/{node_modules,.git,dist,build,out,.venv}/**", 1000, token.token);
      const eligible: Array<{ uri: vscode.Uri; relativePath: string }> = [];
      for (const uri of uris) {
        try { eligible.push({ uri, relativePath: this.checked(uri, guard).relativePath }); } catch { /* filtered */ }
        if (eligible.length >= 100) break;
      }
      eligible.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      return { eligible, truncated: token.token.isCancellationRequested || uris.length >= 1000 || eligible.length >= 100 };
    } finally { clearTimeout(timer); token.dispose(); }
  }
  async execute(action: ContextAction): Promise<void> {
    if (this.disposed) return;
    if (action.type === "context.clear") { this.generation++; this.state.items = []; this.state.notice = null; this.state.busy = false; return this.refreshMetadata(); }
    if (action.type === "context.refresh") return this.refreshMetadata();
    if (action.type === "context.chooseWorkspace") {
      const choices = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file" && !folder.uri.authority).map((folder) => ({ label: folder.name, folder }));
      const choice = await vscode.window.showQuickPick(choices, { title: "Workspace Agent: choose one opened folder" });
      if (this.disposed) return;
      if (choice) { this.selected = choice.folder; this.watch(); this.invalidate(); }
      return;
    }
    if (this.state.busy) return;
    const ticket = this.generation;
    this.state.busy = true; this.state.notice = null; this.publish();
    try {
      const { folder, guard } = this.scope();
      if (action.type === "context.remove") {
        this.state.items = this.state.items.filter((item) => item.id !== action.id);
      } else if (action.type === "context.pickFiles") {
        const selected = await vscode.window.showOpenDialog({
          title: "Attach workspace files to chat", defaultUri: folder.uri, canSelectFiles: true,
          canSelectFolders: false, canSelectMany: true, openLabel: "Attach to chat",
        });
        if (!selected || ticket !== this.generation) return;
        if (selected.length > 6) throw new ContextDenied("Choose up to six files.");
        const items = [...this.state.items];
        for (const uri of selected) {
          const document = await this.document(uri, guard);
          const item = this.item(document, "file", guard);
          const index = items.findIndex((existing) => existing.documentUri === item.documentUri && existing.kind === "file");
          if (index < 0) items.push(item);
          else items[index] = item;
        }
        if (items.length > 6) throw new ContextDenied("Remove an attachment first. Each message supports six excerpts.");
        if (ticket === this.generation) this.state.items = items;
      } else if (action.type === "context.attach" || action.type === "context.read") {
        const editor = action.type === "context.attach" ? this.editor() : undefined;
        const uri = editor?.document.uri ?? (action.type === "context.read" ? this.handles.get(action.documentId) : undefined);
        if (!uri) throw new ContextDenied("That file handle expired. Browse or search again.");
        const document = await this.document(uri, guard);
        const kind = action.type === "context.attach" ? action.source : "file";
        if (kind === "selection" && editor?.selection.isEmpty) throw new ContextDenied("Select some text in the source editor first.");
        const item = this.item(document, kind, guard, kind === "selection" ? editor?.selection : undefined);
        if (kind === "gitDiff") {
          if (document.isDirty) throw new ContextDenied("Save the file before capturing its Git diff.");
          const git = vscode.extensions.getExtension<{ getAPI(version: 1): {
            getRepository(uri: vscode.Uri): { diffWithHEAD(path: string): Promise<string> } | null;
          } }>("vscode.git");
          const repository = (await git?.activate())?.getAPI(1).getRepository(uri);
          if (!repository) throw new ContextDenied("No Git repository available for this file.");
          const diff = await repository.diffWithHEAD(uri.fsPath);
          if (containsSensitiveText(diff)) throw new ContextDenied("Possible credentials detected in the diff.");
          if (!diff) throw new ContextDenied("No tracked changes against HEAD for this file.");
          item.content = diff.slice(0, 16000);
          item.truncated = item.content.length < diff.length;
          item.excerptHash = digest(item.content);
          item.range = rangeDto(document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)));
        }
        if (ticket !== this.generation) return;
        this.state.items = [...this.state.items.filter((old) => !(old.documentUri === item.documentUri && old.kind === item.kind)), item].slice(-6);
        this.state.notice = "Captured locally only. Nothing is sent to a model.";
      } else {
        const { eligible, truncated } = await this.candidates(guard, folder);
        const files: ContextState["files"] = []; const matches: ContextState["matches"] = [];
        const newHandles = new Map<string, vscode.Uri>();
        const deadline = Date.now() + 5000;
        let limited = truncated;
        for (const candidate of eligible) {
          if (ticket !== this.generation) return;
          if (Date.now() > deadline) { limited = true; break; }
          const id = randomUUID(); newHandles.set(id, candidate.uri);
          files.push({ id, relativePath: candidate.relativePath });
          if (action.type === "context.search") {
            try {
              const document = await this.document(candidate.uri, guard);
              for (let line = 0; line < document.lineCount; line++) {
                const text = document.lineAt(line).text;
                if (text.toLowerCase().includes(action.query.toLowerCase())) matches.push({ documentId: id, relativePath: candidate.relativePath, line: line + 1, snippet: text.slice(0, 240) });
                if (matches.length >= 50) { limited = true; break; }
              }
            } catch { /* excluded/unsupported content is not returned */ }
          }
          if (matches.length >= 50) break;
        }
        if (ticket !== this.generation) return;
        this.handles.clear(); newHandles.forEach((uri, id) => this.handles.set(id, uri));
        this.state.files = files; this.state.matches = matches; this.state.truncated = limited;
        this.state.notice = limited ? "Results are bounded (100 files / 50 matches); this is not a complete repository scan." : "Local results only; ignored and secret files are excluded.";
      }
    } catch (error) {
      if (ticket === this.generation) this.state.notice = error instanceof ContextDenied ? error.message : "Context could not be safely read. Refresh and try again.";
    } finally {
      if (ticket === this.generation) { this.state.busy = false; this.refreshMetadata(); }
    }
  }
  dispose(): void { this.generation++; this.disposed = true; this.watcher?.dispose(); this.subscriptions.forEach((subscription) => subscription.dispose()); }
}
