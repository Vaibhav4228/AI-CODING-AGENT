const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const protocol = require("@local-agent/protocol");
const { RuntimeBoundary } = require("../dist/local-runtime/boundary.js");
const { LocalCheckpointStore, RevisionConflict } = require("../dist/local-runtime/storage.js");
const { launchLocalRuntime } = require("../dist/local-runtime/client.js");

const state = { schemaVersion: 1, status: "planning", summary: "fixture checkpoint", nextStep: "inspect context" };
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-step1-"));
  const root = path.join(base, "workspace");
  fs.mkdirSync(root);
  t.after(() => {
    if (path.dirname(base) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith("agent-step1-")) throw new Error("Unsafe fixture cleanup");
    fs.rmSync(base, { recursive: true, force: true });
  });
  const workspaceId = randomUUID();
  return { base, ownerId: randomUUID(), sessionId: randomUUID(), token: randomBytes(32).toString("hex"), storageDirectory: path.join(base, "storage"), workspaces: [{ workspaceId, root, trusted: true }], workspaceId };
}
function boundaryFixture(t) {
  const options = fixture(t);
  const boundary = new RuntimeBoundary(options);
  return { options, boundary, request: (call, overrides = {}) => ({ protocolVersion: 1, requestId: randomUUID(), sessionId: options.sessionId, token: options.token, workspaceId: options.workspaceId, call, ...overrides }) };
}

test("protocol rejects unknown methods, versions, extra fields and inconsistent context lines", () => {
  assert.equal(protocol.callSchema.safeParse({ method: "shell.exec", params: { command: "anything" } }).success, false);
  assert.equal(protocol.contextRequestSchema.safeParse({ documentUri: "file:///fixture.ts", documentVersion: 1, startLine: 5, endLine: 2 }).success, false);
  assert.equal(protocol.checkpointStateSchema.safeParse({ ...state, secret: "not a field" }).success, false);
  assert.equal(protocol.approvalSchema.safeParse({ decision: "allow_forever" }).success, false);
  assert.equal(protocol.eventSchema.safeParse({ protocolVersion: 2 }).success, false);
});

test("boundary authenticates session and token without echoing credentials", (t) => {
  const { boundary, request } = boundaryFixture(t);
  try {
    assert.equal(boundary.handle(request({ method: "runtime.health", params: {} })).result.mode, "boundary-only");
    for (const overrides of [{ token: "0".repeat(64) }, { sessionId: randomUUID() }]) {
      const response = boundary.handle(request({ method: "runtime.health", params: {} }, overrides));
      assert.equal(response.error.code, "UNAUTHORIZED");
      assert.equal(JSON.stringify(response).includes("token"), false);
    }
  } finally { boundary.close(); }
});

test("boundary rejects malformed, oversized, unknown and replayed requests", (t) => {
  const { boundary, request } = boundaryFixture(t);
  try {
    const health = request({ method: "runtime.health", params: {} });
    for (const input of [null, { ...health, protocolVersion: 2 }, { ...health, root: "C:/" }, { ...health, call: { method: "workspace.register", params: { root: "C:/" } } }, "x".repeat(protocol.MAX_MESSAGE_BYTES + 1)]) {
      assert.equal(boundary.handle(input).error.code, "INVALID_REQUEST");
    }
    assert.equal(boundary.handle(health).ok, true);
    assert.equal(boundary.handle(health).error.code, "REPLAY");
  } finally { boundary.close(); }
});

test("checkpoint operations require an approved trusted workspace", (t) => {
  const { boundary, request } = boundaryFixture(t);
  try {
    const call = { method: "checkpoint.load", params: { runId: randomUUID() } };
    assert.equal(boundary.handle(request(call, { workspaceId: randomUUID() })).error.code, "WORKSPACE_DENIED");
    const missing = request(call); delete missing.workspaceId;
    assert.equal(boundary.handle(missing).error.code, "WORKSPACE_DENIED");
  } finally { boundary.close(); }
  const options = fixture(t);
  options.workspaces[0].trusted = false;
  const restricted = new RuntimeBoundary(options);
  try {
    const response = restricted.handle({ protocolVersion: 1, requestId: randomUUID(), sessionId: options.sessionId, token: options.token, workspaceId: options.workspaceId, call: { method: "checkpoint.load", params: { runId: randomUUID() } } });
    assert.equal(response.error.code, "WORKSPACE_DENIED");
  } finally { restricted.close(); }
});

test("context, patch and approval contracts cannot enable tools in Step 1", (t) => {
  const { boundary, request } = boundaryFixture(t);
  try {
    const calls = [
      { method: "context.request", params: { documentUri: "file:///fixture.ts", documentVersion: 1, startLine: 1, endLine: 2 } },
      { method: "patch.propose", params: { patchId: randomUUID(), documentUri: "file:///fixture.ts", expectedDocumentVersion: 1, expectedContentHash: "a".repeat(64), unifiedDiff: "fixture diff" } },
      { method: "approval.decide", params: { approvalId: randomUUID(), runId: randomUUID(), workspaceId: randomUUID(), argumentHash: "b".repeat(64), policyVersion: 1, expiresAt: "2099-01-01T00:00:00.000Z", decision: "approve_once" } },
    ];
    for (const call of calls) assert.equal(boundary.handle(request(call)).error.code, "NOT_IMPLEMENTED");
  } finally { boundary.close(); }
});

