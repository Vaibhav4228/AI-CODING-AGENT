const {test}=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {ChatSessions}=require("../dist/test/sessions.cjs");
const {Credentials}=require("../dist/test/credentials.cjs");
function storage(){const data=new Map();return {get:k=>globalThis.structuredClone(data.get(k)),update:async(k,v)=>{data.set(k,globalThis.structuredClone(v));}};}
const current=state=>state.sessions.find(s=>s.id===state.current);

test("sessions survive host reconstruction and isolate workspaces and chats",async()=>{
  const db=storage();let store=new ChatSessions(db);
  let s=current(await store.snapshot("folder-a"));
  const run=await store.begin("folder-a",s.id,0,randomUUID(),{role:"user",text:"Name this Atlas"});
  await store.finish("folder-a",s.id,run.runId,{role:"assistant",text:"Atlas",undoId:"old-handle"},"completed");
  store=new ChatSessions(db);s=current(await store.snapshot("folder-a"));
  assert.equal(s.turns.length,2);assert.equal(s.turns[1].undoId,undefined);
  assert.equal(current(await store.snapshot("folder-b")).turns.length,0);
  await store.select("folder-a","new");const next=current(await store.snapshot("folder-a"));
  assert.notEqual(next.id,s.id);assert.equal(next.turns.length,0);
  await store.select("folder-a","open",s.id);
  const follow=await store.begin("folder-a",s.id,s.revision,randomUUID(),{role:"user",text:"What is its name?"});
  assert.equal(follow.history[0].content,"Name this Atlas");
});

test("duplicate requests, stale revisions and foreign sessions cannot run",async()=>{
  const store=new ChatSessions(storage());const s=current(await store.snapshot("a"));
  const args=["a",s.id,0,randomUUID(),{role:"user",text:"Hello"}];
  const results=await Promise.allSettled([store.begin(...args),store.begin(...args)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  await assert.rejects(store.select("a","new"),/Stop/);
  await assert.rejects(store.begin("b",s.id,0,randomUUID(),args[4]),/stale/);
  const running=current(await store.snapshot("a"));
  await store.finish("a",s.id,"wrong-run",{role:"assistant",text:"incorrect"},"completed");
  assert.equal(current(await store.snapshot("a")).turns.length,1);
  await store.finish("a",s.id,running.pending.runId,{role:"assistant",text:"done"},"completed");
  await assert.rejects(store.begin(...args),/stale/);
});

test("interrupted runs recover without replay and rename/delete persist",async()=>{
  const db=storage();let store=new ChatSessions(db);const s=current(await store.snapshot("a"));
  await store.begin("a",s.id,0,randomUUID(),{role:"user",text:"create files"});
  store=new ChatSessions(db);let restored=current(await store.snapshot("a"));
  assert.equal(restored.status,"interrupted");assert.equal(restored.pending,null);assert.equal(restored.turns.length,1);
  await store.select("a","rename",s.id,"Todo app");
  assert.equal(current(await new ChatSessions(db).snapshot("a")).title,"Todo app");
  await store.select("a","delete",s.id);restored=current(await store.snapshot("a"));
  assert.notEqual(restored.id,s.id);assert.equal(restored.turns.length,0);
});

test("storage failures prevent request admission, credentials are excluded, retention is bounded",async()=>{
  const db=storage();const store=new ChatSessions(db);const s=current(await store.snapshot("a"));
  await assert.rejects(store.begin("a",s.id,0,randomUUID(),{role:"user",text:"password=abcdefghijklmnop"}),/credentials/);
  db.update=async()=>{throw Error("disk full");};
  await assert.rejects(store.begin("a",s.id,0,randomUUID(),{role:"user",text:"Hi"}),/disk full/);
  assert.equal(current(await store.snapshot("a")).pending,null);
  const retained=new ChatSessions(storage());for(let i=0;i<25;i++)await retained.select("a","new");
  assert.equal((await retained.snapshot("a")).sessions.length,20);
});

test("key replacement, removal, explicit fallback and model settings survive reconstruction",async()=>{
  const data=new Map();const secrets={get:async k=>data.get(k),store:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)};
  const prefs=storage();const env=async()=>({DEEPSEEK_API_KEY:"fake-env",DEEPSEEK_MODEL:"test-model"});
  let keys=new Credentials(secrets,prefs,env);
  assert.equal((await keys.resolve("DeepSeek")).source,"environment");
  await keys.save("DeepSeek","fake-first");assert.equal((await keys.resolve("DeepSeek")).key,"fake-first");
  await keys.save("DeepSeek","fake-replacement");keys=new Credentials(secrets,prefs,env);
  assert.equal((await keys.resolve("DeepSeek")).key,"fake-replacement");
  assert.ok(!JSON.stringify(await keys.status()).includes("fake-"));
  await keys.remove("DeepSeek");assert.equal((await keys.resolve("DeepSeek")).key,undefined);
  assert.equal((await keys.resolve("DeepSeek")).source,"disabled");
  await keys.useEnvironment("DeepSeek");assert.equal((await keys.resolve("DeepSeek")).key,"fake-env");
  await keys.model("DeepSeek","model/new");assert.equal((await keys.resolve("DeepSeek")).model,"model/new");
  await assert.rejects(keys.model("DeepSeek","bad model"),/valid/);
});
