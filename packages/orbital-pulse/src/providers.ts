/**
 * Provider registry and resilient execution for the OmniRoute gateway.
 *
 * Providers are OpenAI-compatible HTTP endpoints. The executor walks the
 * candidate chain in priority order and fails over on network errors,
 * timeouts, 408/429 and any 5xx, so callers always get an answer while
 * capacity exists anywhere in the pool.
 */

import type { RoutingTier } from "./routing.js";

export interface TierModels {
  readonly fast: readonly string[];
  readonly frontier: readonly string[];
}

export interface ProviderConfig {
  readonly id: string;
  /** OpenAI-compatible base URL including the version segment (…/v1). */
  readonly baseUrl: string;
  /** Resolved API key; omit for keyless local runtimes. */
  readonly apiKey?: string;
  readonly models: TierModels;
  /** Lower is tried first within a tier. */
  readonly priority: number;
}

interface ProviderDefinition {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly models: TierModels;
  readonly priority: number;
}

const BUILTIN_PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    priority: 10,
    models: {
      fast: ["llama-3.1-8b-instant"],
      frontier: ["llama-3.3-70b-versatile"]
    }
  },
  {
    id: "openrouter-free",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    priority: 20,
    models: {
      fast: ["meta-llama/llama-3.1-8b-instruct:free"],
      frontier: ["deepseek/deepseek-chat-v3-0324:free"]
    }
  },
  {
    id: "ollama-local",
    baseUrl: "http://127.0.0.1:11434/v1",
    priority: 30,
    models: {
      fast: ["llama3.2"],
      frontier: ["qwen2.5-coder:32b"]
    }
  }
];

function buildProvider(definition: ProviderDefinition): ProviderConfig | undefined {
  const apiKey =
    definition.apiKeyEnv === undefined ? undefined : process.env[definition.apiKeyEnv];

  if (definition.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === "")) {
    return undefined;
  }

  return {
    id: definition.id,
    baseUrl: definition.baseUrl.replace(/\/$/, ""),
    ...(apiKey === undefined ? {} : { apiKey }),
    models: definition.models,
    priority: definition.priority
  };
}

/**
 * Builds the active provider list. ORBITAL_PULSE_PROVIDERS (JSON array of
 * ProviderConfig) replaces built-ins entirely when set; otherwise built-ins
 * are enabled only when their API key env var is present (keyless ones always).
 */
