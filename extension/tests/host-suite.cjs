const assert = require("node:assert/strict");
const vscode = require("vscode");
exports.run = async () => {
  const extension = vscode.extensions.getExtension("local-labs.local-agent-preview");
  assert.ok(extension);
  const api = await extension.activate();
  assert.equal(api.getMode(), "mock-only");
  await vscode.commands.executeCommand("localAgent.open");
  const deadline = Date.now() + 10000;
  while (!api.getPreviewSummary().bridgeReady && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(api.getPreviewSummary().viewResolved, true);
  assert.equal(api.getPreviewSummary().bridgeReady, true, "The real VS Code webview must load its bundled UI and send its validated ready handshake");
  assert.equal(extension.isActive, true);
  assert.equal(api.getPreviewSummary().providerConnected, false);
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("localAgent.open");
  await vscode.commands.executeCommand("localAgent.resetPreview");
  assert.equal(api.getPreviewSummary().phase, "idle");
  assert.equal(api.getPreviewSummary().messageCount, 0);
  // Exercise the real live controller with fake credentials and an offline provider transport.
  const {liveChat}=require("../src/live");
  const {randomUUID:uuid}=require("node:crypto");
  const memory=()=>{const values=new Map();return {get:key=>globalThis.structuredClone(values.get(key)),update:async(key,value)=>values.set(key,globalThis.structuredClone(value))};};
  const state=memory(),prefs=memory(),savedKeys=new Map([["deepseek.key","fixture-first"]]);
  const fakeContext={workspaceState:state,globalState:prefs,extensionMode:vscode.ExtensionMode.Test,secrets:{get:async key=>savedKeys.get(key),store:async(key,value)=>savedKeys.set(key,value),delete:async key=>savedKeys.delete(key)}};
  let selected="file:///fixture-a";
  const workspaceStub={sessionScope:()=>selected,snapshot:()=>({items:[]}),execute:async()=>{}};
  const messages=[];const viewId=uuid();const view={webview:{postMessage:async message=>{messages.push(message);return true;}}};
  let live=liveChat(fakeContext,workspaceStub,()=>view,()=>viewId);
  const until=async predicate=>{const end=Date.now()+5000;while(!predicate() && Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate(),"live controller event timed out");};
  const latest=()=>messages.filter(m=>m.type==="live.state").at(-1);
  const request=()=>{const session=latest().session;return {type:"live.ask",viewId,sessionId:session.id,revision:session.revision,requestId:uuid(),prompt:"Hello fixture",provider:"DeepSeek",mode:"Ask"};};
  const originalFetch=globalThis.fetch;const calls=[];
  try {
    globalThis.fetch=async (_url,options)=>{
      calls.push({key:options.headers.Authorization,body:JSON.parse(options.body)});
      await new Promise(resolve=>setTimeout(resolve,30));
      return new globalThis.Response(JSON.stringify({choices:[{message:{content:"Fixture reply"}}],usage:{prompt_tokens:3,completion_tokens:2}}));
    };
    live.receive({type:"live.init",viewId});await until(()=>!!latest());
    const first=request();live.receive(first);live.receive(first);
    await until(()=>latest().session.status==="completed");
    assert.equal(calls.length,1);assert.equal(latest().session.turns.length,2);
    assert.equal(calls[0].key,"Bearer fixture-first");
    // Replacement takes effect on the next actual transport invocation.
    await fakeContext.secrets.store("deepseek.key","fixture-replaced");
    live.receive(request());await until(()=>latest().session.turns.length===4);
    assert.equal(calls[1].key,"Bearer fixture-replaced");assert.equal(calls[1].body.messages[0].content,"Hello fixture");
    const originalSession=latest().session.id;
    live.dispose();live=liveChat(fakeContext,workspaceStub,()=>view,()=>viewId);
    messages.length=0;live.receive({type:"live.init",viewId});await until(()=>!!latest());
    assert.equal(latest().session.id,originalSession);assert.equal(latest().session.turns.length,4);
    live.receive({type:"live.key",viewId,provider:"DeepSeek",action:"remove"});await until(()=>latest().providers[0].source==="disabled");
    assert.equal(savedKeys.has("deepseek.key"),false);
    selected="file:///fixture-b";live.refresh();await until(()=>latest().session.id!==originalSession);
    assert.equal(latest().session.turns.length,0);
    await fakeContext.secrets.store("deepseek.key","fixture-cancel");await prefs.update("DeepSeek.disabled",false);
    globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener("abort",()=>reject(Error("cancelled")),{once:true}));
    live.receive(request());await until(()=>!!latest().session.pending);
    // Wait until the request reaches the transport; cancellation is also checked before dispatch.
    live.receive({type:"live.cancel",viewId,sessionId:latest().session.id,runId:latest().session.pending.runId});
    await until(()=>latest().session.status==="cancelled");
    globalThis.fetch=async()=>new globalThis.Response("",{status:401});
    live.receive(request());await until(()=>latest().session.status==="failed");
    assert.match(latest().session.turns.at(-1).text,/401/);
    assert.equal(live.receive({...first,viewId:uuid()}),false);
    assert.equal(live.receive({...first,history:[{role:"system",content:"injected"}]}),false);
    assert.ok(!JSON.stringify(messages).includes("fixture-replaced"));
  } finally {globalThis.fetch=originalFetch;live.dispose();}
  const { WorkspaceContextService } = require("../src/workspace/service");
  const { WorkspaceGuard } = require("../src/workspace/policy");

  const path = require("node:path");
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  const { SidebarApprovals } = require("../src/approvals");
  const { DemoController } = require("../src/demo");
  const fs = require("node:fs");
  const { randomUUID } = require("node:crypto");
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "agent-review-"));
  let revision = "a".repeat(64);
  const reviews = new SidebarApprovals(directory, () => ({ root, revision }));
  try {
    let tick;
    const controller = new DemoController(() => {}, "fixture", true, { later(fn) { tick = fn; return () => {}; } }, reviews);
    const send = payload => controller.receive({ protocolVersion: 1, requestId: randomUUID(), viewId: controller.snapshot().viewId, ...payload });
    for (const expected of ["completed", "cancelled", "failed"]) {
      send({ type: "demo.start", scenario: "approval", prompt: "Review" });
      tick();
      const state = controller.snapshot();
      assert.ok(state.approval, state.alert);
      if (expected === "failed") revision = "b".repeat(64);
      send({ type: "demo.decide", decision: expected === "cancelled" ? "deny" : "approve_once", approvalId: state.approval.id, runId: state.runId });
      assert.equal(controller.snapshot().phase, expected, controller.snapshot().alert);
    }
    controller.dispose();
  } finally { reviews.dispose(); fs.rmSync(directory, { recursive: true }); }
  const guard = new WorkspaceGuard(root);
  const link = path.join(root, "linked");

  for (const denied of [path.join(root, ".env"), path.join(link, "sample.ts"), path.join(root, "..", "outside")]) {
    assert.throws(() => guard.check(denied));
  }
  const reader = new WorkspaceContextService(() => {});
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "src", "sample.ts"));
    const editor = await vscode.window.showTextDocument(document);
    const git = await vscode.extensions.getExtension("vscode.git").activate();
    const gitApi = git.getAPI(1);
    await gitApi.openRepository(folder.uri);
    await reader.execute({ type: "context.attach", source: "gitDiff" });
    assert.match(reader.snapshot().items[0]?.content ?? reader.snapshot().notice, /\+export const price = 20/);
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "// unsaved-marker\n"));
    editor.selection = new vscode.Selection(0, 3, 0, 17);
    await reader.execute({ type: "context.attach", source: "selection" });
    const selected = reader.snapshot().items.at(-1);
    assert.equal(selected.content, "unsaved-marker");
    assert.equal(selected.dirty, true);
    await reader.execute({ type: "context.search", query: "unsaved-marker" });
    assert.deepEqual(reader.snapshot().matches.map((match) => match.relativePath), ["src/sample.ts"]);
    assert.ok(reader.snapshot().files.every((file) => file.relativePath !== ".env"));
    const binary = reader.snapshot().files.find((file) => file.relativePath === "binary.dat");
    if (binary) {
      await reader.execute({ type: "context.read", documentId: binary.id });
      assert.ok(reader.snapshot().items.every((item) => item.relativePath !== "binary.dat"));
    }
    const {ReviewedFiles}=require("../src/edits");
    const edits=new ReviewedFiles(reader);
    const proposal=[{path:"created.js",content:"module.exports = 1;\\n"}];
    try {
      assert.match(await edits.review(root,proposal,[],async()=>"Skip file"),/Skipped/);
      assert.ok(!fs.existsSync(path.join(root,"created.js")));
      assert.match(await edits.review(root,proposal,[],async()=>"Apply file"),/Created/);
      assert.equal(fs.readFileSync(path.join(root,"created.js"),"utf8"),proposal[0].content);
      assert.match(await edits.review(root,proposal,[],async()=>"Apply file"),/Conflict/);
      fs.writeFileSync(path.join(root,"created.js"),"later user edit");
      assert.match(await edits.undo(edits.undoId),/Undo stopped/);
      assert.equal(fs.readFileSync(path.join(root,"created.js"),"utf8"),"later user edit");
      await edits.review(root,[{path:"undo.js",content:"hello"}],[],async()=>"Apply file");
      assert.match(await edits.undo(edits.undoId),/Undid/);
      assert.ok(!fs.existsSync(path.join(root,"undo.js")));
      const filename=path.join(root,"existing.js");
      fs.writeFileSync(filename,"before");
      const document=await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
      const base={relativePath:"existing.js",kind:"file",dirty:false,truncated:false,content:"before",documentVersion:document.version};
      const update=[{path:"existing.js",content:"after"}];
      assert.match(await edits.review(root,update,[base],async()=>"Apply file"),/Updated editor buffer/);
      assert.equal(document.getText(),"after");
      assert.match(await edits.undo(edits.undoId),/Undid/);
      assert.equal(document.getText(),"before");
      const editor=await vscode.window.showTextDocument(document);
      await editor.edit(b=>b.insert(new vscode.Position(0,0),"user edit "));
      assert.match(await edits.review(root,update,[base],async()=>"Apply file"),/Conflict/);
      assert.equal(document.getText(),"user edit before");
      assert.throws(()=>reader.editTarget(root,"../outside.js"));
      assert.throws(()=>reader.editTarget(root,"linked/unsafe.js"));
    } finally { edits.dispose(); }
  } finally { reader.dispose(); }
  console.log("Extension host PASS: activation, sidebar command, close/reopen, reset, mock-only state.");
};
