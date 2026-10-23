import { randomUUID } from "node:crypto";
import { hostMessageSchema, PreviewState, uiIntentSchema } from "@local-agent/protocol";

export interface Scheduler { later(callback: () => void, milliseconds: number): () => void }
const scheduler: Scheduler = { later: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } };

export class DemoController {
  private state: PreviewState;
  private readonly timers: Array<() => void> = [];
  private readonly seen = new Set<string>();
  private disposed = false;
  constructor(private readonly emit: (message: unknown) => void, workspaceLabel = "No folder selected", trusted = false, private readonly clock = scheduler) {
    this.state = { viewId: randomUUID(), runId: null, phase: "idle", workspaceLabel: workspaceLabel.slice(0, 120), trusted, providerLabel: "DeepSeek R1", providerConnected: false, messages: [], activities: [], approval: null, alert: null };
  }
  snapshot(): PreviewState { return structuredClone(this.state); }
  private publish(): void { if (!this.disposed) this.emit(hostMessageSchema.parse({ protocolVersion: 1, type: "preview.state", state: this.state })); }
  private clearTimers(): void { this.timers.splice(0).forEach((cancel) => cancel()); }
  private fail(message: string): void { this.state.alert = message; this.publish(); }
  private finish(content: string): void {
    this.state.phase = "completed";
    this.state.approval = null;
    this.state.activities = this.state.activities.map((item) => ({ ...item, status: "completed" }));
    this.state.messages.push({ id: randomUUID(), role: "assistant", content });
    this.publish();
  }
  receive(raw: unknown): void {
    if (this.disposed) return;
    try { if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 20000) return this.fail("Message rejected: invalid preview request."); } catch { return this.fail("Message rejected: invalid preview request."); }
    const parsed = uiIntentSchema.safeParse(raw);
    if (!parsed.success) return this.fail("Message rejected: invalid preview request.");
    const intent = parsed.data;
    if (intent.type !== "ui.ready" && intent.viewId !== this.state.viewId) return this.fail("Message rejected: this preview session has changed.");
    if (this.seen.has(intent.requestId)) return;
    if (this.seen.size >= 2000) return this.fail("Preview request limit reached. Reopen the extension to continue.");
    this.seen.add(intent.requestId);
    if (intent.type === "ui.ready") return this.publish();
    if (intent.type === "demo.reset") return this.reset();
    if (intent.type === "demo.cancel") {
      if (intent.runId !== this.state.runId || !["running", "awaiting_approval"].includes(this.state.phase)) return this.fail("That demo is no longer active.");
      this.clearTimers(); this.state.phase = "cancelled"; this.state.approval = null;
      this.state.activities = this.state.activities.map((item) => item.status === "running" ? { ...item, status: "cancelled" } : item);
      this.state.alert = "Demo stopped. No files or commands were affected."; return this.publish();
    }
    if (intent.type === "demo.decide") {
      if (this.state.phase !== "awaiting_approval" || intent.runId !== this.state.runId || intent.approvalId !== this.state.approval?.id) return this.fail("Approval rejected: the demo action is stale.");
      if (intent.decision === "deny") {
        this.state.phase = "cancelled"; this.state.approval = null;
        this.state.activities = this.state.activities.map((item) => ({ ...item, status: "cancelled" }));
        this.state.alert = "Demo action denied. Nothing was executed."; return this.publish();
      }
      return this.finish("Demo approval accepted. In the real workflow, the exact patch would be revalidated before applying. This preview did not modify any file.");
    }
    if (["running", "awaiting_approval"].includes(this.state.phase)) return this.fail("Stop the current demo before starting another.");
    this.clearTimers();
    this.state = { ...this.state, runId: randomUUID(), phase: "running", alert: null, approval: null, messages: [{ id: randomUUID(), role: "user", content: intent.prompt }], activities: [{ id: randomUUID(), title: "Build a small, verifiable plan", detail: "Simulated activity · no repository content is being read", status: "running" }] };
    this.publish();
    const runId = this.state.runId;
    this.timers.push(this.clock.later(() => {
      if (this.disposed || this.state.runId !== runId || this.state.phase !== "running") return;
      if (intent.scenario === "failure") {
        this.state.phase = "failed";
        this.state.activities[0].status = "failed";
        this.state.alert = "Simulated provider unavailable. Your work is unchanged; no network request was made.";
        return this.publish();
      }
      if (intent.scenario === "approval") {
        this.state.phase = "awaiting_approval";
        this.state.approval = { id: randomUUID(), runId: runId!, title: "Review a proposed patch", description: "Demo only: propose a change to fixture.ts. Approving updates this preview; it grants no filesystem or terminal access." };
        return this.publish();
      }
      this.finish("Here’s the workflow we’re building:\n\n1. Read only relevant files from your opened workspace.\n2. Propose a focused patch for review.\n3. Verify it in an isolated environment.\n4. Apply the reviewed result without overwriting your edits.\n\nThis is a scripted preview, not a DeepSeek response. Workspace tools arrive in Step 3.");
    }, 700));
  }
  reset(): void {
    this.clearTimers();
    this.state = { ...this.state, runId: null, phase: "idle", messages: [], activities: [], approval: null, alert: null };
    this.publish();
  }
  dispose(): void { this.clearTimers(); this.disposed = true; }
}
