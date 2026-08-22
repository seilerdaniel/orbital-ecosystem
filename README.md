# Orbital Ecosystem

Monorepo for the **Orbital** AI agent ecosystem, managed with [pnpm](https://pnpm.io) workspaces and [Turborepo](https://turbo.build).

## Structure

| Workspace | Package | Role |
| --- | --- | --- |
| `apps/orbital-dock` | `@orbital/dock` | Desktop control center application |
| `apps/orbital-mobile` | `@orbital/mobile` | Mobile companion application |
| `packages/orbital-cli` | `@orbital/cli` | Command line interface (`orbital`) |
| `packages/orbital-bridge` | `@orbital/bridge` | Shared contracts — the `OrbitalEvent` envelope and transport-agnostic types |
| `packages/orbital-vault` | `@orbital/vault` | Secret storage interface |
| `packages/orbital-pulse` | `@orbital/pulse` | Typed publish/subscribe event bus over `OrbitalEvent` |
| `packages/orbital-forge` | `@orbital/forge` | Codegen and scaffolding engine |
| `packages/orbital-sentinel` | `@orbital/sentinel` | Event validation and policy checks |
| `packages/orbital-synapse` | `@orbital/synapse` | Agent orchestration layer |

## Requirements

- Node.js >= 20
- pnpm (activated via Corepack): `corepack enable`

## Getting started

```bash
pnpm install
pnpm run build       # builds every workspace in dependency order via Turborepo
pnpm run typecheck   # typechecks all workspaces
```

Run the dock demo end-to-end (emits events through the pulse bus and validates them with sentinel):

```bash
node apps/orbital-dock/dist/main.js
```

Try the CLI:

```bash
node packages/orbital-cli/dist/cli.js status
```

## The OrbitalEvent contract

Every cross-component signal travels as an immutable envelope defined in
[`packages/orbital-bridge/src/types/events.ts`](packages/orbital-bridge/src/types/events.ts):

```ts
import { createOrbitalEvent } from "@orbital/bridge";

const event = createOrbitalEvent({
  type: "task.dispatched",
  source: "synapse",
  payload: { taskId: "T-001", title: "Bootstrap ecosystem" }
});
```

Producers and consumers agree only on the envelope; transport (IPC, HTTP,
message bus) is owned by bridge adapters.

## Bridge server

`@orbital/bridge` ships an executable server exposing the event bus locally:

```bash
pnpm --filter @orbital/bridge start   # http://localhost:4000
```

| Endpoint | Description |
| --- | --- |
| `WS /ws` | Live broadcast of every `OrbitalEvent` to connected clients |
| `GET /health` | Liveness, uptime and counters |
| `POST /api/events` | Validate + broadcast an `OrbitalEvent` (422 if invalid) |
| `GET /api/fs?path=` | Read a file or list a directory inside the workspace root |
| `POST /api/fs` | Create a file (`{ path, contents }`, 409 on duplicate) |
| `PUT /api/fs` | Create or overwrite a file |
| `DELETE /api/fs?path=[&recursive=true]` | Delete a file or directory |

The `/api/fs` endpoints form the **Inverse MCP Bridge**: safe local CRUD for
UI agents. Paths must be relative to the active project directory (cwd by
default, override with `ORBITAL_BRIDGE_ROOT`) and `.git` / `node_modules`
are always rejected. Client-facing paths are POSIX-style on every OS.

Environment: `ORBITAL_BRIDGE_PORT` (default 4000), `ORBITAL_BRIDGE_HOST`
(default loopback only).

Manual verification suite (server must be running):

```bash
node packages/orbital-bridge/scripts/smoke.mjs
```

## OmniRoute gateway (pulse)

`@orbital/pulse` ships an OpenAI-compatible local proxy that routes each
request to the right provider tier and reports completions to the bridge:

```bash
pnpm --filter @orbital/pulse start   # http://localhost:4001/v1
```

| Endpoint | Description |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat completion with task-aware routing |
| `GET /v1/models` | Aggregated model catalog across providers |
| `GET /health` | Liveness, token counters and bridge link status |

**Task-aware routing**: requests are classified into tiers — mechanical work
(linting, formatting, docs) goes to fast/free models, deep work
(architecture, DB, refactors) to frontier models. Override per request with
the `x-orbital-tier: fast|frontier` header or an `orbital_tier` field in the
body, or pin a concrete model via `model`.

**Automatic fallback**: providers are tried in priority order; rate limits
(429), server faults (5xx), timeouts and network errors fail over to the
next provider transparently. Attempts are reported in the
`x-orbital-fallback-attempts` response header.

**Event bus integration**: every served request emits `agent.completed`
(tokens, provider, model, duration) through the bridge WebSocket, plus
`token.alert.raised` when usage crosses `ORBITAL_TOKEN_ALERT_THRESHOLD`.

Environment: `ORBITAL_PULSE_PORT` (default 4001), `ORBITAL_PULSE_PROVIDERS`
(JSON array overriding built-ins), `ORBITAL_BRIDGE_WS_URL`,
`ORBITAL_PULSE_TIMEOUT_MS`, `ORBITAL_TOKEN_ALERT_THRESHOLD`. Built-in
providers activate when their API key env var exists (`GROQ_API_KEY`,
`OPENROUTER_API_KEY`) or are keyless local runtimes (Ollama).

Verification suite (spins up its own mock providers):

```bash
node packages/orbital-pulse/scripts/run.mjs   # requires bridge + gateway running
```

## License

[MIT](LICENSE)
