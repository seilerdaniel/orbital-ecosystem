import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import {
  createOrbitalEvent,
  isOrbitalEvent,
  ORBITAL_EVENT_SCHEMA_VERSION,
  type OrbitalEvent
} from "../types/events.js";
import { SafeWorkspace, WorkspaceError } from "./workspace.js";

export const DEFAULT_PORT = 4000;
export const DEFAULT_HOST = "127.0.0.1";
export const WS_PATH = "/ws";
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface BridgeServerOptions {
  readonly port?: number;
  readonly host?: string;
  /** Root directory exposed by the Inverse MCP endpoints. Defaults to cwd. */
  readonly workspaceRoot?: string;
}

export interface BridgeStats {
  readonly clientsConnected: number;
  readonly eventsBroadcast: number;
  readonly eventsRejected: number;
  readonly uptimeSeconds: number;
  readonly workspaceRoot: string;
}

export interface BridgeServerHandle {
  readonly workspace: SafeWorkspace;
  /** Binds the HTTP server and resolves with the actual port. */
  start(): Promise<number>;
  /** Closes the HTTP server and every open WebSocket connection. */
  close(): Promise<void>;
  stats(): BridgeStats;
}

/**
 * Creates the Orbital bridge server:
 *
 * - `GET /health`       — liveness + counters.
 * - `POST /api/events`  — validates an OrbitalEvent and broadcasts it live.
 * - `WS   /ws`          — pushes every broadcast event to connected clients.
 * - `/api/fs`           — safe local CRUD over the active project directory
 *                         (Inverse MCP Bridge). `.git` and `node_modules`
 *                         are always off-limits.
 */
