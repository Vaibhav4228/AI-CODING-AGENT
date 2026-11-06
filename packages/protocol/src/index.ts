import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const idSchema = z.uuid();
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

// Small, versioned state spike; not a LangGraph checkpoint implementation.
export const checkpointStateSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(["created", "planning", "awaiting_approval", "completed", "cancelled", "failed"]),
  summary: z.string().max(8000),
  nextStep: z.string().max(1000).nullable(),
}).strict();

export const checkpointSchema = z.object({
  runId: idSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: checkpointStateSchema,
}).strict();

export const contextRequestSchema = z.object({
  documentUri: z.string().max(4096).startsWith("file:"),
  documentVersion: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict().refine((value) => value.endLine >= value.startLine);

export const patchSchema = z.object({
  patchId: idSchema, documentUri: z.string().max(4096).startsWith("file:"),
  expectedDocumentVersion: z.number().int().nonnegative(),
  expectedContentHash: digestSchema, unifiedDiff: z.string().max(64 * 1024),
}).strict();

export const approvalSchema = z.object({
  approvalId: idSchema, runId: idSchema, workspaceId: idSchema,
  argumentHash: digestSchema, policyVersion: z.literal(1),
  expiresAt: z.iso.datetime(), decision: z.enum(["approve_once", "deny"]),
}).strict();

// Only the trusted host supplies the current workspace revision and tool arguments.
export const actionSchema = z.discriminatedUnion("capability", [
  z.object({ capability: z.literal("workspace.edit"), patch: patchSchema }).strict(),
  z.object({ capability: z.literal("sandbox.execute"), executable: z.string().min(1).max(512),
    argv: z.array(z.string().max(4096)).max(128), cwd: z.string().min(1).max(1024) }).strict(),
]);
const reviewRequest = z.object({ runId: idSchema, workspaceRevision: digestSchema, action: actionSchema }).strict();

export const callSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("runtime.health"), params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("runtime.shutdown"), params: z.object({}).strict() }).strict(),
  z.object({ method: z.literal("checkpoint.load"), params: z.object({ runId: idSchema }).strict() }).strict(),
  z.object({ method: z.literal("checkpoint.save"), params: z.object({
    runId: idSchema, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
    state: checkpointStateSchema,
  }).strict() }).strict(),
  z.object({ method: z.literal("context.request"), params: contextRequestSchema }).strict(),
  z.object({ method: z.literal("patch.propose"), params: patchSchema }).strict(),
  z.object({ method: z.literal("approval.request"), params: reviewRequest }).strict(),
  z.object({ method: z.literal("approval.consume"), params: reviewRequest.extend({ approvalId: idSchema }) }).strict(),
  z.object({ method: z.literal("approval.decide"), params: approvalSchema }).strict(),
]);

export const requestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION), requestId: idSchema,
  sessionId: idSchema, token: digestSchema, workspaceId: idSchema.optional(), call: callSchema,
}).strict();

export const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("review"), approval: approvalSchema.omit({ decision: true }) }).strict(),
  z.object({ kind: z.literal("approvalState"), status: z.enum(["approved","denied","consumed"]) }).strict(),
  z.object({ kind: z.literal("health"), mode: z.literal("boundary-only"), storage: z.literal("sqlite") }).strict(),
  z.object({ kind: z.literal("checkpoint"), checkpoint: checkpointSchema.nullable() }).strict(),
  z.object({ kind: z.literal("shutdown") }).strict(),
]);

export const errorCodeSchema = z.enum(["INVALID_REQUEST", "UNAUTHORIZED", "WORKSPACE_DENIED", "CONFLICT", "NOT_IMPLEMENTED", "APPROVAL_DENIED", "REPLAY", "INTERNAL"]);
export const responseSchema = z.discriminatedUnion("ok", [
  z.object({ protocolVersion: z.literal(1), requestId: idSchema.nullable(), ok: z.literal(true), result: resultSchema }).strict(),
  z.object({ protocolVersion: z.literal(1), requestId: idSchema.nullable(), ok: z.literal(false), error: z.object({ code: errorCodeSchema }).strict() }).strict(),
]);

// Future event surface only: no event stream/agent execution in Step 1.
export const eventSchema = z.object({
  protocolVersion: z.literal(1), eventId: idSchema, runId: idSchema,
  seq: z.number().int().positive(), timestamp: z.iso.datetime(),
  type: z.enum(["run.created", "run.completed", "run.failed", "run.cancelled"]),
}).strict();

export type Call = z.infer<typeof callSchema>;
export type Request = z.infer<typeof requestSchema>;
export type Response = z.infer<typeof responseSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type CheckpointState = z.infer<typeof checkpointStateSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export * from './webview';

export * from './workspace';
