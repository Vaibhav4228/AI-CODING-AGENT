# Workspace Agent — local development preview

Independently branded VS Code UI shell. It demonstrates a conversation, mock activity, review/deny, cancellation and failure states. **There is no live AI connection, file read/write, upload or command execution.** DeepSeek R1 is the requested provider label; no model identifier or compatibility is assumed from that label.

## Build and check

Install dependencies for packages/protocol, backend (lint tooling) and extension using their committed lockfiles with `npm ci --ignore-scripts --no-audit --no-fund`. In extension, run `npm run check`. Build tools bundle all runtime dependencies and webview assets.

- `npm run test:ui`: headless UI tests with a separate Chrome instance and loopback fixture server. Set TEST_BROWSER_EXECUTABLE if Chrome is elsewhere; no personal browser profile is used.
- `npm run test:host`: actual VS Code extension development host with a separate local test profile. Set VSCODE_EXECUTABLE_PATH for the installed binary. This smoke test disables Workspace Trust only in its disposable test instance; it does not validate real trust permissions. Product mode remains mock-only in all workspaces.
- `npm run package`: produce `artifacts/workspace-agent-preview-0.0.1.vsix`. Install via Extensions > Install from VSIX, then run **Workspace Agent: Open Preview**.

The publisher `local-labs` is a development identifier, not a configured Marketplace account. Version range 1.100+ uses stable APIs but is only verified against the installed VS Code in the step report. No Marketplace publication or final license clearance is claimed. Remote and virtual workspaces are not supported.

All demo text is rendered as plain React text, not HTML or executable Markdown. CSP blocks webview network connections and arbitrary scripts. Transport tokens and provider credentials are not sent to the webview. Only draft text and the selected demo scenario persist in webview state; do not enter secrets into the demo composer.

The extension does not load `.env`. Future live-provider work must keep keys in the secured local runtime; set placeholders in the root `.env.example` only when requested. Exact R1 provider/model/tool compatibility still needs verification. Changes to the UI/session protocol must update the shared schemas and tests together.