export function createBridgeServer(options: BridgeServerOptions = {}): BridgeServerHandle {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const workspace = new SafeWorkspace({ root: options.workspaceRoot });

  const httpServer: Server = createServer((request, response) => {
    handleHttpRequest(request, response).catch((error) => {
      console.error("[bridge] unhandled request error:", error);
      sendJson(response, 500, { ok: false, error: "Internal bridge error" });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  let eventsBroadcast = 0;
  let eventsRejected = 0;
  let eventsRelayed = 0;
  const startedAt = Date.now();

  // Only the /ws path upgrades; anything else gets its socket destroyed.
  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");

    if (pathname === WS_PATH) {
      wss.handleUpgrade(request, socket, head, (client) => {
        wss.emit("connection", client, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (client) => {
    client.send(
      JSON.stringify({
        kind: "connection",
        status: "connected",
        schemaVersion: ORBITAL_EVENT_SCHEMA_VERSION,
        clients: wss.clients.size,
        workspaceRoot: workspace.root
      })
    );

    client.on("error", (error) => {
      console.error("[bridge] websocket client error:", error.message);
    });
  });

  function broadcast(event: OrbitalEvent): number {
    let delivered = 0;

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(event));
        delivered += 1;
      }
    }

    eventsBroadcast += 1;

    return delivered;
  }

  async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method} ${url.pathname}`;

    if (route === `GET /health`) {
      return sendJson(response, 200, healthPayload());
    }

    if (route === `POST /api/events`) {
      const body = await readJsonBody(request);

      if (!body.ok) {
        eventsRejected += 1;

        return sendJson(response, body.status, { ok: false, error: body.error });
      }

      if (!isOrbitalEvent(body.value)) {
        eventsRejected += 1;

        return sendJson(response, 422, {
          ok: false,
          error: "Payload does not satisfy the OrbitalEvent contract",
          schemaVersion: ORBITAL_EVENT_SCHEMA_VERSION
        });
      }

      const delivered = broadcast(body.value);
      eventsRelayed += 1;

      return sendJson(response, 202, {
        ok: true,
        id: body.value.id,
        delivered
      });
    }

    if (url.pathname === "/api/fs") {
      return handleFsRoute(request, response, url);
    }

    if (url.pathname === "/") {
      return sendJson(response, 200, {
        name: "@orbital/bridge",
        endpoints: ["GET /health", "POST /api/events", "GET|POST|PUT|DELETE /api/fs"],
        wsPath: WS_PATH
      });
    }

    return sendJson(response, 404, { ok: false, error: `No route: ${route}` });
  }

  async function handleFsRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> {
    try {
      switch (request.method) {
        case "GET": {
          const result = await workspace.read(url.searchParams.get("path") ?? "");

          return sendJson(response, 200, { ok: true, ...result });
        }
        case "POST":
        case "PUT": {
          const body = await readJsonBody(request);

          if (!body.ok) {
            return sendJson(response, body.status, { ok: false, error: body.error });
          }

          const target = readFsTarget(body.value);
          const isCreate = request.method === "POST";
          const writtenPath = isCreate
            ? await workspace.createFile(target.path, target.contents)
            : await workspace.writeFile(target.path, target.contents);

          announceArtifact(writtenPath, isCreate ? "create" : "write");

          return sendJson(response, isCreate ? 201 : 200, {
            ok: true,
            path: writtenPath,
            bytes: Buffer.byteLength(target.contents, "utf8")
          });
        }
        case "DELETE": {
          const recursive = ["1", "true"].includes(
            (url.searchParams.get("recursive") ?? "").toLowerCase()
          );
          const deletedPath = await workspace.delete(url.searchParams.get("path") ?? "", recursive);

          return sendJson(response, 200, { ok: true, path: deletedPath });
        }
        default:
          return sendJson(response, 405, { ok: false, error: `Method not allowed: ${String(request.method)}` });
      }
    } catch (error) {
      if (error instanceof WorkspaceError) {
        return sendJson(response, error.statusCode, { ok: false, error: error.message });
      }

      throw error;
    }
  }

  /**
   * Emits a synthetic artifact.created OrbitalEvent for fs mutations so
   * dock/mobile/sentinel observe workspace changes on the same bus.
   */
  function announceArtifact(relativePath: string, operation: "create" | "write"): void {
    const event = createOrbitalEvent({
      type: "artifact.created",
      source: "bridge",
      metadata: { operation },
      payload: {
        artifactId: randomUUID(),
        path: relativePath
      }
    });

    broadcast(event);
  }

  function healthPayload(): Record<string, unknown> {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      clientsConnected: wss.clients.size,
      eventsBroadcast,
      eventsRelayed,
      eventsRejected,
      wsPath: WS_PATH,
      workspaceRoot: workspace.root
    };
  }

  function stats(): BridgeStats {
    return {
      clientsConnected: wss.clients.size,
      eventsBroadcast,
      eventsRejected,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      workspaceRoot: workspace.root
    };
  }

  return {
    workspace,
    stats,
    start() {
      return new Promise<number>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          resolve((httpServer.address() as { port: number }).port);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        for (const client of wss.clients) {
          client.terminate();
        }

        wss.close(() => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        });
      });
    }
  };
}

interface FsTarget {
  readonly path: string;
  readonly contents: string;
}

function readFsTarget(value: unknown): FsTarget {
  if (typeof value !== "object" || value === null) {
    throw new WorkspaceError("Body must be a JSON object with 'path' and 'contents'", 400);
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.path !== "string" || candidate.path.trim() === "") {
    throw new WorkspaceError("'path' is required and must be a non-empty string", 400);
  }

  if (typeof candidate.contents !== "string") {
    throw new WorkspaceError("'contents' is required and must be a string", 400);
  }

  return { path: candidate.path, contents: candidate.contents };
}

type JsonBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string };

async function readJsonBody(request: IncomingMessage): Promise<JsonBodyResult> {
  const declaredLength = Number.parseInt(request.headers["content-length"] ?? "", 10);

  if (!Number.isNaN(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "Request body too large" };
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length as number;

    if (total > MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: "Request body too large" };
    }

    chunks.push(chunk as Buffer);
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "Body must be valid JSON" };
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);

  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

/**
 * Executable entry: `node dist/server/index.js` (pnpm start in @orbital/bridge).
 * Library consumers should import createBridgeServer instead of running this.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = createBridgeServer({
    port: readPortFromEnv(),
    host: process.env.ORBITAL_BRIDGE_HOST,
    workspaceRoot: process.env.ORBITAL_BRIDGE_ROOT
  });

  const shutdown = async (): Promise<void> => {
    await bridge.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  bridge
    .start()
    .then((boundPort) => {
      console.log(`[bridge] HTTP  ready at http://localhost:${boundPort}`);
      console.log(`[bridge] WS    ready at ws://localhost:${boundPort}${WS_PATH}`);
      console.log(`[bridge] fs root: ${bridge.workspace.root}`);
    })
    .catch((error: unknown) => {
      console.error("[bridge] failed to start:", error);
      process.exitCode = 1;
    });
}

function readPortFromEnv(): number | undefined {
  const raw = process.env.ORBITAL_BRIDGE_PORT;

  if (raw === undefined || raw === "") {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid ORBITAL_BRIDGE_PORT: ${raw}`);
  }

  return parsed;
}
