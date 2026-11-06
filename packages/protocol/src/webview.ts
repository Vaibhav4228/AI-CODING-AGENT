import { z } from "zod";

const id = z.uuid();
const message = z.object({ id, role: z.enum(["user", "assistant"]), content: z.string().max(8000), attachments: z.array(z.string().max(1024)).max(6).optional() }).strict();
const activity = z.object({ id, title: z.string().max(160), detail: z.string().max(1000), status: z.enum(["running", "completed", "failed", "cancelled"]) }).strict();
export const previewStateSchema = z.object({
  viewId: id, runId: id.nullable(),
  phase: z.enum(["idle", "running", "awaiting_approval", "completed", "cancelled", "failed"]),
  workspaceLabel: z.string().max(120), trusted: z.boolean(),
  providerLabel: z.literal("DeepSeek R1"), providerConnected: z.literal(false),
  messages: z.array(message).max(24), activities: z.array(activity).max(12),
  approval: z.object({ id, runId: id, title: z.string().max(160), description: z.string().max(1000) }).strict().nullable(),
  alert: z.string().max(400).nullable(),
}).strict();

const base = { protocolVersion: z.literal(1), requestId: id };
export const uiIntentSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("ui.ready") }).strict(),
  z.object({ ...base, type: z.literal("demo.start"), viewId: id, prompt: z.string().trim().min(1).max(4000), scenario: z.enum(["plan", "approval", "failure"]) }).strict(),
  z.object({ ...base, type: z.literal("demo.cancel"), viewId: id, runId: id }).strict(),
  z.object({ ...base, type: z.literal("demo.decide"), viewId: id, runId: id, approvalId: id, decision: z.enum(["approve_once", "deny"]) }).strict(),
  z.object({ ...base, type: z.literal("demo.reset"), viewId: id }).strict(),
]);
export const hostMessageSchema = z.object({ protocolVersion: z.literal(1), type: z.literal("preview.state"), state: previewStateSchema }).strict();
export const draftSchema = z.object({ draft: z.string().max(4000), scenario: z.enum(["plan", "approval", "failure"]) }).strict();
export type PreviewState = z.infer<typeof previewStateSchema>;
export type UiIntent = z.infer<typeof uiIntentSchema>;
export type Draft = z.infer<typeof draftSchema>;
