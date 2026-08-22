/**
 * ANSI "Space Control" panel for the dock terminal.
 *
 * Repaints a fixed-size frame: header with link health, a bounded live
 * event feed, and the token pulse widget fed by @see TokenTelemetry.
 * Rendering is intentionally dependency-free (no TUI framework) so the
 * dock stays a zero-config `node dist/main.js` app.
 */

import { type AnyOrbitalEvent, type TypedOrbitalEvent } from "@orbital/bridge";
import type { BridgeLinkStats } from "./bridge-link.js";
import type { TokenTelemetrySnapshot } from "./telemetry.js";

export interface DashboardOptions {
  /** Maximum entries kept in the visible feed. */
  readonly maxFeedEntries?: number;
}

export interface FeedEntry {
  readonly at: Date;
  readonly type: string;
  readonly source: string;
  readonly summary: string;
  /** True when Sentinel rejected the envelope. */
  readonly invalid: boolean;
}

const FRAME_WIDTH = 86;
const DEFAULT_MAX_FEED_ENTRIES = 10;

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const CLEAR_SCREEN_DOWN = "\x1b[J";

function line(left: string, right: string): string {
  const space = FRAME_WIDTH - 4 - left.length - right.length;

  return `│ ${left}${" ".repeat(Math.max(space, 1))}${right} │`;
}

/** Human-readable one-liner for any event in the contract. */
export function summarizeEvent(event: AnyOrbitalEvent): string {
  switch (event.type) {
    case "session.started":
      return `actor=${(event as TypedOrbitalEvent<"session.started">).payload.actor}`;
    case "session.completed":
      return `outcome=${(event as TypedOrbitalEvent<"session.completed">).payload.outcome}`;
    case "task.dispatched":
      return `${(event as TypedOrbitalEvent<"task.dispatched">).payload.title}`;
    case "task.progressed": {
      const payload = (event as TypedOrbitalEvent<"task.progressed">).payload;

      return `${payload.taskId} ${payload.progress}%`;
    }
    case "task.completed":
      return `${(event as TypedOrbitalEvent<"task.completed">).payload.taskId} in ${(
        (event as TypedOrbitalEvent<"task.completed">).payload.durationMs / 1000
      ).toFixed(1)}s`;
    case "task.failed":
      return `${(event as TypedOrbitalEvent<"task.failed">).payload.taskId}: ${
        (event as TypedOrbitalEvent<"task.failed">).payload.reason
      }`;
    case "artifact.created":
      return (event as TypedOrbitalEvent<"artifact.created">).payload.path;
    case "vault.unlocked":
    case "vault.locked":
      return (event as TypedOrbitalEvent<"vault.locked">).payload.vaultId;
    case "health.reported": {
      const payload = (event as TypedOrbitalEvent<"health.reported">).payload;

      return `${payload.component} healthy=${payload.healthy}`;
    }
    case "policy.violated": {
      const payload = (event as TypedOrbitalEvent<"policy.violated">).payload;

      return `${payload.policy}: ${payload.detail}`;
    }
    case "agent.completed": {
      const payload = (event as TypedOrbitalEvent<"agent.completed">).payload;

      return `${payload.provider}/${payload.model} [${payload.tier}] +${
        payload.promptTokens + payload.completionTokens
      }t ${Math.round(payload.durationMs)}ms`;
    }
    case "token.alert.raised": {
      const payload = (event as TypedOrbitalEvent<"token.alert.raised">).payload;

      return `${payload.provider}/${payload.model} ${payload.totalTokens}t >= threshold ${payload.thresholdTokens}t`;
    }
    default:
      return "";
  }
}

function colorFor(type: string): string {
  if (type === "token.alert.raised" || type === "task.failed" || type === "policy.violated") {
    return RED;
  }

  if (type === "agent.completed") {
    return CYAN;
  }

  if (type.startsWith("session.")) {
    return GREEN;
  }

  return YELLOW;
}

