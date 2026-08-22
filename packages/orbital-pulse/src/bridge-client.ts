/**
 * Outbound link from the pulse gateway to the orbital-bridge event bus.
 *
 * Publishes OrbitalEvent envelopes over WebSocket. The link is treated as
 * best-effort infrastructure: a downed bridge must never break an LLM
 * request, so events are buffered (bounded, drop-oldest) and flushed on
 * reconnect with exponential backoff.
 */

import { WebSocket } from "ws";
import type { OrbitalEvent } from "@orbital/bridge";

export interface BridgeClientOptions {
  /** Full bridge endpoint, e.g. ws://127.0.0.1:4000/ws */
  readonly url: string;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly queueLimit?: number;
  readonly pingIntervalMs?: number;
}

export interface BridgeClientStats {
  readonly connected: boolean;
  readonly sent: number;
  readonly dropped: number;
  readonly queued: number;
  readonly reconnects: number;
}

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 8000;
const DEFAULT_QUEUE_LIMIT = 200;
const DEFAULT_PING_INTERVAL_MS = 15000;

export class BridgeEventPublisher {
  private readonly url: string;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly queueLimit: number;
  private readonly pingIntervalMs: number;

  private socket: WebSocket | undefined;
  private reconnectTimer: Timer | undefined;
  private pingTimer: Timer | undefined;

  private started = false;
  private closing = false;
  private attempts = 0;

  private readonly queue: string[] = [];
  private sent = 0;
  private dropped = 0;
  private reconnects = 0;

  constructor(options: BridgeClientOptions) {
    this.url = options.url;
    this.baseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.maxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  }

  /** Idempotent: begins connecting and keeps the link alive until close(). */
  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.openSocket();
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  stats(): BridgeClientStats {
    return {
      connected: this.isConnected(),
      sent: this.sent,
      dropped: this.dropped,
      queued: this.queue.length,
      reconnects: this.reconnects
    };
  }

  /**
   * Sends now when the link is up, otherwise buffers for later delivery.
   * Returns true when the event went out immediately.
   */
  publish(event: OrbitalEvent): boolean {
    const frame = JSON.stringify(event);
    const socket = this.socket;

    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
      this.sent += 1;

      return true;
    }

    if (this.queue.length >= this.queueLimit) {
      this.queue.shift();
      this.dropped += 1;
    }

    this.queue.push(frame);

    return false;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearTimers();

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

    socket.on("open", () => {
      this.attempts = 0;
      this.startPinging();
      this.flushQueue();
    });

    socket.on("pong", () => {
      this.schedulePing();
    });

    // Errors are surfaced through 'close'; logging here would double-report.
    socket.on("error", () => {});

    socket.on("close", () => {
      this.clearPingTimer();

      if (!this.closing) {
        this.reconnects += 1;
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.baseMs * 2 ** this.attempts, this.maxMs);

    this.attempts += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private startPinging(): void {
    this.schedulePing();
  }

  private schedulePing(): void {
    this.clearPingTimer();
    this.pingTimer = setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        // If the peer never pongs back, the next schedulePing still fires,
        // but a dead TCP link usually surfaces as 'close' on write failure.
        this.socket.ping();
        this.schedulePing();
      }
    }, this.pingIntervalMs);
  }

  private flushQueue(): void {
    const socket = this.socket;

    if (socket === undefined) {
      return;
    }

    while (this.queue.length > 0 && socket.readyState === WebSocket.OPEN) {
      const frame = this.queue.shift();

      if (frame !== undefined) {
        socket.send(frame);
        this.sent += 1;
      }
    }
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearPingTimer();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== undefined) {
      clearTimeout(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}
