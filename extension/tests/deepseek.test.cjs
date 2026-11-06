const {test} = require("node:test");
const assert = require("node:assert/strict");
const {prepareQuestion,askDeepSeek} = require("../dist/test/deepseek.cjs");
const item = {kind:"selection", relativePath:"src/sample.ts", range:{startLine:4},content:"export const limit = 7;"};
const question = prepareQuestion("Explain limit",[item]);
test("sharing rejects excluded files, sensitive prompts and oversized context",()=>{
  for(const change of [{relativePath:".env"},{content:"a".repeat(33000)},{kind:"gitDiff"}]) assert.throws(()=>prepareQuestion("Explain",[{...item,...change}]));
  assert.throws(()=>prepareQuestion("password=abcdefghijklmnop",[item]));
});
test("provider failures stay visible",async t=>{
  t.mock.method(globalThis,"fetch", async()=>({ok:false,status:401}));
  await assert.rejects(askDeepSeek("test",question,undefined),/HTTP 401/);
});
test("provider stream validates references and requires usage",async t=>{
  let line=4, usage={prompt_tokens:12,completion_tokens:5};
  t.mock.method(globalThis,"fetch",async()=>{
    const args=JSON.stringify({answer:"Seven",citations:[{path:item.relativePath,line}]});
    const frame={choices:[{delta:{tool_calls:[{index:0,function:{name:"present_answer",arguments:args}}]}}],usage};
    return new globalThis.Response("data: "+JSON.stringify(frame)+"\n\ndata: [DONE]\n\n");
  });
  assert.match(await askDeepSeek("test",question,undefined),/src\/sample.ts:4[\s\S]*12 input/);
  line=1; await assert.rejects(askDeepSeek("test",question,undefined),/outside/);
  usage=undefined; await assert.rejects(askDeepSeek("test",question,undefined),/accounting/);
});
