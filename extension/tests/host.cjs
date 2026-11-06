const path = require("node:path");
const fs = require("node:fs");
const { runTests } = require("@vscode/test-electron");
async function main() {
  const root = path.resolve(__dirname, "..");
  const work = path.join(root, ".test-work", "host"); fs.mkdirSync(work, { recursive: true });
  const userSettings = path.join(work, "profile", "User"); fs.mkdirSync(userSettings, { recursive: true });
  fs.writeFileSync(path.join(userSettings, "settings.json"), JSON.stringify({ "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false, "workbench.startupEditor": "none" }));
  const executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === "win32" ? "C:/Users/ASUS/AppData/Local/Programs/Microsoft VS Code/Code.exe" : undefined);
  const fixture = fs.mkdtempSync(path.join(work, "workspace-"));
  const nested = path.join(fixture, "src");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "sample.ts"), "export const price = 10;\n");
  fs.writeFileSync(path.join(fixture, ".env"), "PRIVATE=value");
  fs.writeFileSync(path.join(fixture, "binary.dat"), "a\0b");
  const git = (...args) => require("node:child_process").execFileSync("git", ["-C", fixture, ...args]);
  git("init", "--quiet");
  git("add", "src/sample.ts");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture");
  fs.writeFileSync(path.join(nested, "sample.ts"), "export const price = 20;\n");
  fs.symlinkSync(nested, path.join(fixture, "linked"), process.platform === "win32" ? "junction" : "dir");
  await runTests({
    ...(executable ? { vscodeExecutablePath: executable } : {}),
    extensionDevelopmentPath: process.env.TEST_EXTENSION_PATH || root, extensionTestsPath: path.join(root, "dist/host-suite.cjs"),
    launchArgs: [fixture, "--user-data-dir", path.join(work, "profile"), "--extensions-dir", path.join(work, "extensions"), "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--disable-updates"],
  });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
