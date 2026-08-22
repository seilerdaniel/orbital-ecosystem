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

## License

[MIT](LICENSE)
