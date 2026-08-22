/**
 * Forge render service — bus-driven content generation.
 *
 * Subscribes to the orbital-bridge WebSocket and, on every
 * `task.completed`, compiles a content package (release notes from git
 * history + synapse memory, demo storyboard, OpenMontage project skeleton)
 * into the configured output directory. One `artifact.created` event is
 * published back onto the bus per written artifact so the rest of the
 * ecosystem can react to rendered content.
 */

import { createOrbitalEvent, isOrbitalEvent } from "@orbital/bridge";
import { VectorStore } from "@orbital/synapse";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

import {
  renderContentPackage,
  type RenderResult
} from "../forge.js";

export interface ForgeServiceOptions {
  /** Full bridge endpoint, e.g. ws://127.0.0.1:4000/ws */
  readonly url?: string;
  /** Output directory for rendered artifacts. */
  readonly root?: string;
  /** Repository whose git history feeds the release notes. */
  readonly repoRoot?: string;
  readonly dbPath?: string;
}

export interface ForgeServiceStats {
  readonly connected: boolean;
  readonly received: number;
  rejectedFrames: number;
  readonly rendersCompleted: number;
  readonly artifactsPublished: number;
  readonly publishesSkipped: number;
  readonly reconnects: number;
  readonly root: string;
  readonly repoRoot: string;
}

const DEFAULT_URL = "ws://127.0.0.1:4000/ws";
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

type Timer = ReturnType<typeof setTimeout>;

export class ForgeService {
  private readonly url: string;
  private readonly root: string;
  private readonly repoRoot: string;
  private readonly dbPath: string | undefined;

  private store: VectorStore | undefined;
  private socket: WebSocket | undefined;
  private reconnectTimer: Timer | undefined;
  private started = false;
  private closing = false;
  private attempts = 0;

  private received = 0;
  private rejectedFrames = 0;
  private rendersCompleted = 0;
  private artifactsPublished = 0;
  private publishesSkipped = 0;
  private reconnects = 0;

  constructor(options: ForgeServiceOptions = {}) {
    this.url = options.url ?? process.env.ORBITAL_BRIDGE_WS_URL ?? DEFAULT_URL;
    this.root = resolve(
      options.root ?? process.env.ORBITAL_FORGE_ROOT ?? resolve(process.cwd(), "forge-out")
    );
    this.repoRoot = resolve(options.repoRoot ?? process.env.ORBITAL_FORGE_REPO_ROOT ?? process.cwd());
    this.dbPath = options.dbPath ?? process.env.ORBITAL_SYNAPSE_DB;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.openSocket();
  }

  stats(): ForgeServiceStats {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      received: this.received,
      rejectedFrames: this.rejectedFrames,
      rendersCompleted: this.rendersCompleted,
      artifactsPublished: this.artifactsPublished,
      publishesSkipped: this.publishesSkipped,
      reconnects: this.reconnects,
      root: this.root,
      repoRoot: this.repoRoot
    };
  }

  close(): Promise<void> {
    this.closing = true;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.store?.close();

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

      if (frame.type === "task.completed") {
        const payload = frame.payload as { taskId?: unknown };

        this.renderForTask(payload.taskId, frame.id).catch((error) => {
          console.error("[forge] render failed:", error);
        });
      }
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

  /** Renders one content package and announces its artifacts on the bus. */
  private async renderForTask(taskIdRaw: unknown, correlationId: string): Promise<void> {
    if (typeof taskIdRaw !== "string" || taskIdRaw.trim() === "") {
      return;
    }

    const taskId = taskIdRaw.trim();

    if (this.store === undefined) {
      this.store = new VectorStore(
        this.dbPath === undefined ? {} : { path: this.dbPath }
      );
    }

    const result: RenderResult = await renderContentPackage({
      title: `Orbital release — ${taskId}`,
      outputDir: resolve(this.root, taskId),
      repoRoot: this.repoRoot,
      store: this.store
    });

    this.rendersCompleted += 1;
    console.log(
      `[forge] rendered ${result.files.length} artifact(s) for ${taskId} under ${resolve(this.root, taskId)}`
    );

    for (const file of result.files) {
      await this.publish(
        createOrbitalEvent({
          type: "artifact.created",
          source: "forge",
          correlationId,
          metadata: { taskId, bytes: file.bytes },
          payload: {
            artifactId: randomUUID(),
            path: file.path
          }
        })
      );
    }
  }

  /** Publishes an event onto the bus through the same socket. */
  private async publish(event: ReturnType<typeof createOrbitalEvent>): Promise<void> {
    const socket = this.socket;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      this.publishesSkipped += 1;

      return;
    }

    socket.send(JSON.stringify(event));
    this.artifactsPublished += 1;
  }
}

// ---------------------------------------------------------------------------
// Executable entry: `node dist/service/index.js` (pnpm start in @orbital/forge)
// ---------------------------------------------------------------------------

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = new ForgeService();

  service.start();
  console.log("[forge] render service started");

  const shutdown = (): void => {
    void service.close().then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
