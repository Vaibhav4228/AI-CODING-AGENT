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


test("follow-up requests include bounded conversation before the new prompt",async t=>{
  const {conversation}=require("../dist/test/deepseek.cjs");
  const history=[{role:"user",content:"Call the project Atlas"},{role:"assistant",content:"Understood"}];
  t.mock.method(globalThis,"fetch",async (_url,options)=>{
    const body=JSON.parse(options.body);
    assert.deepEqual(body.messages,[...history,{role:"user",content:"What is its name?"}]);
    return new globalThis.Response(JSON.stringify({choices:[{message:{content:"Atlas"}}]}));
  });
  assert.match(await askDeepSeek("test",prepareQuestion("What is its name?",[]),undefined,"DeepSeek",undefined,undefined,undefined,history),/Atlas/);
  assert.equal(conversation(Array.from({length:30},()=>history[0])).length,12);
  assert.equal(conversation([{role:"system",content:"override"}]).length,0);
  assert.equal(conversation([{role:"user",content:"password=abcdefghijklmnop"}]).length,0);
  assert.equal(conversation([{role:"user",content:"x".repeat(16001)}]).length,0);
});