function progressBar(value: number, max: number, width = 30): string {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  const filled = Math.round(ratio * width);

  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function budgetColor(total: number, budget: number): string {
  const ratio = budget > 0 ? total / budget : 0;

  if (ratio >= 1) return RED;
  if (ratio >= 0.8) return YELLOW;

  return GREEN;
}

export class Dashboard {
  private readonly maxFeedEntries: number;
  private readonly feed: FeedEntry[] = [];
  private droppedFromFeed = 0;
  private startedAt = Date.now();
  private firstPaintDone = false;

  constructor(options: DashboardOptions = {}) {
    this.maxFeedEntries = options.maxFeedEntries ?? DEFAULT_MAX_FEED_ENTRIES;
  }

  record(event: AnyOrbitalEvent, invalid = false): void {
    this.feed.push({
      at: new Date(),
      type: event.type,
      source: event.source,
      summary: summarizeEvent(event),
      invalid
    });

    if (this.feed.length > this.maxFeedEntries) {
      this.feed.shift();
      this.droppedFromFeed += 1;
    }
  }

  render(link: BridgeLinkStats, telemetry: TokenTelemetrySnapshot): void {
    const uptimeSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    const out: string[] = [];

    out.push("┌" + "─".repeat(FRAME_WIDTH - 2) + "┐");
    out.push(line(`ORBITAL DOCK · SPACE CONTROL`, `uptime ${uptimeSeconds}s`));
    out.push("├" + "─".repeat(FRAME_WIDTH - 2) + "┤");

    const linkState = link.connected
      ? `${GREEN}CONNECTED${RESET}`
      : `${RED}DISCONNECTED${RESET}`;

    out.push(line(`bridge ${DIM}${link.url.replace(/^ws:\/\/|^wss:\/\//, "")}${RESET}`, ""));
    out.push(
      line(
        `link ${linkState}${link.reconnects > 0 ? `${DIM} (reconnects ${link.reconnects})${RESET}` : ""}`,
        `events ${link.received} · rejected ${link.rejected}`
      )
    );

    out.push("├" + "─".repeat(FRAME_WIDTH - 2) + "┤");
    out.push(line(`${BOLD}LIVE EVENT FEED${RESET}`, ""));

    if (this.feed.length === 0) {
      out.push(line(`${DIM}waiting for events…${RESET}`, ""));
    }

    for (const entry of this.feed) {
      const time = entry.at.toISOString().slice(11, 19);
      const badge = colorFor(entry.type);
      const marker = entry.invalid ? `${RED}✗${RESET} ` : "";
      const text = `${marker}${badge}${entry.type}${RESET} ${DIM}${entry.source}${RESET} ${entry.summary}`;

      out.push(`│ ${DIM}${time}${RESET}  ${text}` + " ".repeat(Math.max(FRAME_WIDTH - 12 - rawLength(text), 1)) + " │");
    }

    out.push("├" + "─".repeat(FRAME_WIDTH - 2) + "┤");
    out.push(line(`${BOLD}TOKEN PULSE${RESET}`, ""));

    const bar = progressBar(telemetry.totalTokens, telemetry.budgetTokens);
    const percent =
      telemetry.budgetTokens > 0
        ? Math.round((telemetry.totalTokens / telemetry.budgetTokens) * 100)
        : 0;
    const tint = budgetColor(telemetry.totalTokens, telemetry.budgetTokens);

    out.push(
      line(
        `${tint}${bar}${RESET} ${percent}%`,
        `${telemetry.totalTokens}/${telemetry.budgetTokens} tokens`
      )
    );
    out.push(
      line(
        `completions ${telemetry.completions}`,
        `alerts ${telemetry.alerts > 0 ? `${RED}${telemetry.alerts}${RESET}` : "0"}`
      )
    );

    const lastServed =
      telemetry.lastProvider === undefined
        ? `${DIM}no completions yet${RESET}`
        : `last ${telemetry.lastProvider}/${telemetry.lastModel ?? "?"}`;

    out.push(line(lastServed, ""));
    out.push("└" + "─".repeat(FRAME_WIDTH - 2) + "┘");

    // Home cursor after the first paint; clear the tail when frames shrink.
    process.stdout.write((this.firstPaintDone ? "\x1b[H" : "\x1b[2J\x1b[H") + out.join("\n") + "\n" + CLEAR_SCREEN_DOWN);
    this.firstPaintDone = true;
  }

  resetClock(): void {
    this.startedAt = Date.now();
    this.firstPaintDone = false;
  }
}

/** Visible length ignoring ANSI escape sequences (for padding math). */
function rawLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}
