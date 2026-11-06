import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { FixtureRun } from "@local-agent/protocol";
import { SidebarApprovals } from "./approvals";

export function registerFixtureCommand(context: vscode.ExtensionContext, scope: () => { root: string; revision: string }) {
  const output = vscode.window.createOutputChannel("Workspace Agent · Offline run");
  const shown = new Map<string, number>();
  let running = false;
  const command = vscode.commands.registerCommand("localAgent.fixture", async () => {
    if (running) return;
    running = true;
    try {
      const { root } = scope();
      if (!context.storageUri) throw new Error("Open a local workspace first.");
      const stateKey = "fixture-session:" + root;
      const ids = context.workspaceState.get<{ owner: string; workspace: string; session: string }>(stateKey)
        ?? { owner: randomUUID(), workspace: randomUUID(), session: randomUUID() };
      await context.workspaceState.update(stateKey, ids);
      const activeKey = "fixture-run:" + ids.workspace;
      const previous = context.workspaceState.get<string>(activeKey);
      const choice = await vscode.window.showQuickPick([
        ...(previous ? ["Resume last run"] : []), "Explain discount bug", "Fix discount bug", "Block malicious instruction",
      ], { title: "Offline agent · pricing fixture" });
      if (!choice) return;
      const { LocalCheckpointStore } = await import("../../backend/src/local-runtime/storage");
      const { FixtureLoop } = await import("../../backend/src/local-runtime/fixture-loop");
      const store = new LocalCheckpointStore(context.storageUri.fsPath);
      const reviews = new SidebarApprovals(context.globalStorageUri.fsPath, scope);
      try {
        const loop = new FixtureLoop(store, ids);
        const scenario: FixtureRun["scenario"] = choice === "Fix discount bug" ? "fix" : choice === "Explain discount bug" ? "explain" : "injection";
        let cp = choice === "Resume last run" && previous ? loop.load(previous) : loop.start(scenario);
        await context.workspaceState.update(activeKey, cp.runId);
        output.show(true);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Offline fixture", cancellable: true }, async (_, token) => {
          for (;;) {
            const run = cp.state.fixture!;
            const cursor = shown.get(cp.runId) ?? 0;
            if (!cursor) output.appendLine("Run " + cp.runId + " · " + run.scenario);
            for (const event of run.events.slice(cursor)) output.appendLine(event);
            shown.set(cp.runId, run.events.length);
            if (run.stop) return;
            if (token.isCancellationRequested || scope().root !== root) cp = loop.step(cp.runId, "cancel");
            else if (cp.state.status === "awaiting_approval") {
              const argv = ["test", "--", "pricing-fixture", String(run.candidate)];
              const approval = reviews.request(cp.runId, argv);
              const pick = await vscode.window.showQuickPick(["Approve once", "Deny"], {
                title: "Verify pricing fixture in memory", placeHolder: `Proposed discount applications: ${run.candidate}. No shell command runs.`,
              }, token);
              if (!pick && !token.isCancellationRequested) return; // Resume reissues a fresh review.
              if (token.isCancellationRequested) cp = loop.step(cp.runId, "cancel");
              else {
                reviews.decide(approval, pick === "Approve once" ? "approve_once" : "deny");
                cp = loop.step(cp.runId, pick === "Approve once" ? "approved" : "deny");
              }
            } else cp = loop.step(cp.runId);
            await new Promise(resolve => setImmediate(resolve));
          }
        });
      } finally { reviews.dispose(); store.close(); }
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Offline run unavailable."); }
    finally { running = false; }
  });
  context.subscriptions.push(command, output);
}
