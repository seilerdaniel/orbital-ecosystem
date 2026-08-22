/**
 * Orbital Dock — Space Control entrypoint.
 *
 * Wires the bridge WebSocket link into the local Pulse bus, validates every
 * frame with Sentinel, feeds token telemetry, and repaints the live
 * dashboard. Runs until interrupted; a downed bridge degrades to
 * DISCONNECTED instead of crashing.
 */

import type { AnyOrbitalEvent } from "@orbital/bridge";
import { Pulse } from "@orbital/pulse";
import { PreFlightRunner, Sentinel } from "@orbital/sentinel";
import { BridgeLink } from "./bridge-link.js";
import { Dashboard } from "./dashboard.js";
import { TokenTelemetry } from "./telemetry.js";
import {
  ContentFactory,
  MemoryPanel,
  PreflightPanel,
  SecurityRadar
} from "./widgets.js";

const sessionId = globalThis.crypto.randomUUID();
const pulse = new Pulse();
const sentinel = new Sentinel();
const telemetry = new TokenTelemetry();
const radar = new SecurityRadar();
const factory = new ContentFactory();
const memory = new MemoryPanel();
const preflight = new PreflightPanel();
const dashboard = new Dashboard();
let rejectedBySentinel = 0;

// Pre-Flight: background test suite for the audited project; results land
// back on the bus as preflight.reported and drive the health badge.
const preflightRunner =
  process.env.ORBITAL_PREFLIGHT_OFF === "1"
    ? undefined
    : new PreFlightRunner(
        process.env.ORBITAL_PREFLIGHT_INTERVAL_MS === undefined
          ? {}
          : { intervalMs: Number(process.env.ORBITAL_PREFLIGHT_INTERVAL_MS) }
      );

// Remote frames re-enter through the same bus as local emissions, so any
// in-dock subscriber observes one uniform OrbitalEvent stream.
const bridgeLink = new BridgeLink((event) => {
  try {
    pulse.relay(event);
  } catch {
    // Malformed envelopes are already tallied by the link.
  }
});

function handleEvent(event: AnyOrbitalEvent): void {
  const report = sentinel.inspect(event);

  if (!report.valid) {
    rejectedBySentinel += 1;
    dashboard.record(event, true);

    return;
  }

  telemetry.observe(event);
  radar.observe(event);
  factory.observe(event);
  memory.observe(event);
  preflight.observe(event);
  dashboard.record(event);
}

pulse.subscribe(handleEvent);

function paint(): void {
  const stats = bridgeLink.stats();

  dashboard.render(
    { ...stats, rejected: stats.rejected + rejectedBySentinel },
    telemetry.snapshot(),
    radar.snapshot(),
    factory.snapshot(),
    memory.snapshot(),
    preflight.snapshot()
  );
}

let closing = false;

async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }

  closing = true;

  // Flows through the bus so the feed shows the session bookend too.
  pulse.emit(
    "session.completed",
    "dock",
    { sessionId, outcome: "success" },
    { correlationId: sessionId }
  );

  await bridgeLink.close();
  preflightRunner?.close();
  paint();
  console.log(`\n[dock] received ${signal}; Space Control offline.`);
  process.exit(0);
}

console.log("[dock] Space Control starting; connecting to orbital-bridge…");

pulse.emit("session.started", "dock", { sessionId, actor: "local-user" });

bridgeLink.start();
preflightRunner?.start();
setInterval(paint, 1_000).unref();
paint();

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