export function loadProviders(): ProviderConfig[] {
  const fromEnv = process.env.ORBITAL_PULSE_PROVIDERS;

  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    let parsed: unknown;

    try {
      parsed = JSON.parse(fromEnv);
    } catch (error) {
      throw new Error(`ORBITAL_PULSE_PROVIDERS is not valid JSON: ${String(error)}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error("ORBITAL_PULSE_PROVIDERS must be a JSON array of provider configs");
    }

    return parsed.map((entry) => normalizeProvider(entry));
  }

  return BUILTIN_PROVIDERS.map(buildProvider).filter(
    (provider): provider is ProviderConfig => provider !== undefined
  );
}

function normalizeProvider(value: unknown): ProviderConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Provider entry must be an object");
  }

  const raw = value as Record<string, unknown>;

  if (typeof raw.id !== "string" || typeof raw.baseUrl !== "string") {
    throw new Error("Provider entry requires 'id' and 'baseUrl'");
  }

  if (typeof raw.priority !== "undefined" && typeof raw.priority !== "number") {
    throw new Error("Provider 'priority' must be a number");
  }

  return {
    id: raw.id,
    baseUrl: raw.baseUrl.replace(/\/$/, ""),
    ...(typeof raw.apiKey === "string" && raw.apiKey !== "" ? { apiKey: raw.apiKey } : {}),
    models: readTierModels(raw.models),
    priority: typeof raw.priority === "number" ? raw.priority : 100
  };
}

function readTierModels(value: unknown): TierModels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Provider 'models' must be an object { fast: [], frontier: [] }");
  }

  const raw = value as Record<string, unknown>;

  return {
    fast: readModelList(raw.fast),
    frontier: readModelList(raw.frontier)
  };
}

function readModelList(list: unknown): readonly string[] {
  if (list === undefined) {
    return [];
  }

  if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
    throw new Error("Provider model lists must be arrays of strings");
  }

  return [...list];
}

// ---------------------------------------------------------------------------
// Execution with fallback
// ---------------------------------------------------------------------------

export interface ChatCompletionBody {
  readonly model?: unknown;
  readonly messages: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface UpstreamAttempt {
  readonly providerId: string;
  readonly model: string;
  readonly outcome: "success" | "http-error" | "network-error";
  readonly status?: number;
  readonly detail?: string;
}

export interface UpstreamResult {
  readonly ok: boolean;
  readonly provider?: ProviderConfig;
  readonly model?: string;
  readonly body?: unknown;
  readonly attempts: readonly UpstreamAttempt[];
}

/**
 * Failure classes worth retrying on the next provider: transport errors,
 * timeouts, rate limits and upstream server faults. A deterministic 4xx
 * (bad request shape) would fail everywhere, but model-specific 400s exist,
 * so the chain retries everything — worst case is a few extra attempts.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface ExecuteOptions {
  readonly tier: RoutingTier;
  /** When set, pins the request to providers offering this exact model id. */
  readonly pinnedModel?: string;
  readonly timeoutMs: number;
  readonly body: ChatCompletionBody;
}

/**
 * Runs a chat completion across the provider chain until one succeeds or
 * every candidate fails. Never throws for upstream failures; the caller
 * inspects `attempts` to report what happened.
 */
export async function executeWithFallback(
  providers: readonly ProviderConfig[],
  options: ExecuteOptions
): Promise<UpstreamResult> {
  const candidates = selectCandidates(providers, options.tier, options.pinnedModel);
  const attempts: UpstreamAttempt[] = [];

  for (const provider of candidates) {
    const model =
      options.pinnedModel ??
      (options.tier === "frontier"
        ? provider.models.frontier[0]
        : provider.models.fast[0]);

    if (model === undefined) {
      continue;
    }

    const attempt = await postChatCompletion(provider, model, options.body, options.timeoutMs);
    attempts.push(attempt);

    if (attempt.outcome === "success") {
      return { ok: true, provider, model, body: attempt.body, attempts };
    }
  }

  return { ok: false, attempts };
}

export function selectCandidates(
  providers: readonly ProviderConfig[],
  tier: RoutingTier,
  pinnedModel?: string
): ProviderConfig[] {
  return [...providers]
    .sort((a, b) => a.priority - b.priority)
    .filter((provider) => {
      if (pinnedModel !== undefined) {
        return hasModel(provider, pinnedModel);
      }

      return tierModelFor(provider, tier) !== undefined;
    });
}

function hasModel(provider: ProviderConfig, model: string): boolean {
  return provider.models.fast.includes(model) || provider.models.frontier.includes(model);
}

function tierModelFor(provider: ProviderConfig, tier: RoutingTier): string | undefined {
  return tier === "frontier" ? provider.models.frontier[0] : provider.models.fast[0];
}

type ChatUpstreamOutcome =
  | { readonly outcome: "success"; readonly body: unknown }
  | { readonly outcome: "http-error"; readonly status: number }
  | { readonly outcome: "network-error"; readonly detail: string };

async function postChatCompletion(
  provider: ProviderConfig,
  model: string,
  body: ChatCompletionBody,
  timeoutMs: number
): Promise<UpstreamAttempt & { body?: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey === undefined ? {} : { authorization: `Bearer ${provider.apiKey}` })
      },
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        providerId: provider.id,
        model,
        outcome: "http-error",
        status: response.status
      };
    }

    return {
      providerId: provider.id,
      model,
      outcome: "success",
      body: await response.json()
    };
  } catch (error) {
    return {
      providerId: provider.id,
      model,
      outcome: "network-error",
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}
