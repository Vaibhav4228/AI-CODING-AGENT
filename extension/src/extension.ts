import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { DemoController } from "./demo";
import { renderHtml } from "./html";

export function activate(context: vscode.ExtensionContext) {
  let currentView: vscode.WebviewView | undefined;
  const controller = new DemoController(
    (message) => { void currentView?.webview.postMessage(message); },
    vscode.workspace.workspaceFolders?.[0]?.name ?? "No folder selected",
    vscode.workspace.isTrusted,
  );
  context.subscriptions.push({ dispose: () => controller.dispose() });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("localAgent.sidebar", {
    resolveWebviewView(view) {
      currentView = view;
      const media = vscode.Uri.joinPath(context.extensionUri, "media");
      view.webview.options = { enableScripts: true, localResourceRoots: [media] };
      view.webview.html = renderHtml({
        nonce: randomBytes(24).toString("base64"), cspSource: view.webview.cspSource,
        scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "index.js")).toString(),
        styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "index.css")).toString(),
      });
      const listener = view.webview.onDidReceiveMessage((message: unknown) => controller.receive(message));
      view.onDidDispose(() => { listener.dispose(); if (currentView === view) currentView = undefined; });
    },
  }));
  context.subscriptions.push(vscode.commands.registerCommand("localAgent.open", () => vscode.commands.executeCommand("workbench.view.extension.localAgent")));
  context.subscriptions.push(vscode.commands.registerCommand("localAgent.resetPreview", () => controller.reset()));
  // Read-only diagnostics for extension-host integration tests; no prompts or secrets.
  return { getMode: () => "mock-only", getPreviewSummary: () => ({ phase: controller.snapshot().phase, providerConnected: false, messageCount: controller.snapshot().messages.length }) };
}
