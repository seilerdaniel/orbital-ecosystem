/**
 * Token consumption telemetry for the Space Control widget.
 *
 * Aggregates per-request usage broadcast by the pulse gateway through
 * `agent.completed` events and tracks `token.alert.raised` crossings
 * against the configured budget. Pure accumulator: rendering stays in
 * the dashboard module.
 */

import type { AnyOrbitalEvent, TypedOrbitalEvent } from "@orbital/bridge";

export interface TokenTelemetrySnapshot {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly completions: number;
  readonly alerts: number;
  readonly budgetTokens: number;
  /** Last provider/model pair that served a completion, if any. */
  readonly lastProvider: string | undefined;
  readonly lastModel: string | undefined;
}

const DEFAULT_BUDGET_TOKENS = 100_000;

function readBudgetFromEnv(): number {
  const raw = process.env.ORBITAL_DOCK_TOKEN_BUDGET;

  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_BUDGET_TOKENS;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_BUDGET_TOKENS : parsed;
}

export class TokenTelemetry {
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;
  private completions = 0;
  private alerts = 0;
  private lastProvider: string | undefined;
  private lastModel: string | undefined;
  private readonly budgetTokens: number;

  constructor(budgetTokens = readBudgetFromEnv()) {
    this.budgetTokens = budgetTokens;
  }

  /**
   * Feeds one validated event into the accumulator. Returns true when the
   * event changed observable state (i.e. the widget should repaint).
   */
  observe(event: AnyOrbitalEvent): boolean {
    if (event.type === "agent.completed") {
      const payload = (event as TypedOrbitalEvent<"agent.completed">).payload;

      this.promptTokens += payload.promptTokens;
      this.completionTokens += payload.completionTokens;
      this.totalTokens += payload.promptTokens + payload.completionTokens;
      this.completions += 1;
      this.lastProvider = payload.provider;
      this.lastModel = payload.model;

      return true;
    }

    if (event.type === "token.alert.raised") {
      this.alerts += 1;

      return true;
    }

    return false;
  }

  snapshot(): TokenTelemetrySnapshot {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      completions: this.completions,
      alerts: this.alerts,
      budgetTokens: this.budgetTokens,
      lastProvider: this.lastProvider,
      lastModel: this.lastModel
    };
  }
}
