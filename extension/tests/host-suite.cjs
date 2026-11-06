const assert = require("node:assert/strict");
const vscode = require("vscode");
exports.run = async () => {
  const extension = vscode.extensions.getExtension("local-labs.local-agent-preview");
  assert.ok(extension);
  const api = await extension.activate();
  assert.equal(api.getMode(), "mock-only");
  await vscode.commands.executeCommand("localAgent.open");
  const deadline = Date.now() + 10000;
  while (!api.getPreviewSummary().bridgeReady && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(api.getPreviewSummary().viewResolved, true);
  assert.equal(api.getPreviewSummary().bridgeReady, true, "The real VS Code webview must load its bundled UI and send its validated ready handshake");
  assert.equal(extension.isActive, true);
  assert.equal(api.getPreviewSummary().providerConnected, false);
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("localAgent.open");
  await vscode.commands.executeCommand("localAgent.resetPreview");
  assert.equal(api.getPreviewSummary().phase, "idle");
  assert.equal(api.getPreviewSummary().messageCount, 0);
  const { WorkspaceContextService } = require("../src/workspace/service");
  const { WorkspaceGuard } = require("../src/workspace/policy");

  const path = require("node:path");
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  const guard = new WorkspaceGuard(root);
  const link = path.join(root, "linked");

  for (const denied of [path.join(root, ".env"), path.join(link, "sample.ts"), path.join(root, "..", "outside")]) {
    assert.throws(() => guard.check(denied));
  }
  const reader = new WorkspaceContextService(() => {});
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "src", "sample.ts"));
    const editor = await vscode.window.showTextDocument(document);
    const git = await vscode.extensions.getExtension("vscode.git").activate();
    const gitApi = git.getAPI(1);
    await gitApi.openRepository(folder.uri);
    await reader.execute({ type: "context.attach", source: "gitDiff" });
    assert.match(reader.snapshot().items[0]?.content ?? reader.snapshot().notice, /\+export const price = 20/);
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "// unsaved-marker\n"));
    editor.selection = new vscode.Selection(0, 3, 0, 17);
    await reader.execute({ type: "context.attach", source: "selection" });
    const selected = reader.snapshot().items.at(-1);
    assert.equal(selected.content, "unsaved-marker");
    assert.equal(selected.dirty, true);
    await reader.execute({ type: "context.search", query: "unsaved-marker" });
    assert.deepEqual(reader.snapshot().matches.map((match) => match.relativePath), ["src/sample.ts"]);
    assert.ok(reader.snapshot().files.every((file) => file.relativePath !== ".env"));
    const binary = reader.snapshot().files.find((file) => file.relativePath === "binary.dat");
    if (binary) {
      await reader.execute({ type: "context.read", documentId: binary.id });
      assert.ok(reader.snapshot().items.every((item) => item.relativePath !== "binary.dat"));
    }
  } finally { reader.dispose(); }
  console.log("Extension host PASS: activation, sidebar command, close/reopen, reset, mock-only state.");
};
