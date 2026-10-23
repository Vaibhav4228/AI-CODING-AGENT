# AI Coding Agent

Local-workspace-first coding agent under development. The existing code includes a tested local IPC/checkpoint foundation. The VS Code frontend, real agent loop, workspace tools and execution sandbox are still pending.

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
