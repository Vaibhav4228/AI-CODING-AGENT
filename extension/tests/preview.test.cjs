const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { DemoController } = require("../dist/test/demo.cjs");
const { renderHtml } = require("../dist/test/html.cjs");
function fixture() {
  const events = []; const jobs = [];
  const controller = new DemoController((event) => events.push(event), "fixture-workspace", false, { later: (callback) => { const job = { callback, cancelled: false }; jobs.push(job); return () => { job.cancelled = true; }; } });
  const send = (type, fields = {}) => controller.receive({ protocolVersion: 1, requestId: randomUUID(), ...(type === "ui.ready" ? {} : { viewId: controller.snapshot().viewId }), type, ...fields });
  return { controller, events, send, flush: () => jobs.splice(0).forEach((job) => { if (!job.cancelled) job.callback(); }) };
}

test("preview starts idle and ready messages contain no runtime credentials", () => {
  const { controller, send, events } = fixture(); send("ui.ready");
  assert.equal(controller.snapshot().phase, "idle");
  assert.equal(events[0].state.providerConnected, false);
  assert.equal(JSON.stringify(events).includes('"token"'), false);
  controller.dispose();
});
test("scripted plan completes without reading files or calling a provider", () => {
  const { controller, send, flush } = fixture();
  send("demo.start", { prompt: "Explain the workflow", scenario: "plan" });
  assert.equal(controller.snapshot().phase, "running"); flush();
  assert.equal(controller.snapshot().phase, "completed");
  assert.match(controller.snapshot().messages[1].content, /scripted preview/);
  controller.dispose();
});
test("unknown, oversized, credential-bearing and wrong-session messages are rejected", () => {
  const { controller, send } = fixture();
  controller.receive({ type: "executeCommand", command: "not permitted" });
  assert.match(controller.snapshot().alert, /rejected/);
  send("demo.start", { prompt: "x", scenario: "plan", token: "never accepted" });
  assert.equal(controller.snapshot().phase, "idle");
  send("demo.start", { prompt: "x".repeat(21000), scenario: "plan" });
  assert.equal(controller.snapshot().phase, "idle");
  send("demo.start", { prompt: "x", scenario: "plan", viewId: randomUUID() });
  assert.equal(controller.snapshot().phase, "idle");
  controller.dispose();
});
test("duplicate requests cannot start another demo", () => {
  const { controller } = fixture(); const intent = { protocolVersion: 1, requestId: randomUUID(), viewId: controller.snapshot().viewId, type: "demo.start", prompt: "fixture", scenario: "plan" };
  controller.receive(intent); const run = controller.snapshot().runId; controller.receive(intent);
  assert.equal(controller.snapshot().runId, run); controller.dispose();
});
test("cancellation and reset dispose pending mock work", () => {
  const { controller, send, flush } = fixture();
  send("demo.start", { prompt: "fixture", scenario: "plan" });
  send("demo.cancel", { runId: controller.snapshot().runId }); flush();
  assert.equal(controller.snapshot().phase, "cancelled");
  send("demo.reset"); assert.equal(controller.snapshot().messages.length, 0);
  send("demo.start", { prompt: "fixture", scenario: "plan" }); send("demo.reset"); flush();
  assert.equal(controller.snapshot().phase, "idle"); controller.dispose();
});
test("approval requires exact current run and action; denial cannot complete the action", () => {
  const { controller, send, flush } = fixture();
  send("demo.start", { prompt: "fixture", scenario: "approval" }); flush();
  const pending = controller.snapshot();
  send("demo.decide", { runId: pending.runId, approvalId: randomUUID(), decision: "approve_once" });
  assert.equal(controller.snapshot().phase, "awaiting_approval");
  send("demo.decide", { runId: pending.runId, approvalId: pending.approval.id, decision: "deny" });
  assert.equal(controller.snapshot().phase, "cancelled");
  send("demo.decide", { runId: pending.runId, approvalId: pending.approval.id, decision: "approve_once" });
  assert.equal(controller.snapshot().phase, "cancelled"); controller.dispose();
});
test("valid demo approval only changes the preview", () => {
  const { controller, send, flush } = fixture(); send("demo.start", { prompt: "fixture", scenario: "approval" }); flush();
  const pending = controller.snapshot(); send("demo.decide", { runId: pending.runId, approvalId: pending.approval.id, decision: "approve_once" });
  assert.equal(controller.snapshot().phase, "completed"); assert.match(controller.snapshot().messages[1].content, /did not modify any file/); controller.dispose();
});
test("provider failure is simulated and dispose prevents late updates", () => {
  const { controller, send, flush, events } = fixture(); send("demo.start", { prompt: "fixture", scenario: "failure" }); flush();
  assert.equal(controller.snapshot().phase, "failed"); assert.match(controller.snapshot().alert, /no network request/);
  controller.dispose(); const count = events.length; send("ui.ready"); flush(); assert.equal(events.length, count);
});
test("HTML has strict CSP, bundled resources only and escaped attributes", () => {
  const html = renderHtml({ nonce: "fixtureNonce", cspSource: "vscode-webview://fixture", scriptUri: 'asset.js" onerror="unsafe', styleUri: "asset.css" });
  assert.match(html, /connect-src &#39;none&#39;/);
  assert.match(html, /default-src &#39;none&#39;/);
  assert.match(html, /nonce="fixtureNonce"/);
  assert.equal(html.includes('src="asset.js" onerror='), false);
  assert.equal(html.includes("unsafe-inline"), false);
});
