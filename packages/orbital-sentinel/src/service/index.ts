/**
 * Sentinel audit service — inbound bridge link plus audit reporting.
 *
 * Subscribes to the orbital-bridge event bus over WebSocket, validates
 * every envelope with the {@link Sentinel} contract checker, scans added
 * artifacts with AgentShield when they live inside the configured sandbox
 * root, and publishes `policy.violated` audit reports back onto the bus.
 *
 * The link is best-effort infrastructure: a downed bridge never crashes
 * the service; reconnection uses exponential backoff with a ceiling.
 */

import { createOrbitalEvent, isOrbitalEvent, type OrbitalEvent } from "@orbital/bridge";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

import type { OrbitalEventMetadataValue } from "@orbital/bridge";
import { AgentShield } from "../scanners/agent-shield.js";
import { Sentinel } from "../sentinel.js";

export interface AuditServiceOptions {
  /** Full bridge endpoint, e.g. ws://127.0.0.1:4000/ws */
  readonly url?: string;
  /**
   * Sandbox root for artifact scanning. Only paths inside this directory
   * are read and scanned — event payloads never escape the sandbox.
   */
  readonly root?: string;
  readonly maxScanBytes?: number;
}

export interface AuditStats {
  readonly connected: boolean;
  readonly received: number;
  readonly rejectedFrames: number;
  readonly invalidEnvelopes: number;
  readonly scansPerformed: number;
  readonly violationsReported: number;
  readonly reconnects: number;
  readonly url: string;
  readonly root: string;
}

const DEFAULT_URL = "ws://127.0.0.1:4000/ws";
const DEFAULT_MAX_SCAN_BYTES = 256 * 1024;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

type Timer = ReturnType<typeof setTimeout>;

export class AuditService {
  private readonly url: string;
  private readonly root: string;
  private readonly maxScanBytes: number;
  private readonly shield = new AgentShield();
  private readonly sentinel = new Sentinel();

  private socket: WebSocket | undefined;
  private reconnectTimer: Timer | undefined;
  private started = false;
  private closing = false;
  private attempts = 0;

  private received = 0;
  private rejectedFrames = 0;
  private invalidEnvelopes = 0;
  private scansPerformed = 0;
  private violationsReported = 0;
  private reconnects = 0;

  constructor(options: AuditServiceOptions = {}) {
    this.url = options.url ?? process.env.ORBITAL_BRIDGE_WS_URL ?? DEFAULT_URL;
    this.root = resolve(options.root ?? process.env.ORBITAL_SENTINEL_ROOT ?? process.cwd());
    this.maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.openSocket();
  }

  stats(): AuditStats {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      received: this.received,
      rejectedFrames: this.rejectedFrames,
      invalidEnvelopes: this.invalidEnvelopes,
      scansPerformed: this.scansPerformed,
      violationsReported: this.violationsReported,
      reconnects: this.reconnects,
      url: this.url,
      root: this.root
    };
  }

  close(): Promise<void> {
    this.closing = true;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.socket;

    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }

    return new Promise((resolveClose) => {
      socket.once("close", () => resolveClose());
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
        this.rejectedFrames += 1;

        return;
      }

      // Link-level handshake frame from the bridge, not bus traffic.
      if (
        typeof frame === "object" &&
        frame !== null &&
        (frame as Record<string, unknown>)["kind"] === "connection"
      ) {
        return;
      }

      if (!isOrbitalEvent(frame)) {
        this.rejectedFrames += 1;

        return;
      }

      this.received += 1;
      void this.audit(frame);
    });

    socket.on("error", () => {});

    socket.on("close", () => {
      if (!this.closing) {
        this.reconnects += 1;
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);

    this.attempts += 1;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  /** Audits one validated envelope and publishes reports when warranted. */
  private async audit(event: OrbitalEvent): Promise<void> {
    const report = this.sentinel.inspect(event);

    if (!report.valid) {
      this.invalidEnvelopes += 1;

      await this.publish(
        createOrbitalEvent({
          type: "policy.violated",
          source: "sentinel",
          correlationId: event.id,
          metadata: { violations: report.violations.map((v) => v.code).join(",") },
          payload: {
            policy: "event-envelope",
            detail: `Rejected ${event.type} from ${event.source}: ${report.violations
              .map((violation) => violation.code)
              .join(", ")}`
          }
        })
      );

      return;
    }

    if (event.type === "artifact.created") {
      await this.scanArtifact(
        (event.payload as { path?: unknown }).path,
        event.id
      );
    }
  }

  /**
   * Scans one artifact inside the sandbox root. Path traversal outside the
   * sandbox is silently ignored — untrusted bus payloads must not steer
   * file reads.
   */
  private async scanArtifact(rawPath: unknown, correlationId: string): Promise<void> {
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      return;
    }

    const absolute = resolve(this.root, rawPath);

    if (!(absolute + sep).startsWith(this.root + sep)) {
      return;
    }

    let content: string;

    try {
      content = await readFile(absolute, "utf8");
    } catch {
      return;
    }

    if (content.length > this.maxScanBytes) {
      content = content.slice(0, this.maxScanBytes);
    }

    this.scansPerformed += 1;

    const report = this.shield.scanText(content, rawPath);

    console.log(
      `[sentinel] scanned ${rawPath}: verdict=${report.verdict} findings=${report.findings.length}`
    );

    for (const finding of report.findings) {
      console.log(`[sentinel]   ${finding.severity} ${finding.ruleId} line ${finding.line ?? "?"}`);
    }

    if (report.verdict === "pass") {
      return;
    }

    const metadata: Record<string, OrbitalEventMetadataValue> = {
      findings: report.findings.length,
      ...(report.maxSeverity === undefined ? {} : { maxSeverity: report.maxSeverity })
    };

    await this.publish(
      createOrbitalEvent({
        type: "policy.violated",
        source: "sentinel",
        correlationId,
        metadata,
        payload: {
          policy: "agent-shield",
          detail: `${rawPath}: ${report.findings.length} finding(s), verdict=${report.verdict}`
        }
      })
    );
  }

  /** Publishes an event back onto the bus through the same socket. */
  private async publish(event: OrbitalEvent): Promise<void> {
    const socket = this.socket;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(event));
    this.violationsReported += 1;
  }
}

// ---------------------------------------------------------------------------
// Executable entry: `node dist/service/index.js` (pnpm start in @orbital/sentinel)
// ---------------------------------------------------------------------------

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = new AuditService();

  service.start();
  console.log(`[sentinel] audit service listening on ${service.stats().url}`);
  console.log(`[sentinel] scan sandbox: ${service.stats().root}`);

  const shutdown = (): void => {
    void service.close().then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
