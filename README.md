# AI Coding Agent

Local-workspace-first coding agent under development. The existing code includes a tested local IPC/checkpoint foundation. A mocked VS Code/React sidebar is now installable. The sidebar can inspect a trusted local workspace. The live agent loop and command sandbox are planned.

## Development baseline

Verified on Windows with Node **24.20.0**, npm **11.19.0**, and Python **3.12.10**. Node/npm requirements are declared in `backend/package.json`; `.nvmrc` records the tested Node version. The project is not yet tested on other operating systems.

From the repository root in PowerShell:

```powershell
npm ci --prefix packages/protocol --ignore-scripts --no-audit --no-fund
Set-Location backend
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The committed `backend/.npmrc` currently uses `legacy-peer-deps=true`; peer compatibility remains technical debt. Lifecycle scripts are disabled during baseline installs. No Playwright browser download or application startup is required for the checks.

| Command (inside backend) | Purpose |
| --- | --- |
| `npm run typecheck` | Check source types without emitting JavaScript |
| `npm run lint` | ESLint checks; existing `any`/unused-variable debt is explicitly excluded |
| `npm run build` | Compile source without emitting on errors |
| `npm run start:built` | Launch the legacy server from dist using the existing alias loader; requires configured services |
| `npm test` | Build and run 21 offline baseline, protocol, storage and IPC tests |
| `npm run check` | Typecheck, lint, build and tests |
| `npm run inventory` | Print lockfile-based dependency/license metadata; no provider calls |

Tests do not start Express/MongoDB, execute shell tools, or contact LLM, embedding, JEV or Browserbase providers. Build output goes to ignored `backend/dist/`.

## VS Code preview (Step 2)

Install `extension/artifacts/workspace-agent-preview-0.0.1.vsix` via **Extensions > Install from VSIX**, then run **Workspace Agent: Open Preview**. Chat is scripted. Use Workspace context to inspect files, selections, diagnostics, saved Git diffs or bounded text searches locally. In a multi-root workspace choose a folder first. No provider receives this context.

From the repository root, after installing protocol and backend dependencies:

```powershell
npm ci --prefix extension --ignore-scripts --no-audit --no-fund
npm --prefix extension run check
npm --prefix extension run test:ui
npm --prefix extension run test:host
npm --prefix extension run package
```

See [extension setup](extension/README.md) and the local [Step 2 report](docs/STEP_2_REPORT.md). The UI/browser tests use disposable profiles; your normal VS Code/browser profile is not modified.

The selected provider direction is **DeepSeek R1**, not OpenAI. The root `.env.example` contains placeholders; put credentials only in the ignored local `.env`. Never paste keys into the demo composer. The preview does not load that file. Exact endpoint/model ID and tool support will be verified in Step 6; no silent model substitution is planned.

## Existing server: legacy development only

The current server still requires MongoDB, session/OAuth configuration and appropriate environment values. For later explicit server testing, copy `backend/env.example` to the ignored `backend/.env`, set local values and run `npm run dev` inside backend. Do not commit secrets. Do not expose the current upload/host-shell implementation publicly; its security gaps are documented in the architecture plan. Baseline checks deliberately do not launch it.

The optional Python gateway is heuristic-only, not a live JEV integration. Its dependencies are not installed or pinned by this baseline. It currently binds all interfaces and uses development reload when launched; do not expose it. Docker was not found on PATH during baseline inspection; isolated command execution is a future prerequisite, with read/propose mode planned when unavailable.

## Project documents

- [Implementation checklist](IMPLEMENTATION_STEPS.md)
- [Architecture, security and research plan](AI_AGENT_END_TO_END_PLAN.md)
- [Step 0 baseline results](docs/BASELINE_REPORT.md)
- [Step 1 runtime/protocol results](docs/STEP_1_REPORT.md)
- [Local IPC and checkpoint decision](docs/adr/0002-local-ipc-and-checkpoints.md)
- [Architecture decisions](docs/adr/0001-local-workspace-first.md)
- [Dependency metadata inventory](docs/DEPENDENCY_INVENTORY.json)
- [License and provenance status](docs/PROVENANCE.md)

No extension has been published. Do not reuse reference source/assets until their license permission is established.
