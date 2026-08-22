import { isOrbitalEvent, OrbitalEventTypes, type AnyOrbitalEvent } from "@orbital/bridge";

export interface SentinelViolation {
  readonly code: "invalid-envelope" | "unknown-type" | "future-timestamp";
  readonly message: string;
}

export interface SentinelReport {
  readonly valid: boolean;
  readonly violations: readonly SentinelViolation[];
}

/**
 * Validates OrbitalEvent envelopes before they are persisted or forwarded.
 * Deliberately stateless: compose policies at the call site.
 */
export class Sentinel {
  /** Maximum allowed clock skew (ms) between emitter and validator. */
  private readonly maxClockSkewMs: number;

  constructor(maxClockSkewMs = 5 * 60 * 1000) {
    this.maxClockSkewMs = maxClockSkewMs;
  }

  inspect(candidate: unknown): SentinelReport {
    const violations: SentinelViolation[] = [];

    if (!isOrbitalEvent(candidate)) {
      return {
        valid: false,
        violations: [
          { code: "invalid-envelope", message: "Value does not satisfy the OrbitalEvent contract" }
        ]
      };
    }

    const event = candidate as AnyOrbitalEvent;

    if (!(OrbitalEventTypes as readonly string[]).includes(event.type)) {
      violations.push({
        code: "unknown-type",
        message: `Event type "${event.type}" is not part of the well-known catalog`
      });
    }

    if (Date.parse(event.occurredAt) > Date.now() + this.maxClockSkewMs) {
      violations.push({
        code: "future-timestamp",
        message: `Event timestamp ${event.occurredAt} is too far in the future`
      });
    }

    return { valid: violations.length === 0, violations };
  }
}
