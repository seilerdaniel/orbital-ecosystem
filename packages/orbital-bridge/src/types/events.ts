/**
 * OrbitalEvent contract.
 *
 * Every cross-component signal in the Orbital ecosystem travels as an
 * immutable, self-describing envelope. Producers and consumers only agree
 * on this shape; transport (IPC, HTTP, message bus) is an implementation
 * detail owned by the bridge adapters.
 */

export const ORBITAL_EVENT_SCHEMA_VERSION = "1.0" as const;

/**
 * Canonical identifiers for every component allowed to emit events.
 * Values mirror the workspace layout of the monorepo.
 */
export const OrbitalEventSources = [
  "dock",
  "mobile",
  "cli",
  "bridge",
  "vault",
  "pulse",
  "forge",
  "sentinel",
  "synapse",
  "external"
] as const;

export type OrbitalEventSource = (typeof OrbitalEventSources)[number];

/**
 * Well-known event types using a `domain.action` naming convention.
 * Extend this union when introducing new signals; consumers can then
 * narrow exhaustively with a switch statement.
 */
export const OrbitalEventTypes = [
  "session.started",
  "session.completed",
  "task.dispatched",
  "task.progressed",
  "task.completed",
  "task.failed",
  "artifact.created",
  "vault.unlocked",
  "vault.locked",
  "health.reported",
  "policy.violated",
  "agent.completed",
  "token.alert.raised"
] as const;

export type OrbitalEventType = (typeof OrbitalEventTypes)[number];

export interface SessionStartedPayload {
  readonly sessionId: string;
  readonly actor: string;
}

export interface SessionCompletedPayload {
  readonly sessionId: string;
  readonly outcome: "success" | "aborted" | "failed";
}

export interface TaskDispatchedPayload {
  readonly taskId: string;
  readonly title: string;
}

export interface TaskProgressedPayload {
  readonly taskId: string;
  /** Percentage 0-100. */
  readonly progress: number;
}

export interface TaskCompletedPayload {
  readonly taskId: string;
  readonly durationMs: number;
}

export interface TaskFailedPayload {
  readonly taskId: string;
  readonly reason: string;
}

export interface ArtifactCreatedPayload {
  readonly artifactId: string;
  readonly path: string;
}

export interface VaultTransitionPayload {
  readonly vaultId: string;
}

export interface HealthReportedPayload {
  readonly component: OrbitalEventSource;
  readonly healthy: boolean;
}

export interface PolicyViolatedPayload {
  readonly policy: string;
  readonly detail: string;
}

/** Emitted by the pulse gateway after an LLM request finishes successfully. */
export interface AgentCompletedPayload {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  /** Routing tier that served the request. */
  readonly tier: "fast" | "frontier";
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Emitted when a provider's token consumption crosses the alert threshold.
 * (Contract name for the gateway's TOKEN_USAGE_ALERT signal.)
 */
export interface TokenAlertRaisedPayload {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly totalTokens: number;
  readonly thresholdTokens: number;
}

/**
 * Maps every event type to its strongly typed payload. Consumers get
 * exhaustive, compile-time-safe payloads via {@link TypedOrbitalEvent}.
 */
export interface OrbitalEventPayloadMap {
  "session.started": SessionStartedPayload;
  "session.completed": SessionCompletedPayload;
  "task.dispatched": TaskDispatchedPayload;
  "task.progressed": TaskProgressedPayload;
  "task.completed": TaskCompletedPayload;
  "task.failed": TaskFailedPayload;
  "artifact.created": ArtifactCreatedPayload;
  "vault.unlocked": VaultTransitionPayload;
  "vault.locked": VaultTransitionPayload;
  "health.reported": HealthReportedPayload;
  "policy.violated": PolicyViolatedPayload;
  "agent.completed": AgentCompletedPayload;
  "token.alert.raised": TokenAlertRaisedPayload;
}

/** Primitive metadata values allowed on the envelope. */
export type OrbitalEventMetadataValue = string | number | boolean;

export interface OrbitalEvent<TPayload = unknown> {
  /** Unique event id (UUID v4). */
  readonly id: string;
  /** Event type from the well-known catalog. */
  readonly type: string;
  /** Emitting component. */
  readonly source: string;
  /** ISO-8601 UTC timestamp of when the event occurred. */
  readonly occurredAt: string;
  /** Contract version, see ORBITAL_EVENT_SCHEMA_VERSION. */
  readonly schemaVersion: string;
  /** Optional identifier linking related events into one trace. */
  readonly correlationId?: string;
  /** Type-specific payload. */
  readonly payload: TPayload;
  /** Optional flat metadata bag for observability fields. */
  readonly metadata?: Readonly<Record<string, OrbitalEventMetadataValue>>;
}

/**
 * An OrbitalEvent whose payload is narrowed by its concrete event type.
 *
 * @example
 * function handle(event: TypedOrbitalEvent<"task.failed">): void {
 *   console.log(event.payload.taskId, event.payload.reason);
 * }
 */
export type TypedOrbitalEvent<TType extends OrbitalEventType> = OrbitalEvent<
  OrbitalEventPayloadMap[TType]
>;

/** Any event validated against the payload map. */
export type AnyOrbitalEvent = {
  [TType in OrbitalEventType]: TypedOrbitalEvent<TType>;
}[OrbitalEventType];

export interface CreateOrbitalEventOptions<TPayload> {
  readonly type: OrbitalEventType;
  readonly source: OrbitalEventSource;
  readonly payload: TPayload;
  readonly correlationId?: string;
  readonly metadata?: Record<string, OrbitalEventMetadataValue>;
  readonly occurredAt?: Date;
  readonly id?: string;
}

/**
 * Creates a fully populated {@link OrbitalEvent}, generating the id and
 * timestamp unless explicitly overridden.
 */
export function createOrbitalEvent<TType extends OrbitalEventType>(
  options: CreateOrbitalEventOptions<OrbitalEventPayloadMap[TType]>
): TypedOrbitalEvent<TType> {
  return {
    id: options.id ?? globalThis.crypto.randomUUID(),
    type: options.type,
    source: options.source,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    schemaVersion: ORBITAL_EVENT_SCHEMA_VERSION,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    payload: options.payload,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata })
  };
}

/**
 * Structural guard for untrusted input (IPC messages, network frames).
 * Validates the envelope shape; payload contents stay event-type specific.
 */
export function isOrbitalEvent(value: unknown): value is OrbitalEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.type === "string" &&
    (OrbitalEventTypes as readonly string[]).includes(candidate.type) &&
    typeof candidate.source === "string" &&
    (OrbitalEventSources as readonly string[]).includes(candidate.source) &&
    typeof candidate.occurredAt === "string" &&
    !Number.isNaN(Date.parse(candidate.occurredAt)) &&
    candidate.schemaVersion === ORBITAL_EVENT_SCHEMA_VERSION &&
    "payload" in candidate &&
    hasValidMetadata(candidate.metadata)
  );
}

function hasValidMetadata(metadata: unknown): boolean {
  if (metadata === undefined) {
    return true;
  }

  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return false;
  }

  return Object.values(metadata).every(
    (entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
  );
}
