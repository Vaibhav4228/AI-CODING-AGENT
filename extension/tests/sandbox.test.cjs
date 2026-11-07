const {test}=require("node:test");
const assert=require("node:assert/strict");
const {revision,createArgs,checkWorker,runSandbox}=require("../dist/test/sandbox.cjs");
const fs=require("node:fs");
const fixture=script=>[{path:"package.json",content:JSON.stringify({scripts:{test:"node test.js"}})},{path:"test.js",content:script}];
test("sandbox snapshot binds exact buffer bytes and refuses secrets, escapes and duplicates",()=>{
  assert.notEqual(revision(fixture("1")),revision(fixture("2")));
  for(const path of [".env","../x","a/../../x","C:/x","/x",".git/hooks/test","node_modules/a"])assert.throws(()=>revision([{path,content:"x"}]));
  assert.throws(()=>revision([{path:"x",content:"password=abcdefghijklmnop"}]));
  assert.throws(()=>revision([{path:"x",content:"a"},{path:"X",content:"b"}]));
});
test("docker create enforces local resource and isolation policy",()=>{
  const args=createArgs("va-test","test");
  for(const pair of ["--network none","--read-only","--user 65534:65534","--cap-drop ALL","--security-opt no-new-privileges","--memory 256m","--pids-limit 64","--pull=never"])assert.ok(args.join(" ").includes(pair));
  assert.ok(!args.includes("--privileged") && !args.includes("--mount") && !args.includes("-v"));
  assert.throws(()=>createArgs("va-test","install"));
});
test("missing worker fails closed",{skip:process.platform==="win32" && fs.existsSync("C:/Program Files/Docker/Docker/resources/bin/docker.exe")},async()=>{
  await assert.rejects(checkWorker(),/unavailable/);
  await assert.rejects(runSandbox("test",fixture("1"),new globalThis.AbortController().signal),/unavailable/);
});
const live={skip:process.env.TEST_LINUX_WORKER!=="1"};
test("live container isolates secrets, host socket, root filesystem and network and returns changes",live,async()=>{
 const src=fixture(`const a=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os");a.equal(process.getuid(),65534);a.deepEqual(Object.keys(os.networkInterfaces()),["lo"]);a.equal(fs.existsSync("/var/run/docker.sock"),false);a.equal(process.env.DEEPSEEK_API_KEY,undefined);a.throws(()=>fs.writeFileSync("/etc/test","x"));fs.writeFileSync("test.js","// changed");console.log("isolated")`);
 const r=await runSandbox("test",src,new globalThis.AbortController().signal);
 assert.equal(r.code,0,r.output);assert.match(r.output,/isolated/);assert.equal(r.hash,revision(src));assert.deepEqual(r.changes,[{path:"test.js",content:"// changed"}]);});
test("live container terminates output floods and timeouts",live,async()=>{
 for(const script of ["while(true)console.log('x'.repeat(4096))","while(true){}"]){
 const r=await runSandbox("test",fixture(script),new globalThis.AbortController().signal);assert.notEqual(r.code,0);assert.ok(r.output.length<=65536);}
});
test("live cancellation removes the whole worker",live,async()=>{
 const ctl=new globalThis.AbortController();const timer=setTimeout(()=>ctl.abort(),3500);
 try{await assert.rejects(runSandbox("test",fixture("require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true});setInterval(()=>{},1000)"),ctl.signal),/cancel|abort/i);}finally{clearTimeout(timer);}
});
