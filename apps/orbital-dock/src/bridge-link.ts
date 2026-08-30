/**
 * Inbound WebSocket link from the dock to the orbital-bridge event bus.
 *
 * Mirrors the outbound BridgeEventPublisher in @orbital/pulse: the link is
 * best-effort infrastructure, so a downed bridge never crashes the dock.
 * Frames are validated against the OrbitalEvent contract before delivery,
 * and reconnection uses exponential backoff with a ceiling.
 */

import { WebSocket } from "ws";
import { isOrbitalEvent, type OrbitalEvent } from "@orbital/bridge";

export interface BridgeLinkOptions {
  /** Full bridge endpoint, e.g. ws://127.0.0.1:4000/ws */
  readonly url?: string;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
}

export interface BridgeLinkStats {
  readonly connected: boolean;
  /** Valid OrbitalEvent frames handed to the consumer. */
  readonly received: number;
  /** Frames dropped for failing contract validation. */
  readonly rejected: number;
  readonly reconnects: number;
  readonly url: string;
}

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_URL = "ws://localhost:4000/ws";
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 8000;

export class BridgeLink {
  private readonly url: string;
  private readonly baseMs: number;
  private readonly maxMs: number;

  private socket: WebSocket | undefined;
  private reconnectTimer: Timer | undefined;

  private started = false;
  private closing = false;
  private attempts = 0;

  private received = 0;
  private rejected = 0;
  private reconnects = 0;

  constructor(
    private readonly onEvent: (event: OrbitalEvent) => void,
    options: BridgeLinkOptions = {}
  ) {
    this.url = options.url ?? process.env.ORBITAL_BRIDGE_WS_URL ?? DEFAULT_URL;
    this.baseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.maxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  }

  /** Idempotent: opens the socket and keeps it alive until close(). */
  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.openSocket();
  }

  stats(): BridgeLinkStats {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      received: this.received,
      rejected: this.rejected,
      reconnects: this.reconnects,
      url: this.url
    };
  }

  async close(): Promise<void> {
    this.closing = true;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;

    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.terminate();
    });
  }

  private openSocket(): void {
    if (this.closing) {
      return;
    }

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on("message", (data) => {
      let frame: unknown;

      try {
        frame = JSON.parse(data.toString());
      } catch {
        this.rejected += 1;

        return;
      }

      // The bridge greets every client with { kind: "connection", ... }:
      // a link-level handshake, not bus traffic, so it is neither relayed
      // nor counted as rejected.
      if (
        typeof frame === "object" &&
        frame !== null &&
        (frame as Record<string, unknown>)["kind"] === "connection"
      ) {
        return;
      }

      if (!isOrbitalEvent(frame)) {
        this.rejected += 1;

        return;
      }

      this.received += 1;
      this.onEvent(frame);
    });

    // Errors surface through 'close'; logging here would double-report.
    socket.on("error", () => {});

    socket.on("close", () => {
      if (!this.closing) {
        this.reconnects += 1;
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.baseMs * 2 ** this.attempts, this.maxMs);

    this.attempts += 1;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }
}
