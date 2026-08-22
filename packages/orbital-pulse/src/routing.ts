/**
 * OmniRoute task-aware routing.
 *
 * Classifies an incoming chat completion request into a serving tier:
 * - "fast": mechanical work (linting, formatting, docs) -> cheap/free models.
 * - "frontier": deep work (architecture, DB, refactors) -> high-end models.
 */

export type RoutingTier = "fast" | "frontier";

const FRONTIER_HINTS = [
  "architecture",
  "database",
  "schema",
  "migration",
  "refactor",
  "refactoring",
  "security",
  "performance",
  "optimize",
  "optimization",
  "concurrency",
  "concurrent",
  "distributed",
  "transaction",
  "kubernetes",
  "terraform",
  "design",
  "algorithm",
  "scaling",
  "thread",
  "memory leak"
] as const;

const FAST_HINTS = [
  "lint",
  "format",
  "rename",
  "typo",
  "spelling",
  "comment",
  "docs",
  "docstring",
  "readme",
  "translate",
  "summarize",
  "summarise",
  "list files",
  "changelog"
] as const;

export interface RoutingDecision {
  readonly tier: RoutingTier;
  /** Why the tier was chosen; surfaced in response headers for observability. */
  readonly reason: "explicit-header" | "explicit-body" | "heuristic";
}

interface ChatMessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
}

/** Extracts comparable text out of an OpenAI-style message list. */
function conversationText(messages: readonly unknown[]): string {
  const parts: string[] = [];

  for (const raw of messages.slice(-4)) {
    if (typeof raw !== "object" || raw === null) continue;

    const message = raw as ChatMessageLike;

    if (typeof message.content === "string") {
      parts.push(message.content);
    }
  }

  return parts.join(" ").toLowerCase();
}

function countHints(text: string, hints: readonly string[]): number {
  let hits = 0;

  for (const hint of hints) {
    if (text.includes(hint)) {
      hits += 1;
    }
  }

  return hits;
}

/**
 * Heuristic classifier. Frontier signals outweigh fast ones; long
 * conversations lean frontier because context depth correlates with
 * complexity. Defaults to "fast" so the free lane absorbs the bulk of
 * mechanical traffic.
 */
export function classifyTask(messages: readonly unknown[]): RoutingDecision {
  const text = conversationText(messages);
  const frontierScore = countHints(text, FRONTIER_HINTS);
  const fastScore = countHints(text, FAST_HINTS);
  const longConversation = text.length > 2000;

  if (frontierScore > fastScore) {
    return { tier: "frontier", reason: "heuristic" };
  }

  if (frontierScore < fastScore) {
    return { tier: "fast", reason: "heuristic" };
  }

  return { tier: longConversation ? "frontier" : "fast", reason: "heuristic" };
}
