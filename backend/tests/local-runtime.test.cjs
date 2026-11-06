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
    for (const call of calls) assert.equal(boundary.handle(request(call)).error.code, call.method === "approval.decide" ? "APPROVAL_DENIED" : "NOT_IMPLEMENTED");
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

test("exact approvals survive restart, resist tampering and can be consumed only once", (t) => {
  const { options, boundary, request } = boundaryFixture(t);
  const args = { runId: randomUUID(), workspaceRevision: "a".repeat(64),
    action: { capability: "sandbox.execute", executable: "npm", argv: ["test"], cwd: "." } };
  const review = boundary.handle(request({ method: "approval.request", params: args })).result.approval;
  const decide = decision => request({ method: "approval.decide", params: { ...review, decision } });
  const consume = changes => request({ method: "approval.consume", params: { ...args, approvalId: review.approvalId, ...changes } });
  assert.equal(boundary.handle(consume({})).ok, false);
  assert.equal(boundary.handle(decide("approve_once")).ok, true);
  boundary.close();
  const resumed = new RuntimeBoundary(options);
  try {
    for (const change of [{ runId: randomUUID() }, { workspaceRevision: "b".repeat(64) },
        { action: { ...args.action, argv: ["publish"] } }])
      assert.equal(resumed.handle(consume(change)).error.code, "APPROVAL_DENIED");
    assert.equal(resumed.handle(consume({})).result.status, "consumed");
    assert.equal(resumed.handle(consume({})).error.code, "APPROVAL_DENIED");
    const second = resumed.handle(request({ method: "approval.request", params: args })).result.approval;
    assert.equal(resumed.handle(request({ method: "approval.decide", params: { ...second, decision: "deny" } })).result.status, "denied");
    assert.equal(resumed.handle(consume({ approvalId: second.approvalId })).error.code, "APPROVAL_DENIED");
  } finally { resumed.close(); }
});

const { FixtureLoop } = require("../dist/local-runtime/fixture-loop.js");
function fixtureAgent(t, provider) {
  let store;
  t.after(() => store?.close());
  const options = fixture(t);
  store = new LocalCheckpointStore(options.storageDirectory);
  const scope = { owner: options.ownerId, workspace: options.workspaceId, session: options.sessionId };
  return { agent: new FixtureLoop(store, scope, provider), store, scope, options };
}
function advance(agent, id) {
  for (let i = 0; i < 20; i++) {
    const cp = agent.step(id);
    if (cp.state.fixture.stop || cp.state.status === "awaiting_approval") return cp;
  }
  assert.fail("unbounded loop");
}
test("explain and injection fixtures are isolated and report verified evidence or denial", t => {
  const { agent } = fixtureAgent(t);
  const explain = agent.start("explain"), injected = agent.start("injection");
  assert.equal(advance(agent, injected.runId).state.fixture.stop, "invalid_tool");
  const cp = advance(agent, explain.runId);
  assert.equal(cp.state.fixture.stop, "verified");
  assert.equal(cp.state.fixture.candidate, null);
  assert.equal(agent.step(cp.runId).revision, cp.revision);
});
test("pending fixture reloads, cursor replays only new events, approved fix passes independent checks", t => {
  const { agent, scope, options } = fixtureAgent(t);
  const id = agent.start("fix").runId;
  const pending = advance(agent, id);
  const reopened = new LocalCheckpointStore(options.storageDirectory);
  try {
    assert.throws(() => new FixtureLoop(reopened, { ...scope, session: randomUUID() }).load(id));
    const resumed = new FixtureLoop(reopened, scope);
    assert.deepEqual(resumed.step(id), pending);
    const final = resumed.step(id, "approved");
    assert.equal(final.state.fixture.stop, "verified");
    assert.equal(final.state.fixture.events.slice(pending.revision).length, 1);
    assert.equal(resumed.step(id, "approved").revision, final.revision);
  } finally { reopened.close(); }
});
test("denials, cancellation, provider failures, ungrounded claims and budgets stop runs", t => {
  for (const [provider, reason] of [
    [() => { throw Error(); }, "provider_error"],
    [() => ({ action: { name: "answer", line: 1, finding: "discount applied twice" }, costMicros: 0 }), "unverified"],
    [() => ({ action: { name: "read", path: "pricing.ts" }, costMicros: 0 }), "budget"],
    [() => ({ action: "x".repeat(10000), costMicros: 0 }), "budget"],
    [() => ({ action: null, costMicros: 1 }), "budget"],
  ]) {
    const { agent } = fixtureAgent(t, provider);
    assert.equal(advance(agent, agent.start("fix").runId).state.fixture.stop, reason);
  }
  const { agent } = fixtureAgent(t);
  const id = agent.start("fix").runId;
  advance(agent, id);
  assert.equal(agent.step(id, "deny").state.fixture.stop, "denied");
  assert.equal(agent.step(agent.start("explain").runId, "cancel").state.fixture.stop, "cancelled");
});
test("bad fixes exhaust repairs instead of claiming success", t => {
  const { agent } = fixtureAgent(t, run => ({ action: run.evidence
    ? { name: "propose", discountApplications: 2 } : { name: "read", path: "pricing.ts" }, costMicros: 0 }));
  const id = agent.start("fix").runId;
  for (let attempt = 0; attempt < 3; attempt++) { advance(agent, id); agent.step(id, "approved"); }
  assert.equal(agent.load(id).state.fixture.stop, "unverified");
});
