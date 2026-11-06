import { z } from "zod";

const id = z.uuid();
export const contextActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("context.pickFiles") }).strict(),
  z.object({ type: z.literal("context.remove"), id }).strict(),
  z.object({ type: z.literal("context.refresh") }).strict(),
  z.object({ type: z.literal("context.chooseWorkspace") }).strict(),
  z.object({ type: z.literal("context.attach"), source: z.enum(["file", "selection", "diagnostics", "gitDiff"]) }).strict(),
  z.object({ type: z.literal("context.list") }).strict(),
  z.object({ type: z.literal("context.search"), query: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal("context.read"), documentId: id }).strict(),
  z.object({ type: z.literal("context.clear") }).strict(),
]);
export const contextIntentSchema = z.object({
  protocolVersion: z.literal(1), requestId: id, viewId: id, action: contextActionSchema,
}).strict();

const range = z.object({ startLine: z.number().int().positive(), startCharacter: z.number().int().nonnegative(), endLine: z.number().int().positive(), endCharacter: z.number().int().nonnegative() }).strict();
export const contextItemSchema = z.object({
  id, kind: z.enum(["file", "selection", "diagnostics", "gitDiff"]), relativePath: z.string().max(1024),
  documentUri: z.string().max(4096).startsWith("file:"), language: z.string().max(100),
  documentVersion: z.number().int().nonnegative(), dirty: z.boolean(), range,
  sourceBytes: z.number().int().nonnegative(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), excerptHash: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().max(16000), truncated: z.boolean(),
}).strict();
export const contextStateSchema = z.object({
  workspaceLabel: z.string().max(120), trusted: z.boolean(), busy: z.boolean(),
  active: z.object({ relativePath: z.string().max(1024), documentVersion: z.number().int().nonnegative(), dirty: z.boolean(), selectionEmpty: z.boolean(), range, diagnosticCount: z.number().int().nonnegative().max(10000) }).strict().nullable(),
  items: z.array(contextItemSchema).max(6),
  files: z.array(z.object({ id, relativePath: z.string().max(1024) }).strict()).max(100),
  matches: z.array(z.object({ documentId: id, relativePath: z.string().max(1024), line: z.number().int().positive(), snippet: z.string().max(240) }).strict()).max(50),
  truncated: z.boolean(), notice: z.string().max(400).nullable(),
}).strict();
export const contextHostMessageSchema = z.object({ protocolVersion: z.literal(1), type: z.literal("workspace.context"), viewId: id, state: contextStateSchema }).strict();
export type ContextAction = z.infer<typeof contextActionSchema>;
export type ContextState = z.infer<typeof contextStateSchema>;
export type ContextItem = z.infer<typeof contextItemSchema>;
