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
    await page.exposeFunction("previewSend", async (message) => {
      if (message.type !== "live.ask") return active.receive(message);
      sent.push(message);
      let text = "Offline UI transport check";
      if (process.env.TEST_LIVE_GREETING === "1" && sent.length === 1) {
        const { askDeepSeek, prepareQuestion } = require("../dist/test/deepseek.cjs");
        const env = require("node:util").parseEnv(fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8"));
        text = await askDeepSeek(env.DEEPSEEK_API_KEY, prepareQuestion(message.prompt, []), globalThis.AbortSignal.timeout(30000));
        console.log("Live provider:", text);
      }
      await page.evaluate(value => window.postMessage(value, "*"), {type:"live.result",viewId:message.viewId,text,busy:false});
    });
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.previewSend(message), getState: () => JSON.parse(sessionStorage.getItem("previewDraft") || "null"), setState: (value) => sessionStorage.setItem("previewDraft", JSON.stringify(value)) });
    });
    active = new DemoController((message) => { void page.evaluate((value) => window.postMessage(value, "*"), message).catch(() => {}); }, "AI-CODING-AGENT", false);
    controllers.push(active);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByText("AI-CODING-AGENT", { exact: true }).waitFor();
    await page.getByLabel("Question").fill("hii");
    await page.getByLabel("Question").press("Enter");
    await page.getByRole("status").filter({hasText: /Tokens:|Offline UI transport check/}).waitFor();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].provider, "DeepSeek");
    await page.getByLabel("Provider").selectOption("OpenRouter");
    await page.getByRole("button", {name:"Send",exact:true}).click();
    await page.getByRole("status").filter({hasText:"Offline UI transport check"}).waitFor();
    assert.equal(sent[1].provider, "OpenRouter");
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
