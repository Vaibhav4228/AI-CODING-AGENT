import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { Call, MAX_MESSAGE_BYTES, requestSchema, Response, responseSchema } from "@local-agent/protocol";
import { WorkspaceGrant } from "./boundary";

export interface LaunchOptions { ownerId: string; storageDirectory: string; workspaces: WorkspaceGrant[] }
export interface LocalRuntimeClient {
  request(call: Call, workspaceId?: string): Promise<Response>;
  stop(): Promise<void>;
}

/** Extension-host-only launcher. Never hand this client or its credentials to a webview. */
export async function launchLocalRuntime(options: LaunchOptions): Promise<LocalRuntimeClient> {
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key]) safeEnvironment[key] = process.env[key];
  }
  const child = fork(path.join(__dirname, "entry.js"), [], {
    execPath: process.execPath, execArgv: [], cwd: __dirname,
    env: safeEnvironment, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const pending = new Map<string, { resolve: (value: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let closed = false;
  let stopping = false;
  const rejectPending = () => {
    closed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Local runtime disconnected"));
    }
    pending.clear();
  };
  const exitPromise = new Promise<void>((resolve) => child.once("exit", () => { rejectPending(); resolve(); }));
  child.on("error", rejectPending);
  child.on("disconnect", rejectPending);
  child.on("message", (message: unknown) => {
    const parsed = responseSchema.safeParse(message);
    if (!parsed.success || !parsed.data.requestId) return;
    const item = pending.get(parsed.data.requestId);
    if (!item) return;
    pending.delete(parsed.data.requestId);
    clearTimeout(item.timer);
    item.resolve(parsed.data);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError); };
      const onExit = () => { cleanup(); reject(new Error("Local runtime bootstrap failed")); };
      const onError = () => onExit();
      const onMessage = (input: unknown) => {
        const message = input as { type?: string; sessionId?: string; protocolVersion?: number } | null;
        if (message?.type === "ready" && message.sessionId === sessionId && message.protocolVersion === 1) { cleanup(); resolve(); }
        else if (message?.type === "bootstrap.failed") onExit();
      };
      const timer = setTimeout(onExit, 6000);
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
      child.send({ type: "bootstrap", ...options, sessionId, token }, (error) => { if (error) onError(); });
    });
  } catch (error) {
    child.kill();
    throw error;
  }

  const send = async (call: Call, workspaceId?: string): Promise<Response> => {
    if (closed || !child.connected || pending.size >= 64) return Promise.reject(new Error("Local runtime unavailable or busy"));
    const request = requestSchema.parse({ protocolVersion: 1, requestId: randomUUID(), sessionId, token, ...(workspaceId ? { workspaceId } : {}), call });
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_MESSAGE_BYTES) return Promise.reject(new Error("Request too large"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(request.requestId); reject(new Error("Local runtime request timed out; outcome may be uncertain")); }, 5000);
      pending.set(request.requestId, { resolve, reject, timer });
      child.send(request, (error) => {
        if (!error) return;
        const item = pending.get(request.requestId);
        if (!item) return;
        pending.delete(request.requestId);
        clearTimeout(timer);
        reject(new Error("Local runtime send failed"));
      });
    });
  };

  return {
    request: (call, workspaceId) => stopping ? Promise.reject(new Error("Local runtime stopping")) : send(call, workspaceId),
    stop: async () => {
      if (stopping) return exitPromise;
      stopping = true;
      const killTimer = setTimeout(() => child.kill(), 6000);
      try {
        if (!closed) await send({ method: "runtime.shutdown", params: {} });
      } finally {
        if (closed && child.exitCode === null) child.kill();
        await exitPromise;
        clearTimeout(killTimer);
      }
    },
  };
}
