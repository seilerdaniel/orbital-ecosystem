/**
 * Widget accumulators for the Space Control panels.
 *
 * Same contract as TokenTelemetry: pure state machines fed validated
 * events through observe(), exposing immutable snapshots for the renderer.
 * No I/O and no ANSI concerns here — rendering stays in the dashboard.
 */

import type {
  AnyOrbitalEvent,
  OrbitalEventMetadataValue,
  TypedOrbitalEvent
} from "@orbital/bridge";

// ---------------------------------------------------------------------------
// Security Breach Radar (sentinel)
// ---------------------------------------------------------------------------

export interface RadarBreach {
  readonly policy: string;
  readonly detail: string;
  readonly source: string;
  readonly severity?: string;
  readonly at: Date;
}

export interface SecurityRadarSnapshot {
  readonly breaches: number;
  readonly last: RadarBreach | undefined;
}

export class SecurityRadar {
  private breaches = 0;
  private last: RadarBreach | undefined;

  observe(event: AnyOrbitalEvent): boolean {
    if (event.type !== "policy.violated") {
      return false;
    }

    const payload = (event as TypedOrbitalEvent<"policy.violated">).payload;
    const severity = readMetadata(event.metadata)["maxSeverity"];

    this.breaches += 1;
    this.last = {
      policy: payload.policy,
      detail: payload.detail,
      source: event.source,
      ...(typeof severity === "string" ? { severity } : {}),
      at: new Date()
    };

    return true;
  }

  snapshot(): SecurityRadarSnapshot {
    return {
      breaches: this.breaches,
      last: this.last === undefined ? undefined : { ...this.last }
    };
  }
}

function readMetadata(
  metadata: Readonly<Record<string, OrbitalEventMetadataValue>> | undefined
): Record<string, OrbitalEventMetadataValue> {
  return metadata ?? {};
}

// ---------------------------------------------------------------------------
// Content Factory feed (forge)
// ---------------------------------------------------------------------------

export type FactoryArtifactKind = "release-notes" | "demo-script" | "montage-project" | "artifact";

export interface FactoryArtifact {
  readonly name: string;
  readonly kind: FactoryArtifactKind;
  readonly at: Date;
}

export interface ContentFactorySnapshot {
  readonly builds: number;
  readonly recent: readonly FactoryArtifact[];
}

const FACTORY_KINDS: readonly [suffix: string, kind: FactoryArtifactKind][] = [
  ["RELEASE_NOTES.md", "release-notes"],
  ["DEMO_SCRIPT.md", "demo-script"],
  ["openmontage.project.json", "montage-project"]
];

function classify(path: string): FactoryArtifactKind {
  const name = path.split(/[\\/]/).pop() ?? path;

  for (const [suffix, kind] of FACTORY_KINDS) {
    if (name.endsWith(suffix)) {
      return kind;
    }
  }

  return "artifact";
}

export class ContentFactory {
  private builds = 0;
  private readonly recent: FactoryArtifact[] = [];
  private readonly capacity = 6;

  observe(event: AnyOrbitalEvent): boolean {
    // Only forge renders count here; other producers share the event type.
    if (event.type !== "artifact.created" || event.source !== "forge") {
      return false;
    }

    const payload = (event as TypedOrbitalEvent<"artifact.created">).payload;
    const name = payload.path.split(/[\\/]/).pop() ?? payload.path;

    this.builds += 1;
    this.recent.push({ name, kind: classify(payload.path), at: new Date() });

    if (this.recent.length > this.capacity) {
      this.recent.shift();
    }

    return true;
  }

  snapshot(): ContentFactorySnapshot {
    return {
      builds: this.builds,
      recent: this.recent.map((entry) => ({ ...entry }))
    };
  }
}

// ---------------------------------------------------------------------------
// Global Memory feed (synapse)
// ---------------------------------------------------------------------------

export interface StoredPattern {
  readonly patternId: string;
  readonly taskId: string;
  readonly receiptId: string;
  readonly at: Date;
}

export interface MemoryPanelSnapshot {
  readonly patterns: number;
  readonly last: StoredPattern | undefined;
}

export class MemoryPanel {
  private patterns = 0;
  private last: StoredPattern | undefined;

  observe(event: AnyOrbitalEvent): boolean {
    if (event.type !== "memory.pattern.stored") {
      return false;
    }

    const payload = (event as TypedOrbitalEvent<"memory.pattern.stored">).payload;

    this.patterns += 1;
    this.last = {
      patternId: payload.patternId,
      taskId: payload.taskId,
      receiptId: payload.receiptId,
      at: new Date()
    };

    return true;
  }

  snapshot(): MemoryPanelSnapshot {
    return {
      patterns: this.patterns,
      last: this.last === undefined ? undefined : { ...this.last }
    };
  }
}
