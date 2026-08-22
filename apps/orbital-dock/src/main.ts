import type { AnyOrbitalEvent } from "@orbital/bridge";
import { Pulse } from "@orbital/pulse";
import { Sentinel } from "@orbital/sentinel";

const pulse = new Pulse();
const sentinel = new Sentinel();

pulse.subscribe((event: AnyOrbitalEvent) => {
  const report = sentinel.inspect(event);
  const status = report.valid
    ? "ok"
    : `rejected: ${report.violations.map((violation) => violation.code).join(", ")}`;

  console.log(`[dock] ${event.type} from ${event.source} [${status}]`);
});

console.log("Orbital Dock starting up...");

const sessionId = globalThis.crypto.randomUUID();

pulse.emit("session.started", "dock", {
  sessionId,
  actor: "local-user"
});

pulse.emit(
  "task.dispatched",
  "synapse",
  { taskId: "T-001", title: "Bootstrap ecosystem" },
  { correlationId: sessionId }
);

try {
  pulse.relay({ type: "not-a-real-event", payload: {} });
} catch (error) {
  console.log(`[dock] dropped external frame: ${(error as Error).message}`);
}

pulse.emit(
  "session.completed",
  "dock",
  { sessionId, outcome: "success" },
  { correlationId: sessionId }
);
