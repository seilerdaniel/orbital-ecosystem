import {
  createOrbitalEvent,
  isOrbitalEvent,
  type AnyOrbitalEvent,
  type OrbitalEvent,
  type OrbitalEventPayloadMap,
  type OrbitalEventSource,
  type OrbitalEventType
} from "@orbital/bridge";

export type PulseListener = (event: AnyOrbitalEvent) => void;

/**
 * Minimal in-memory pub/sub bus for OrbitalEvent envelopes.
 * Transport adapters (IPC, WebSocket, message queue) can wrap this class
 * without changing producer or consumer code.
 */
export class Pulse {
  private readonly listeners = new Set<PulseListener>();

  subscribe(listener: PulseListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  emit<TType extends OrbitalEventType>(
    type: TType,
    source: OrbitalEventSource,
    payload: OrbitalEventPayloadMap[TType],
    options: { correlationId?: string; metadata?: Record<string, string | number | boolean> } = {}
  ): OrbitalEvent<OrbitalEventPayloadMap[TType]> {
    const event = createOrbitalEvent<TType>({
      type,
      source,
      payload,
      ...options
    });

    // Safe: createOrbitalEvent guarantees the payload matches the map entry,
    // so the runtime value satisfies exactly one union member. This cast only
    // works around TypeScript's deferred-distribution limit on generics.
    this.dispatch(event as AnyOrbitalEvent);

    return event;
  }

  /** Re-publishes an event received from an external transport after validation. */
  relay(event: unknown): OrbitalEvent {
    if (!isOrbitalEvent(event)) {
      throw new TypeError("Pulse.relay received a value that is not a valid OrbitalEvent");
    }

    this.dispatch(event as AnyOrbitalEvent);

    return event;
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }

  private dispatch(event: AnyOrbitalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
