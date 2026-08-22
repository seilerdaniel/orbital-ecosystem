/**
 * Live event tail over the bridge WebSocket. Used by the wizard to list
 * recent Sentinel/Pulse traffic without any persistence requirement: the
 * bridge is the source of truth and events are observed in flight.
 */

import { WebSocket } from "ws";

export interface TailEvent {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly detail: string;
}

export interface TailOptions {
  /** Full WS endpoint; defaults to ws://127.0.0.1:4000/ws */
  readonly url?: string;
  /** Keep events whose `source` matches one of these prefixes (default sentinel/pulse). */
  readonly sources?: readonly string[];
  /** How long to listen before returning. */
  readonly durationMs?: number;
  readonly onEvent?: (event: TailEvent) => void;
}

const DEFAULT_SOURCES = ["sentinel", "pulse"] as const;

function describePayload(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }

  const record = payload as Record<string, unknown>;

  for (const key of ["detail", "reason", "summary", "taskId", "artifactId", "policy"]) {
    const value = record[key];

    if (typeof value === "string" && value !== "") {
      return value;
    }
  }

  return "";
}

function toTailEvent(frame: unknown): TailEvent | undefined {
  if (typeof frame !== "object" || frame === null) {
    return undefined;
  }

  const record = frame as Record<string, unknown>;

  if (
    typeof record["id"] !== "string" ||
    typeof record["type"] !== "string" ||
    typeof record["source"] !== "string" ||
    typeof record["occurredAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    id: record["id"],
    type: record["type"],
    source: record["source"],
    occurredAt: record["occurredAt"],
    detail: describePayload(record["payload"])
  };
}

export function formatTailEvent(event: TailEvent): string {
  const time = event.occurredAt.slice(11, 19);
  const detail = event.detail === "" ? "" : `  ${event.detail}`;

  return `[${time}] ${event.source.padEnd(8)} ${event.type}${detail}`;
}

/** Connects, listens for {@link TailOptions.durationMs}, resolves with filtered events. */
export function collectRecentEvents(options: TailOptions = {}): Promise<TailEvent[]> {
  const url = options.url ?? process.env.ORBITAL_BRIDGE_WS_URL ?? "ws://127.0.0.1:4000/ws";
  const durationMs = options.durationMs ?? 6000;
  const prefixes = options.sources ?? DEFAULT_SOURCES;
  const collected: TailEvent[] = [];

  return new Promise((resolve) => {
    let socket: WebSocket;

    try {
      socket = new WebSocket(url);
    } catch {
      resolve(collected);

      return;
    }

    const finish = (): void => {
      socket.removeAllListeners();
      socket.terminate();
      resolve(collected);
    };

    const timer = setTimeout(finish, durationMs);

    socket.on("message", (data) => {
      // Link-level handshake frames are not bus traffic.
      if (data.toString().includes('"kind":"connection"')) {
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      const event = toTailEvent(parsed);

      if (event === undefined) {
        return;
      }

      if (!prefixes.some((prefix) => event.source.startsWith(prefix))) {
        return;
      }

      collected.push(event);
      options.onEvent?.(event);
    });

    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
