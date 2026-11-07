import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const idSchema = z.uuid();
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const fixtureScenario = z.enum(["explain", "fix", "injection"]);
export const fixtureStop = z.enum(["verified", "invalid_tool", "unverified", "budget", "cancelled", "denied", "provider_error"]);
const fixtureRun = z.object({
  session: idSchema, scenario: fixtureScenario, started: z.number(), tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(), repairs: z.number().int().nonnegative(), candidate: z.number().nullable(),
  evidence: z.string().nullable(), stop: fixtureStop.nullable(), events: z.array(z.string().max(300)).max(64),
}).strict();
export type FixtureRun = z.infer<typeof fixtureRun>;
// Small, versioned state spike; not a LangGraph checkpoint implementation.
export const checkpointStateSchema = z.object({
  fixture: fixtureRun.optional(),
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


// Live chat bridge: the host owns transcripts, credentials and run identities.
export const liveProviderSchema = z.enum(["DeepSeek", "OpenRouter"]);
export const liveModeSchema = z.enum(["Ask", "Plan", "Implement"]);
export const liveTurnSchema = z.object({
  id: idSchema, runId:idSchema.optional(), role: z.enum(["user", "assistant"]), text: z.string().max(64000),
  mode: liveModeSchema.optional(), provider: liveProviderSchema.optional(),
  usage: z.object({input:z.number().int().nonnegative(),output:z.number().int().nonnegative()}).optional(),
  sources: z.array(z.object({path:z.string().max(1024),line:z.number().int().positive(),excerpt:z.string().max(16000)})).max(100).optional(),
  undoId: z.string().max(128).optional(), rejected:z.boolean().optional(),
}).strict();
export const liveSessionSchema = z.object({
  id:idSchema,title:z.string().max(120),revision:z.number().int().nonnegative(),updated:z.number(),
  turns:z.array(liveTurnSchema).max(100),historyOmitted:z.boolean().optional(),
  pending:z.object({requestId:idSchema,runId:idSchema}).nullable(),
  status:z.enum(["idle","running","completed","cancelled","failed","interrupted"]),
}).strict();
const liveBase = {viewId:idSchema};
export const liveIntentSchema = z.discriminatedUnion("type",[
  z.object({...liveBase,type:z.literal("live.init")}).strict(),
  z.object({...liveBase,type:z.literal("live.ask"),sessionId:idSchema,revision:z.number().int().nonnegative(),requestId:idSchema,prompt:z.string().trim().min(1).max(4000),provider:liveProviderSchema,mode:liveModeSchema}).strict(),
  z.object({...liveBase,type:z.literal("live.session"),action:z.enum(["new","open","rename","delete"]),sessionId:idSchema.optional()}).strict(),
  z.object({...liveBase,type:z.literal("live.key"),provider:liveProviderSchema,action:z.enum(["set","remove","environment","model"])}).strict(),
  z.object({...liveBase,type:z.literal("live.cancel"),sessionId:idSchema,runId:idSchema}).strict(),
  z.object({...liveBase,type:z.literal("live.source"),path:z.string().max(1024),line:z.number().int().positive()}).strict(),
  z.object({...liveBase,type:z.literal("live.undo"),id:z.string().max(128)}).strict(),
  z.object({...liveBase,type:z.literal("live.sandbox")}).strict(),
]);
export const liveStateSchema = z.object({
  type:z.literal("live.state"),viewId:idSchema,scopeId:z.string(),session:liveSessionSchema,
  history:z.array(z.object({id:idSchema,title:z.string(),updated:z.number()})).max(20),
  providers:z.array(z.object({provider:liveProviderSchema,model:z.string(),source:z.enum(["saved","environment","missing","disabled"])})).max(2),
  notice:z.string(),
}).strict();
export type LiveTurn = z.infer<typeof liveTurnSchema>;
export type LiveSession = z.infer<typeof liveSessionSchema>;
export type LiveState = z.infer<typeof liveStateSchema>;
export type LiveProvider = z.infer<typeof liveProviderSchema>;
