const path = require("node:path");
const fs = require("node:fs");
const { runTests } = require("@vscode/test-electron");
async function main() {
  const root = path.resolve(__dirname, "..");
  const work = path.join(root, ".test-work", "host"); fs.mkdirSync(work, { recursive: true });
  const userSettings = path.join(work, "profile", "User"); fs.mkdirSync(userSettings, { recursive: true });
  fs.writeFileSync(path.join(userSettings, "settings.json"), JSON.stringify({ "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false, "workbench.startupEditor": "none" }));
  const executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === "win32" ? "C:/Users/ASUS/AppData/Local/Programs/Microsoft VS Code/Code.exe" : undefined);
  await runTests({
    ...(executable ? { vscodeExecutablePath: executable } : {}),
    extensionDevelopmentPath: process.env.TEST_EXTENSION_PATH || root, extensionTestsPath: path.join(root, "dist/host-suite.cjs"),
    launchArgs: ["--user-data-dir", path.join(work, "profile"), "--extensions-dir", path.join(work, "extensions"), "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--disable-updates"],
  });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
