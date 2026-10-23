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
    await page.exposeFunction("previewSend", (message) => active.receive(message));
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.previewSend(message), getState: () => JSON.parse(sessionStorage.getItem("previewDraft") || "null"), setState: (value) => sessionStorage.setItem("previewDraft", JSON.stringify(value)) });
    });
    active = new DemoController((message) => { void page.evaluate((value) => window.postMessage(value, "*"), message).catch(() => {}); }, "AI-CODING-AGENT", false);
    controllers.push(active);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "Explore the workflow" }).waitFor();
    await page.getByText("AI-CODING-AGENT", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifactDir, "welcome.png") });
    await page.getByLabel("Ask the demo agent").fill("Keep this draft after reload");
    await page.reload();
    await page.getByText("AI-CODING-AGENT", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Ask the demo agent").inputValue(), "Keep this draft after reload");
    await page.getByRole("button", { name: "Preview a review step" }).click();
    await page.getByRole("button", { name: "Approve demo once" }).waitFor();
    await page.screenshot({ path: path.join(artifactDir, "approval.png") });
    await page.getByRole("button", { name: "Deny demo action" }).click();
    await page.getByText("Demo action denied. Nothing was executed.").waitFor();
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await page.getByRole("button", { name: "Try a failure state" }).click();
    await page.getByRole("alert").filter({ hasText: "Simulated provider unavailable" }).waitFor();
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await page.getByLabel("Ask the demo agent").fill('<img src=x onerror="window.__xss=true">');
    await page.getByLabel("Ask the demo agent").press("Control+Enter");
    await page.getByText("Demo complete", { exact: true }).waitFor();
    assert.equal(await page.locator(".message-body img").count(), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await page.getByLabel("Ask the demo agent").fill("Show cancellation");
    await page.getByRole("button", { name: "Send demo message" }).click();
    await page.getByRole("button", { name: "Stop demo" }).click();
    await page.getByText("Demo stopped. No files or commands were affected.").waitFor();
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await page.setViewportSize({ width: 280, height: 700 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByLabel("Ask the demo agent").focus();
    assert.equal(await page.getByLabel("Ask the demo agent").evaluate((node) => node === document.activeElement), true);
    await page.emulateMedia({ forcedColors: "active" });
    await page.screenshot({ path: path.join(artifactDir, "high-contrast-narrow.png") });
    const blocked = await page.evaluate(async () => { try { await fetch("http://127.0.0.1:1/not-allowed"); return false; } catch { return true; } });
    assert.equal(blocked, true);
    assert.deepEqual(errors, []);
    assert.ok(requests.every((url) => ["/", "/media/index.js", "/media/index.css", "/favicon.ico"].includes(url)));
    console.log("UI PASS: reload/draft, approval/deny, error, cancellation, keyboard send/focus, safe text, narrow/high contrast, CSP. Screenshots:", artifactDir);
  } finally {
    controllers.forEach((controller) => controller.dispose());
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
