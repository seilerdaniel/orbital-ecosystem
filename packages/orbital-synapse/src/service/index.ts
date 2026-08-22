/**
 * Synapse memory service — bus-driven knowledge capture.
 *
 * Subscribes to the orbital-bridge WebSocket and, on every
 * `task.completed`, looks for an RDD receipt under the configured root.
 * Only receipts that pass the structural contract AND carry verdict
 * "approved" are stored as patterns; anything else is skipped so the
 * memory base never absorbs unverified work. Duplicate receipts are
 * idempotent (one pattern per receiptId).
 */

import { isOrbitalEvent } from "@orbital/bridge";
import { isRddReceipt, readReceipt, type RDDReceipt } from "@orbital/sentinel";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";

import {
  VectorStore,
  type MemoryRecord,
  type StoredMemory
} from "../store/vector-db.js";

export interface MemoryServiceOptions {
  /** Full bridge endpoint, e.g. ws://127.0.0.1:4000/ws */
  readonly url?: string;
  /** SQLite file; defaults to ~/.config/orbital/synapse.db */
  readonly dbPath?: string;
  /**
   * Directory where `.receipt.json` files appear. Lookup order per task:
   * `<root>/<taskId>/.receipt.json`, then `<root>/.receipt.json`.
   */
  readonly root?: string;
  readonly project?: string;
}

export interface MemoryServiceStats {
  readonly connected: boolean;
  readonly received: number;
  rejectedFrames: number;
  readonly tasksCompleted: number;
  readonly patternsStored: number;
  readonly skippedNoReceipt: number;
  readonly skippedInvalidReceipt: number;
  readonly reconnects: number;
}

const DEFAULT_URL = "ws://127.0.0.1:4000/ws";
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

type Timer = ReturnType<typeof setTimeout>;

export class MemoryService {
  private readonly url: string;
  private readonly root: string;
  private readonly project: string;
  private readonly store: VectorStore;

  private socket: WebSocket | undefined;
  private reconnectTimer: Timer | undefined;
  private started = false;
  private closing = false;
  private attempts = 0;

  private received = 0;
  rejectedFrames = 0;
  private tasksCompleted = 0;
  private patternsStored = 0;
  private skippedNoReceipt = 0;
  private skippedInvalidReceipt = 0;
  private reconnects = 0;

  constructor(options: MemoryServiceOptions = {}) {
    this.url = options.url ?? process.env.ORBITAL_BRIDGE_WS_URL ?? DEFAULT_URL;
    this.root = resolve(options.root ?? process.env.ORBITAL_SYNAPSE_ROOT ?? process.cwd());
    this.project =
      options.project ?? process.env.ORBITAL_SYNAPSE_PROJECT ?? "default";
    this.store = new VectorStore(
      options.dbPath === undefined ? {} : { path: options.dbPath }
    );
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.openSocket();
  }

  stats(): MemoryServiceStats {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      received: this.received,
      rejectedFrames: this.rejectedFrames,
      tasksCompleted: this.tasksCompleted,
      patternsStored: this.patternsStored,
      skippedNoReceipt: this.skippedNoReceipt,
      skippedInvalidReceipt: this.skippedInvalidReceipt,
      reconnects: this.reconnects
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
      this.store.close();

      return Promise.resolve();
    }

    return new Promise((resolveClose) => {
      socket.once("close", () => {
        this.store.close();
        resolveClose();
      });
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

        this.capturePattern(payload.taskId).catch((error) => {
          console.error("[synapse] capture failed:", error);
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

  private async capturePattern(taskIdRaw: unknown): Promise<void> {
    if (typeof taskIdRaw !== "string" || taskIdRaw.trim() === "") {
      return;
    }

    const taskId = taskIdRaw.trim();

    this.tasksCompleted += 1;

    const receipt = await this.findReceipt(taskId);

    if (receipt === undefined) {
      this.skippedNoReceipt += 1;
      console.log(`[synapse] ${taskId}: no receipt found; pattern not stored`);

      return;
    }

    // Structural contract first, then the approval gate.
    if (!isRddReceipt(receipt) || receipt.verdict !== "approved") {
      this.skippedInvalidReceipt += 1;
      console.log(
        `[synapse] ${taskId}: receipt ${receipt && typeof receipt === "object" && "verdict" in receipt ? String((receipt as RDDReceipt).verdict) : "invalid"} is not approved; pattern not stored`
      );

      return;
    }

    if (this.store.findByReceiptId(receipt.receiptId) !== undefined) {
      console.log(`[synapse] ${taskId}: receipt ${receipt.receiptId} already stored`);

      return;
    }

    const record: MemoryRecord = {
      project: this.project,
      kind: "pattern",
      title: `${taskId}: ${receipt.title}`,
      content: JSON.stringify({
        receiptId: receipt.receiptId,
        verdict: receipt.verdict,
        checks: receipt.checks,
        evidence: receipt.evidence,
        shield: receipt.shield,
        candidate: receipt.candidate
      }),
      tags: ["rdd", "verified"],
      receiptId: receipt.receiptId
    };

    const id = this.store.insert(record);
    const stored: StoredMemory | undefined = this.store.get(id);

    this.patternsStored += 1;
    console.log(`[synapse] stored pattern ${id} from receipt ${receipt.receiptId}`);
  }

  /** Receipt lookup: per-task directory first, then the shared root. */
  private async findReceipt(taskId: string): Promise<RDDReceipt | undefined> {
    for (const candidate of [resolve(this.root, taskId), this.root]) {
      try {
        const receipt = await readReceipt(resolve(candidate, ".receipt.json"));

        if (receipt !== undefined) {
          return receipt;
        }
      } catch {
        // Malformed receipt counts as absent for capture purposes.
      }
    }

    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Executable entry: `node dist/service/index.js` (pnpm start in @orbital/synapse)
// ---------------------------------------------------------------------------

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = new MemoryService();

  service.start();
  console.log("[synapse] memory service started");

  const shutdown = (): void => {
    void service.close().then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
