import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ErrorCode, idSchema, MAX_MESSAGE_BYTES, requestSchema, Response, responseSchema } from "@local-agent/protocol";
import { ApprovalDenied, LocalCheckpointStore, RevisionConflict } from "./storage";

export interface WorkspaceGrant { workspaceId: string; root: string; trusted: boolean }
export interface BoundaryOptions { ownerId: string; sessionId: string; token: string; storageDirectory: string; workspaces: WorkspaceGrant[] }

/** Private parent-process API. Never expose BoundaryOptions to a webview/model. */
export class RuntimeBoundary {
  private readonly grants = new Map<string, WorkspaceGrant>();
  private readonly seen = new Set<string>();
  private readonly store: LocalCheckpointStore;
  private readonly options: BoundaryOptions;

  constructor(options: BoundaryOptions) {
    this.options = { ...options, workspaces: [] };
    idSchema.parse(options.ownerId);
    idSchema.parse(options.sessionId);
    if (!/^[a-f0-9]{64}$/.test(options.token)) throw new Error("Invalid launch credential");
    if (options.workspaces.length > 32) throw new Error("Too many workspace grants");
    for (const grant of options.workspaces) {
      idSchema.parse(grant.workspaceId);
      if (typeof grant.trusted !== "boolean" || !path.isAbsolute(grant.root) || this.grants.has(grant.workspaceId)) throw new Error("Invalid workspace grant");
      const root = realpathSync(grant.root);
      if (!statSync(root).isDirectory()) throw new Error("Workspace must be a directory");
      this.grants.set(grant.workspaceId, { ...grant, root });
    }
    if (!path.isAbsolute(options.storageDirectory)) throw new Error("Storage requires an absolute directory");
    // Canonicalize the nearest existing ancestor before creating any directory.
    let ancestor = options.storageDirectory;
    const suffix: string[] = [];
    while (!existsSync(ancestor)) {
      suffix.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("Invalid storage directory");
      ancestor = parent;
    }
    const storageRoot = path.join(realpathSync(ancestor), ...suffix);
    for (const grant of this.grants.values()) {
      const relative = path.relative(grant.root, storageRoot);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Storage must be outside workspace");
    }
    this.store = new LocalCheckpointStore(options.storageDirectory);
  }

  handle(input: unknown): Response {
    let requestId: string | null = null;
    const fail = (code: ErrorCode): Response => ({ protocolVersion: 1, requestId, ok: false, error: { code } });
    let encoded: string;
    try { encoded = JSON.stringify(input); } catch { return fail("INVALID_REQUEST"); }
    if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_MESSAGE_BYTES) return fail("INVALID_REQUEST");
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return fail("INVALID_REQUEST");
    const request = parsed.data;
    requestId = request.requestId;
    if (request.sessionId !== this.options.sessionId || !timingSafeEqual(Buffer.from(request.token, "hex"), Buffer.from(this.options.token, "hex"))) return fail("UNAUTHORIZED");
    if (this.seen.has(requestId)) return fail("REPLAY");
    // Bounded session lifetime; caller must launch a new session at this limit.
    if (this.seen.size >= 10000) return fail("UNAUTHORIZED");
    this.seen.add(requestId);
    const call = request.call;
    if (call.method === "runtime.health") return responseSchema.parse({ protocolVersion: 1, requestId, ok: true, result: { kind: "health", mode: "boundary-only", storage: "sqlite" } });
    if (call.method === "runtime.shutdown") return { protocolVersion: 1, requestId, ok: true, result: { kind: "shutdown" } };
    const grant = request.workspaceId ? this.grants.get(request.workspaceId) : undefined;
    if (!grant || !grant.trusted) return fail("WORKSPACE_DENIED");
    try {
      if (call.method === "checkpoint.load" || call.method === "checkpoint.save") {
        const checkpoint = call.method === "checkpoint.load"
          ? this.store.load(this.options.ownerId, grant.workspaceId, call.params.runId)
          : this.store.save(this.options.ownerId, grant.workspaceId, call.params.runId, call.params.expectedRevision, call.params.state);
        return responseSchema.parse({ protocolVersion: 1, requestId, ok: true, result: { kind: "checkpoint", checkpoint } });
      }
      if (call.method === "approval.request" || call.method === "approval.consume" || call.method === "approval.decide") {
        const scope = { owner: this.options.ownerId, session: this.options.sessionId, workspace: grant.workspaceId, run: call.params.runId };
        if (call.method === "approval.decide") {
          const review = call.params;
          if (review.workspaceId !== grant.workspaceId) return fail("APPROVAL_DENIED");
          const status = review.decision === "deny" ? "denied" : "approved";
          this.store.transitionApproval(scope, review.approvalId, review.argumentHash, status, Date.parse(review.expiresAt));
          return { protocolVersion: 1, requestId, ok: true, result: { kind: "approvalState", status } };
        }
        // Parsed strict schemas provide stable object field order; preserve argv order and exact patch text.
        const hash = createHash("sha256").update(JSON.stringify([grant.root, call.params.workspaceRevision, call.params.action])).digest("hex");
        if (call.method === "approval.request") {
          return { protocolVersion: 1, requestId, ok: true, result: { kind: "review", approval: this.store.requestApproval(scope, hash) } };
        }
        this.store.transitionApproval(scope, call.params.approvalId, hash, "consumed");
        return { protocolVersion: 1, requestId, ok: true, result: { kind: "approvalState", status: "consumed" } };
      }
      return fail("NOT_IMPLEMENTED");
    } catch (error) {
      if (error instanceof ApprovalDenied) return fail("APPROVAL_DENIED");
      return fail(error instanceof RevisionConflict ? "CONFLICT" : "INTERNAL");
    }
  }

  close(): void { this.store.close(); }
}
