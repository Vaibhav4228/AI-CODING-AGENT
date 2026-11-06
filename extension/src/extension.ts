import { liveChat } from "./live";
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { DemoController } from "./demo";
import { renderHtml } from "./html";
import { registerFixtureCommand } from "./fixture-command";
import { SidebarApprovals } from "./approvals";
import { WorkspaceContextService } from "./workspace/service";
import { contextIntentSchema, uiIntentSchema } from "@local-agent/protocol";

export function activate(context: vscode.ExtensionContext) {
  let currentView: vscode.WebviewView | undefined;
  let bridgeReady = false;
  const approvals = new SidebarApprovals(context.globalStorageUri.fsPath, () => workspace.approvalScope());
  const controller = new DemoController(
    (message) => { void currentView?.webview.postMessage(message); },
    vscode.workspace.workspaceFolders?.[0]?.name ?? "No folder selected",
    vscode.workspace.isTrusted, undefined, approvals,
  );
  const workspace = new WorkspaceContextService((state) => {
    if (currentView && bridgeReady) void currentView.webview.postMessage({
      protocolVersion: 1, type: "workspace.context", viewId: controller.snapshot().viewId, state,
    });
  });
  context.subscriptions.push(workspace, approvals);
  registerFixtureCommand(context, () => workspace.approvalScope());
  context.subscriptions.push({ dispose: () => controller.dispose() });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("localAgent.sidebar", {
    resolveWebviewView(view) {
      currentView = view;
      bridgeReady = false;
      const media = vscode.Uri.joinPath(context.extensionUri, "media");
      view.webview.options = { enableScripts: true, localResourceRoots: [media] };
      view.webview.html = renderHtml({
        nonce: randomBytes(24).toString("base64"), cspSource: view.webview.cspSource,
        scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "index.js")).toString(),
        styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "index.css")).toString(),
      });
      const live = liveChat(context, workspace, view, () => controller.snapshot().viewId);
      const listener = view.webview.onDidReceiveMessage((message: unknown) => {
        if (view !== currentView) return;
        if (bridgeReady && live.receive(message)) return;
        const intent = contextIntentSchema.safeParse(message);
        if (intent.success) {
          if (bridgeReady && intent.data.viewId === controller.snapshot().viewId) void workspace.execute(intent.data.action);
          return;
        }
        const parsed = uiIntentSchema.safeParse(message);
        if (parsed.success && parsed.data.type === "ui.ready") bridgeReady = true;
        if (parsed.success && parsed.data.type === "demo.start") {
          const previousRun = controller.snapshot().runId;
          const files = workspace.snapshot().items.map((item) => item.relativePath);
          controller.receive(message, files);
          if (files.length && previousRun !== controller.snapshot().runId) void workspace.execute({ type: "context.clear" });
        } else controller.receive(message);
        if (parsed.success && parsed.data.type === "ui.ready") workspace.refreshMetadata();
      });
      view.onDidDispose(() => { live.dispose(); listener.dispose(); if (currentView === view) currentView = undefined; });
    },
  }));
  context.subscriptions.push(vscode.commands.registerCommand("localAgent.open", () => vscode.commands.executeCommand("workbench.view.extension.localAgent")));
  context.subscriptions.push(vscode.commands.registerCommand("localAgent.resetPreview", () => controller.reset()));
  // Read-only diagnostics for extension-host integration tests; no prompts or secrets.
  return { getMode: () => "mock-only", getPreviewSummary: () => ({ phase: controller.snapshot().phase, providerConnected: false, messageCount: controller.snapshot().messages.length, viewResolved: !!currentView, bridgeReady }) };
}
