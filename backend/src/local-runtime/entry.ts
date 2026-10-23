import { z } from "zod";
import { digestSchema, idSchema, MAX_MESSAGE_BYTES } from "@local-agent/protocol";
import { RuntimeBoundary } from "./boundary";

const bootstrapSchema = z.object({
  type: z.literal("bootstrap"), ownerId: idSchema, sessionId: idSchema, token: digestSchema,
  storageDirectory: z.string().min(1).max(4096),
  workspaces: z.array(z.object({ workspaceId: idSchema, root: z.string().min(1).max(4096), trusted: z.boolean() }).strict()).max(32),
}).strict();

// This is not a standalone CLI. Only the launcher owns this private IPC channel.
if (!process.send || !process.connected) process.exit(1);
let boundary: RuntimeBoundary | undefined;
let bootstrapped = false;
const bootstrapTimer = setTimeout(() => process.exit(1), 5000);

process.on("disconnect", () => {
  boundary?.close();
  process.exit(0);
});

process.on("message", (message: unknown) => {
  if (!bootstrapped) {
    bootstrapped = true;
    clearTimeout(bootstrapTimer);
    try {
      if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_MESSAGE_BYTES) throw new Error();
      const config = bootstrapSchema.parse(message);
      boundary = new RuntimeBoundary(config);
      process.send?.({ type: "ready", protocolVersion: 1, sessionId: config.sessionId });
    } catch {
      process.send?.({ type: "bootstrap.failed" }, () => process.exit(1));
    }
    return;
  }
  if (!boundary) return;
  const response = boundary.handle(message);
  process.send?.(response, () => {
    if (response.ok && response.result.kind === "shutdown") {
      boundary?.close();
      process.disconnect();
    }
  });
});
