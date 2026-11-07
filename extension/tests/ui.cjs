const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const { DemoController } = require("../dist/test/demo.cjs");
const { renderHtml } = require("../dist/test/html.cjs");

async function run() {
  const artifactDir = path.resolve(__dirname, "../.test-work/screenshots"); fs.mkdirSync(artifactDir, { recursive: true });
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); return res.end(renderHtml({ nonce: "fixtureNonce", cspSource: "'self'", scriptUri: "/media/index.js", styleUri: "/media/index.css" })); }
    if (req.url === "/media/index.js" || req.url === "/media/index.css") {
      res.setHeader("Content-Type", req.url.endsWith(".js") ? "text/javascript" : "text/css"); return res.end(fs.readFileSync(path.resolve(__dirname, "..", req.url.slice(1))));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const executablePath = process.env.TEST_BROWSER_EXECUTABLE || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
  let browser; const controllers = [];
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 380, height: 850 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    let active;
    const sent = [];
    const {ChatSessions}=require("../dist/test/sessions.cjs");
    const data=new Map();const sessions=new ChatSessions({get:k=>data.get(k),update:async(k,v)=>data.set(k,globalThis.structuredClone(v))});
    async function sync(viewId,notice="") {
      const state=await sessions.snapshot("fixture");
      await page.evaluate(value=>window.postMessage(value,"*"),{type:"live.state",viewId,scopeId:"fixture",session:state.sessions.find(s=>s.id===state.current),history:state.sessions.map(s=>({id:s.id,title:s.title,updated:s.updated})),providers:[{provider:"DeepSeek",model:"fixture",source:"saved"},{provider:"OpenRouter",model:"fixture",source:"missing"}],notice});
    }
    await page.exposeFunction("previewSend",async message=>{
      if(message.type==="live.init")return sync(message.viewId);
      if(message.type==="live.session"){
        await sessions.select("fixture",message.action,message.sessionId,message.action==="rename"?"Renamed chat":undefined);return sync(message.viewId);
      }
      if(message.type==="live.key")return sync(message.viewId,"Key settings updated.");
      if(message.type!=="live.ask")return active.receive(message);
      sent.push(message);
      const run=await sessions.begin("fixture",message.sessionId,message.revision,message.requestId,{role:"user",text:message.prompt});
      await sessions.finish("fixture",message.sessionId,run.runId,{role:"assistant",text:"Offline UI transport check"},"completed");
      return sync(message.viewId);
    });
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.previewSend(message), getState: () => JSON.parse(sessionStorage.getItem("previewDraft") || "null"), setState: (value) => sessionStorage.setItem("previewDraft", JSON.stringify(value)) });
    });
    active = new DemoController((message) => { void page.evaluate((value) => window.postMessage(value, "*"), message).catch(() => {}); }, "AI-CODING-AGENT", false);
    controllers.push(active);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText("AI-CODING-AGENT", { exact: true }).waitFor();
    await page.getByRole("button",{name:"Send",exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector(".va-top button") && document.querySelector(".va-work small").textContent==="Ready");
    await page.getByLabel("Question").fill("hii");
    await page.getByLabel("Question").press("Enter");
    await page.getByRole("log").filter({hasText: /Tokens:|Offline UI transport check/}).waitFor();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].provider, "DeepSeek");
    await page.setViewportSize({width:280,height:700});
    const picker = page.getByRole("combobox",{name:/Provider:/});
    await picker.click();
    const menu = page.getByRole("listbox");
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x+bounds.width <= 280 && bounds.y >= 0 && bounds.y+bounds.height <= (await picker.boundingBox()).y);
    await page.screenshot({path:path.join(artifactDir,"provider-picker.png")});
    await picker.press("Escape");
    assert.equal(await menu.count(),0);
    await picker.press("ArrowDown");
    await picker.press("End");
    await picker.press("Enter");
    await page.getByLabel("Question").fill("second question");
    await page.getByRole("button", {name:"Send",exact:true}).click();
    await page.getByRole("log").filter({hasText:"Offline UI transport check"}).waitFor();
    assert.equal(sent[1].provider, "OpenRouter");
    assert.equal(sent[1].sessionId,sent[0].sessionId);
    assert.notEqual(sent[1].requestId,sent[0].requestId);
    assert.ok(sent[1].revision>sent[0].revision);
    await page.locator(".va-turn.assistant").nth(1).waitFor();
    await page.getByRole("button",{name:"Review",exact:true}).click();
    await page.getByRole("button",{name:"Back to chat",exact:false}).click();
    assert.equal(await page.locator(".va-turn").count(),4);
    await page.getByRole("button",{name:"Keys",exact:true}).click();
    await page.getByRole("button",{name:"Set or replace key"}).waitFor();
    await picker.click();
    await page.getByRole("option",{name:"DeepSeek"}).click();
    assert.equal(await picker.getAttribute("aria-label"),"Provider: DeepSeek");
    await page.getByRole("button",{name:"Back to chat"}).click();
    await page.getByRole("button",{name:"Usage",exact:true}).click();
    await page.getByText("Provider-reported tokens for this chat").waitFor();
    await page.getByRole("button",{name:"Back to chat"}).click();
    await page.screenshot({path:path.join(artifactDir,"banani-chat.png")});
    await page.getByRole("button",{name:"New chat"}).click();
    await page.getByRole("button",{name:"History",exact:true}).click();
    await page.getByRole("button",{name:"hii",exact:true}).click();
    assert.equal(await page.locator(".va-turn").count(),4);
    await page.evaluate(()=>sessionStorage.clear());
    await page.reload();
    await page.locator(".va-turn").nth(3).waitFor();
    assert.equal(await page.locator(".va-turn").count(),4);
    await page.getByRole("button",{name:"History",exact:true}).click();
    await page.getByRole("button",{name:"Current: hii",exact:true}).click();
    await page.setViewportSize({ width: 280, height: 700 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByLabel("Question").focus();
    assert.equal(await page.getByLabel("Question").evaluate((node) => node === document.activeElement), true);
    await page.emulateMedia({ forcedColors: "active" });
    await page.screenshot({ path: path.join(artifactDir, "high-contrast-narrow.png") });
    const blocked = await page.evaluate(async () => { try { await fetch("http://127.0.0.1:1/not-allowed"); return false; } catch { return true; } });
    assert.equal(blocked, true);
    assert.deepEqual(errors, []);
    assert.ok(requests.every((url) => ["/", "/media/index.js", "/media/index.css", "/favicon.ico"].includes(url)));
    console.log("UI PASS: default live chat, optional attachments, provider selection, keyboard send/focus, narrow/high contrast, CSP. Screenshots:", artifactDir);
  } finally {
    controllers.forEach((controller) => controller.dispose());
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