test("storage persists scoped checkpoints and rejects stale updates atomically", (t) => {
  const options = fixture(t);
  const runId = randomUUID();
  let store = new LocalCheckpointStore(options.storageDirectory);
  try {
    assert.equal(store.load(options.ownerId, options.workspaceId, runId), null);
    assert.equal(store.save(options.ownerId, options.workspaceId, runId, 0, state).revision, 1);
    assert.throws(() => store.save(options.ownerId, options.workspaceId, runId, 0, state), RevisionConflict);
    assert.equal(store.load(randomUUID(), options.workspaceId, runId), null);
    assert.equal(store.load(options.ownerId, randomUUID(), runId), null);
    assert.equal(store.save(options.ownerId, options.workspaceId, runId, 1, { ...state, summary: "updated" }).revision, 2);
    store.close();
    store = new LocalCheckpointStore(options.storageDirectory);
    assert.equal(store.load(options.ownerId, options.workspaceId, runId).state.summary, "updated");
    assert.throws(() => store.load("../other-owner", options.workspaceId, runId));
  } finally { store.close(); }
});

test("independent store connections detect conflicting revisions", (t) => {
  const options = fixture(t);
  const a = new LocalCheckpointStore(options.storageDirectory);
  const b = new LocalCheckpointStore(options.storageDirectory);
  try {
    const runId = randomUUID();
    a.save(options.ownerId, options.workspaceId, runId, 0, state);
    assert.throws(() => b.save(options.ownerId, options.workspaceId, runId, 0, state), RevisionConflict);
    assert.equal(b.load(options.ownerId, options.workspaceId, runId).revision, 1);
  } finally { a.close(); b.close(); }
});

test("workspace metadata cannot place checkpoint storage inside the editable workspace", (t) => {
  const options = fixture(t);
  options.storageDirectory = path.join(options.workspaces[0].root, ".agent-state");
  assert.throws(() => new RuntimeBoundary(options), /outside workspace/);
  assert.equal(fs.existsSync(options.storageDirectory), false);
});

test("storage rejects an unknown schema version instead of overwriting it", (t) => {
  const options = fixture(t);
  fs.mkdirSync(options.storageDirectory);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(options.storageDirectory, "checkpoints.sqlite"));
  db.exec("PRAGMA user_version=99");
  db.close();
  assert.throws(() => new LocalCheckpointStore(options.storageDirectory), /Unsupported checkpoint database version/);
});

test("canonical storage check rejects a junction/symlink into the workspace before writing", (t) => {
  const options = fixture(t);
  const alias = path.join(options.base, "workspace-alias");
  fs.symlinkSync(options.workspaces[0].root, alias, process.platform === "win32" ? "junction" : "dir");
  options.storageDirectory = path.join(alias, "state");
  assert.throws(() => new RuntimeBoundary(options), /outside workspace/);
  assert.equal(fs.existsSync(path.join(options.workspaces[0].root, "state")), false);
});

test("invalid child bootstrap fails promptly without contacting any services", { timeout: 10000 }, async (t) => {
  const options = fixture(t);
  await assert.rejects(launchLocalRuntime({ ownerId: "invalid-owner", storageDirectory: options.storageDirectory, workspaces: options.workspaces }), /bootstrap failed/);
});

test("direct runtime entry has no standalone/public server mode", () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/local-runtime/entry.js")], { timeout: 5000, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
});

test("real child IPC starts, saves, rejects scope and survives runtime restart", { timeout: 20000 }, async (t) => {
  const options = fixture(t);
  const runId = randomUUID();
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require=nonexistent-step1-canary-module";
  let client;
  try {
    client = await launchLocalRuntime({ ownerId: options.ownerId, storageDirectory: options.storageDirectory, workspaces: options.workspaces });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
  try {
    assert.equal((await client.request({ method: "runtime.health", params: {} })).ok, true);
    assert.equal((await client.request({ method: "checkpoint.save", params: { runId, expectedRevision: 0, state } }, options.workspaceId)).result.checkpoint.revision, 1);
    assert.equal((await client.request({ method: "checkpoint.save", params: { runId, expectedRevision: 0, state } }, options.workspaceId)).error.code, "CONFLICT");
    assert.equal((await client.request({ method: "checkpoint.load", params: { runId } }, randomUUID())).error.code, "WORKSPACE_DENIED");
  } finally { await client.stop(); }
  await assert.rejects(client.request({ method: "runtime.health", params: {} }));
  const restarted = await launchLocalRuntime({ ownerId: options.ownerId, storageDirectory: options.storageDirectory, workspaces: options.workspaces });
  try {
    const loaded = await restarted.request({ method: "checkpoint.load", params: { runId } }, options.workspaceId);
    assert.equal(loaded.result.checkpoint.state.summary, state.summary);
    assert.equal(loaded.result.checkpoint.revision, 1);
  } finally { await restarted.stop(); }
});
