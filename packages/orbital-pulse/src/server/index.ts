import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createOrbitalEvent,
  type OrbitalEventMetadataValue
} from "@orbital/bridge";

import { classifyTask, type RoutingDecision, type RoutingTier } from "../routing.js";
import { loadProviders, executeWithFallback, type ProviderConfig, type UpstreamResult, type ChatCompletionBody } from "../providers.js";
import { BridgeEventPublisher } from "../bridge-client.js";

export const DEFAULT_PORT = 4001;
export const DEFAULT_BRIDGE_WS_URL = "ws://127.0.0.1:4000/ws";
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_ALERT_THRESHOLD = 100000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface PulseGatewayOptions {
  readonly port?: number;
  readonly bridgeWsUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly tokenAlertThreshold?: number;
}

export interface GatewayStats {
  readonly requestsCompleted: number;
  readonly requestsFailed: number;
  readonly fallbacksUsed: number;
  readonly tokensPrompt: number;
  readonly tokensCompletion: number;
  readonly alertsRaised: number;
  readonly providers: readonly string[];
  readonly uptimeSeconds: number;
}

export interface PulseGatewayHandle {
  readonly providers: readonly ProviderConfig[];
  start(): Promise<number>;
  close(): Promise<void>;
  stats(): GatewayStats;
}

/**
 * OmniRoute gateway: an OpenAI-compatible local proxy that routes each
 * chat completion to the right provider tier (fast vs frontier), fails
 * over automatically across the provider chain, and reports every
 * completion to the orbital-bridge event bus.
 */
export function createPulseGateway(options: PulseGatewayOptions = {}): PulseGatewayHandle {
  const port = options.port ?? readPortFromEnv() ?? DEFAULT_PORT;
  const timeoutMs = options.requestTimeoutMs ?? readNumberEnv("ORBITAL_PULSE_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS;
  const alertThreshold =
    options.tokenAlertThreshold ?? readNumberEnv("ORBITAL_TOKEN_ALERT_THRESHOLD") ?? DEFAULT_ALERT_THRESHOLD;

  const providers = loadProviders();
  const publisher = new BridgeEventPublisher({
    url: options.bridgeWsUrl ?? process.env.ORBITAL_BRIDGE_WS_URL ?? DEFAULT_BRIDGE_WS_URL
  });

  const httpServer: Server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("[pulse] unhandled request error:", error);
      sendJson(response, 500, { error: { message: "Internal gateway error", type: "gateway_error" } });
    });
  });

  let requestsCompleted = 0;
  let requestsFailed = 0;
  let fallbacksUsed = 0;
  let tokensPrompt = 0;
  let tokensCompletion = 0;
  let alertsRaised = 0;
  const startedAt = Date.now();

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /health") {
      return sendJson(response, 200, {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        bridge: publisher.stats(),
        ...counters(),
        providers: providers.map((provider) => provider.id)
      });
    }

    if (route === "GET /v1/models") {
      return sendJson(response, 200, { object: "list", data: listModels() });
    }

    if (route === "POST /v1/chat/completions") {
      return handleChatCompletions(request, response);
    }

    if (url.pathname === "/") {
      return sendJson(response, 200, {
        name: "@orbital/pulse",
        role: "OmniRoute gateway",
        endpoints: ["GET /health", "GET /v1/models", "POST /v1/chat/completions"]
      });
    }

    return sendJson(response, 404, {
      error: { message: `No route: ${route}`, type: "not_found" }
    });
  }

  async function handleChatCompletions(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await readJsonBody(request);

    if (!parsed.ok) {
      return sendJson(response, parsed.status, {
        error: { message: parsed.error, type: "invalid_request_error" }
      });
    }

    const body = normalizeBody(parsed.value);

    if (body === undefined) {
      return sendJson(response, 400, {
        error: { message: "'messages' must be a non-empty array", type: "invalid_request_error" }
      });
    }

    // Explicit tier wins over heuristics; header first, then in-body hint.
    const headerTier = parseTier(request.headers["x-orbital-tier"]);
    const decision: RoutingDecision =
      headerTier !== undefined
        ? { tier: headerTier, reason: "explicit-header" }
        : body.orbitalTier !== undefined
          ? { tier: body.orbitalTier, reason: "explicit-body" }
          : classifyTask(body.forward.messages);

    const pinnedModel =
      typeof body.forward.model === "string" && body.forward.model.trim() !== ""
        ? body.forward.model.trim()
        : undefined;

    const startedMs = Date.now();
    const result = await executeWithFallback(providers, {
      tier: decision.tier,
      ...(pinnedModel === undefined ? {} : { pinnedModel }),
      timeoutMs,
      body: body.forward
    });

    const { provider, body: upstreamBody, model } = result;

    if (provider === undefined || upstreamBody === undefined) {
      requestsFailed += 1;

      return sendJson(response, 502, {
        error: {
          message: "All providers in the routing chain failed",
          type: "upstream_failure",
          attempts: result.attempts
        }
      });
    }

    const durationMs = Date.now() - startedMs;

    if (result.attempts.length > 1) {
      fallbacksUsed += 1;
    }

    requestsCompleted += 1;
    const usage = readUsage(upstreamBody);
    tokensPrompt += usage.promptTokens;
    tokensCompletion += usage.completionTokens;

    const requestId = randomUUID();
    emitCompletion({
      requestId,
      providerId: provider.id,
      model: String(model),
      decision,
      attempts: result.attempts.length,
      durationMs,
      usage
    });

    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "x-orbital-request-id": requestId,
      "x-orbital-provider": provider.id,
      "x-orbital-model": String(model),
      "x-orbital-tier": decision.tier,
      "x-orbital-routing-reason": decision.reason,
      "x-orbital-fallback-attempts": String(result.attempts.length)
    });

    response.end(JSON.stringify(upstreamBody));
  }

  function emitCompletion(input: {
    requestId: string;
    providerId: string;
    model: string;
    decision: RoutingDecision;
    attempts: number;
    durationMs: number;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  }): void {
    const metadata: Record<string, OrbitalEventMetadataValue> = {
      routingReason: input.decision.reason,
      attempts: input.attempts
    };

    const completed = createOrbitalEvent({
      type: "agent.completed",
      source: "pulse",
      correlationId: input.requestId,
      metadata,
      payload: {
        requestId: input.requestId,
        provider: input.providerId,
        model: input.model,
        tier: input.decision.tier,
        durationMs: input.durationMs,
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens
      }
    });
    publisher.publish(completed);

    if (input.usage.totalTokens >= alertThreshold) {
      alertsRaised += 1;

      publisher.publish(
        createOrbitalEvent({
          type: "token.alert.raised",
          source: "pulse",
          correlationId: input.requestId,
          metadata,
          payload: {
            requestId: input.requestId,
            provider: input.providerId,
            model: input.model,
            totalTokens: input.usage.totalTokens,
            thresholdTokens: alertThreshold
          }
        })
      );
    }
  }

  function listModels(): Array<{ id: string; object: "model"; owned_by: string }> {
    const models: Array<{ id: string; object: "model"; owned_by: string }> = [];

    for (const provider of providers) {
      for (const model of [...provider.models.fast, ...provider.models.frontier]) {
        models.push({ id: model, object: "model", owned_by: provider.id });
      }
    }

    return models;
  }

  function counters() {
    return {
      requestsCompleted,
      requestsFailed,
      fallbacksUsed,
      tokensPrompt,
      tokensCompletion,
      alertsRaised
    };
  }

  return {
    providers,
    stats(): GatewayStats {
      return {
        requestsCompleted,
        requestsFailed,
        fallbacksUsed,
        tokensPrompt,
        tokensCompletion,
        alertsRaised,
        providers: providers.map((provider) => provider.id),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
      };
    },
    start() {
      publisher.start();

      return new Promise<number>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, "127.0.0.1", () => {
          resolve((httpServer.address() as { port: number }).port);
        });
      });
    },
    async close() {
      await publisher.close();

      return new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

interface NormalizedBody {
  readonly forward: ChatCompletionBody;
  /** In-body tier hint consumed by the router, stripped before forwarding. */
  readonly orbitalTier: RoutingTier | undefined;
}

function normalizeBody(value: unknown): NormalizedBody | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return undefined;
  }

  const { orbital_tier: _stripped, ...forward } = raw;

  return {
    forward: forward as ChatCompletionBody,
    orbitalTier: parseTier(raw.orbital_tier)
  };
}

