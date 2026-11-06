import { randomBytes, randomUUID } from "node:crypto";
import type { Call, Response } from "@local-agent/protocol";
import type { RuntimeBoundary } from "../../backend/src/local-runtime/boundary";

type Review = Extract<Extract<Response, {ok: true}>["result"], {kind: "review"}>["approval"];
type Scope = { root: string; revision: string };

// The host owns all action arguments. The webview can only decide an existing review.
export class SidebarApprovals {
  private runtime?: RuntimeBoundary;
  private root?: string;
  private readonly ownerId = randomUUID();
  private readonly sessionId = randomUUID();
  private readonly token = randomBytes(32).toString("hex");
  private workspaceId = randomUUID();
  private pending?: Review;
  private argsToReview: string[] = [];

  constructor(private directory: string, private scope: () => Scope) {}

  private call(call: Call) {
    const result = this.runtime?.handle({ protocolVersion: 1, requestId: randomUUID(),
      sessionId: this.sessionId, token: this.token, workspaceId: this.workspaceId, call });
    if (!result?.ok) throw new Error("Review is unavailable or expired.");
    return result.result;
  }

  private args(runId: string, scope: Scope) {
    return { runId, workspaceRevision: scope.revision, action: {
      capability: "sandbox.execute" as const, executable: "npm", argv: this.argsToReview, cwd: ".",
    } };
  }

  request(runId: string, argv = ["test"]) {
    this.argsToReview = [...argv];
    const scope = this.scope();
    if (scope.root !== this.root || !this.runtime) {
      this.dispose();
      // Load SQLite only for approval-capable runs.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- older hosts must still open read-only chat without SQLite
      const { RuntimeBoundary: Boundary } = require("../../backend/src/local-runtime/boundary") as typeof import("../../backend/src/local-runtime/boundary");
      this.workspaceId = randomUUID();
      this.runtime = new Boundary({ ownerId: this.ownerId, sessionId: this.sessionId, token: this.token,
        storageDirectory: this.directory, workspaces: [{ workspaceId: this.workspaceId, root: scope.root, trusted: true }] });
      this.root = scope.root;
    }
    const result = this.call({ method: "approval.request", params: this.args(runId, scope) });
    if (result.kind !== "review") throw new Error("Review unavailable.");
    this.pending = result.approval;
    return this.pending.approvalId;
  }

  decide(id: string, decision: "deny" | "approve_once") {
    const scope = this.scope();
    const review = this.pending;
    if (!review || scope.root !== this.root || id !== review.approvalId) throw new Error("Stale review.");
    this.pending = undefined;
    this.call({ method: "approval.decide", params: { ...review, decision } });
    if (decision === "approve_once") this.call({ method: "approval.consume",
      params: { ...this.args(review.runId, scope), approvalId: id } });
  }

  dispose() { this.runtime?.close(); this.runtime = undefined; this.pending = undefined; }
}
