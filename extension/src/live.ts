import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import path from "node:path";
import { askDeepSeek, MODEL, prepareQuestion } from "./deepseek";
import type { WorkspaceContextService } from "./workspace/service";

export function liveChat(context: vscode.ExtensionContext, workspace: WorkspaceContextService, view: vscode.WebviewView, viewId: () => string) {
  let active: AbortController | undefined;
  const stop = () => active?.abort();
  async function run(prompt: string, id: string, provider: "DeepSeek" | "OpenRouter") {
    if (active) return;
    const current = new AbortController();
    active = current;
    const post = (text: string, busy = false) => view.webview.postMessage({type:"live.result", viewId:id, text, busy});
    try {
      await post("Preparing request…", true);
      
      const items = workspace.snapshot().items;
      const scope = items.length ? workspace.approvalScope() : undefined;
      const question = prepareQuestion(prompt, items);
      const config = context.extensionMode === vscode.ExtensionMode.Development
        ? parseEnv(await readFile(path.resolve(context.extensionPath, "../.env"), "utf8").catch(() => "")) : {};
      const secretName = provider.toLowerCase() + ".key";
      const model = provider === "DeepSeek" ? config.DEEPSEEK_MODEL || MODEL : config.OPENROUTER_MODEL || "openrouter/free";
      let key = await context.secrets.get(secretName) || config[provider === "DeepSeek" ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY"];
      if (!key) {
        key = await vscode.window.showInputBox({password:true,ignoreFocusOut:true,prompt:provider + " API key (saved in VS Code SecretStorage)"});
        if (!key?.trim()) throw Error(provider + " key required.");
        await context.secrets.store(secretName, key.trim());
      }
      if (scope) {
        const ok = await vscode.window.showInformationMessage("Send this question and selected excerpts to " + provider + "?", {modal:true, detail:model + "\n" + prompt + "\n\n" + question.sources.map(s => s.path + " from line " + s.startLine).join("\n") + "\nMaximum output: 2,048 tokens."}, "Send once");
        if (!ok || current.signal.aborted) throw Error("Cancelled.");
        const now = workspace.approvalScope();
        if (now.root !== scope.root || now.revision !== scope.revision || JSON.stringify(workspace.snapshot().items) !== JSON.stringify(items)) throw Error("Context changed. Review your attachments and retry.");
      }
      if (current.signal.aborted) throw Error("Cancelled.");
      await post("Waiting for " + provider + "…", true);
      const text = await askDeepSeek(key.trim(), question, AbortSignal.any([current.signal,AbortSignal.timeout(90000)]), provider, model);
      await post(current.signal.aborted ? "Cancelled." : text);
    } catch (e) {
      await post(current.signal.aborted ? "Cancelled." : e instanceof SyntaxError ? "Invalid provider response." : e instanceof Error ? e.message : "Provider request failed.");
    } finally { active = undefined; }
  }
  return {dispose:stop, receive(raw:unknown) {
    if (!raw || typeof raw !== "object" || !("viewId" in raw) || raw.viewId !== viewId() || !("type" in raw)) return false;
    if (raw.type === "live.cancel") { stop(); return true; }
    if (raw.type !== "live.ask") return false;
    if ("prompt" in raw && typeof raw.prompt === "string") void run(raw.prompt, raw.viewId, "provider" in raw && raw.provider === "OpenRouter" ? "OpenRouter" : "DeepSeek");
    return true;
  }};
}
