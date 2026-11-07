# Workspace Agent — local development preview

Local VS Code coding-agent extension with DeepSeek/OpenRouter chat, reviewed native file proposals, local chat history and SecretStorage settings. Live tool continuation is still being integrated; the fixture runner is separate from the real provider path. See [Step 9A evidence](../docs/STEP_9A_REPORT.md).

## Build and check

Install dependencies for packages/protocol, backend (lint tooling) and extension using their committed lockfiles with `npm ci --ignore-scripts --no-audit --no-fund`. In extension, run `npm run check`. Build tools bundle all runtime dependencies and webview assets.

- `npm run test:ui`: headless UI tests with a separate Chrome instance and loopback fixture server. Set TEST_BROWSER_EXECUTABLE if Chrome is elsewhere; no personal browser profile is used.
- `npm run test:host`: actual VS Code extension development host with a separate local test profile. Set VSCODE_EXECUTABLE_PATH for the installed binary. This smoke test disables Workspace Trust only in its disposable test instance; it does not validate real trust permissions. The host suite uses an offline provider fixture to exercise the live controller.
- `npm run package`: produce `artifacts/workspace-agent-preview-0.0.1.vsix`. Install via Extensions > Install from VSIX, then run **Workspace Agent: Open Preview**.

The publisher `local-labs` is a development identifier, not a configured Marketplace account. Version range 1.100+ uses stable APIs but is only verified against the installed VS Code in the step report. No Marketplace publication or final license clearance is claimed. Remote and virtual workspaces are not supported.

All demo text is rendered as plain React text, not HTML or executable Markdown. CSP blocks webview network connections and arbitrary scripts. Transport tokens and provider credentials are not sent to the webview. The extension host persists folder-scoped conversations in workspaceState; API keys belong in Settings, not the composer.

Development mode can read the project root `.env`; saved SecretStorage keys take precedence. Packaged mode uses SecretStorage. Removing a key explicitly disables environment fallback; Settings can re-enable development environment use. Shared schemas validate the live session bridge.

### Isolated build and test commands (Windows)
Use Docker Desktop running a local Linux engine and pre-load the worker image with `docker pull node:24-alpine`. The worker command never pulls an image. Attach complete files including package.json and the files its script needs. Select **Run** in chat or **Vaibhav AI: Run Sandbox Command** in the Command Palette, choose npm test or npm run build, then review the snapshot and approve once.

The worker receives only the selected buffer contents. Node built-ins and npm are available; project dependencies must already be represented in the snapshot or the command may fail. The output channel records the command, snapshot hash, outcome and bounded output. Successful modifications to selected text files can be reviewed using native diffs. New artifacts, deleted files and changes to dirty buffers are not imported. No command runs on the host as a fallback.

To run live worker tests after Docker is available, set TEST_LINUX_WORKER=1 in the environment and run npm test inside extension. Offline tests exercise policy and the missing-worker path.


### Reference comparison and current live behavior

The local `cli-code-tool` reference combines persisted sessions with model tool calls, local tool results and model continuation. `Codex-ref` uses an agent with filesystem tools and a checkpointed conversation. Their orchestration is useful as a reference; their runtime dependencies and execution permissions are not copied into this extension.

The live extension now includes up to 12 prior messages / 16 KB in each follow-up request, validates roles and excludes credential-bearing messages. The host retains up to 20 folder-scoped chats using VS Code workspaceState, including the current conversation. This survives full IDE restarts. Interrupted runs are marked and never replayed automatically; full action recovery remains Step 10 work. Restored chats omit stale undo handles.

Settings opens a native password input to set or replace the selected provider's key. SecretStorage overrides development environment keys. Save success or failure is reflected in Settings. Implement proposes files in the selected workspace; each native review shows the complete destination before applying. Ask and Plan produce answers, and Prepare proposal switches to Implement.

The live provider path still uses a single response/file proposal. Completing the iterative read/plan/edit/test/model-result loop is Step 9. Docker execution still requires live validation before Step 8 can be called complete. These are remaining capabilities, not behavior supplied by the reference repositories automatically.


Run `npm run test:persistence` for a full restart/settings test in a separate VS Code profile with fake keys and no model calls. The current session coordinator supports one local IDE window. It does not coordinate simultaneous windows for the same folder.