function parseTier(value: unknown): RoutingTier | undefined {
  return value === "fast" || value === "frontier" ? value : undefined;
}

interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

function readUsage(body: unknown): TokenUsage {
  const empty: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  if (typeof body !== "object" || body === null) {
    return empty;
  }

  const usage = (body as Record<string, unknown>)["usage"];

  if (typeof usage !== "object" || usage === null) {
    return empty;
  }

  const raw = usage as Record<string, unknown>;
  const promptTokens = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
  const completionTokens = typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;
  const totalTokens =
    typeof raw.total_tokens === "number" ? raw.total_tokens : promptTokens + completionTokens;

  return { promptTokens, completionTokens, totalTokens };
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

// ---------------------------------------------------------------------------
// Executable entry: `node dist/server/index.js` (pnpm start in @orbital/pulse)
// ---------------------------------------------------------------------------

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = createPulseGateway();
  const boundPort = await gateway.start();

  console.log(`[pulse] OmniRoute gateway at http://localhost:${boundPort}/v1`);
  console.log(`[pulse] providers: ${gateway.providers.map((p) => p.id).join(", ") || "none"}`);
  console.log(`[pulse] bridge link: ${process.env.ORBITAL_BRIDGE_WS_URL ?? DEFAULT_BRIDGE_WS_URL}`);

  const shutdown = async (): Promise<void> => {
    await gateway.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function readPortFromEnv(): number | undefined {
  const parsed = readNumberEnv("ORBITAL_PULSE_PORT");

  if (parsed === undefined) {
    return undefined;
  }

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid ORBITAL_PULSE_PORT value`);
  }

  return parsed;
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : undefined;
}
