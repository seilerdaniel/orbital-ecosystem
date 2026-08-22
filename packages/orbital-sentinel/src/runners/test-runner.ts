/**
 * Pre-Flight test runner — background verification for an audited project.
 *
 * Detects the project's own test runner (Vitest / Jest / plain npm test),
 * executes it in a child process WITHOUT blocking the caller, parses the
 * pass/fail/total counts out of the output, and publishes a
 * `preflight.reported` envelope onto the orbital-bridge WebSocket so any
 * dashboard can badge project health in real time.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve as resolvePath } from "node:path";
import { createOrbitalEvent, isOrbitalEvent } from "@orbital/bridge";
import { WebSocket } from "ws";

export type RunnerKind = "vitest" | "jest" | "npm-test";

export interface TestRunResult {
  readonly runner: RunnerKind;
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly durationMs: number;
  /** failed === 0 && total > 0 && clean exit. */
  readonly ok: boolean;
}

export interface PreFlightOptions {
  /** Audited project directory holding package.json. Defaults to cwd. */
  readonly targetRoot?: string;
  /** Full bridge endpoint; defaults to ws://127.0.0.1:4000/ws */
  readonly url?: string;
  /** Periodic re-run cadence; omit for manual trigger() runs only. */
  readonly intervalMs?: number;
  /** Skip detection and force a strategy. */
  readonly runnerOverride?: RunnerKind;
  /** Hard cap per run; defaults to 120s. */
  readonly timeoutMs?: number;
  /** Streams raw child output chunks as they arrive (CLI passthrough). */
  readonly onOutput?: (chunk: string) => void;
}

export interface PreFlightStats {
  readonly connected: boolean;
  readonly running: boolean;
  readonly runsCompleted: number;
  readonly published: number;
  readonly publishSkipped: number;
  readonly reconnects: number;
  readonly last: TestRunResult | undefined;
  readonly targetRoot: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

async function detectRunner(targetRoot: string): Promise<RunnerKind> {
  try {
    const raw = await readFile(join(targetRoot, "package.json"), "utf8");
    const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts;
    const testScript = scripts?.test ?? "";

    if (/vitest/i.test(testScript)) {
      return "vitest";
    }

    if (/jest/i.test(testScript)) {
      return "jest";
    }
  } catch {
    // No readable package.json: fall through to generic strategy.
  }

  return "npm-test";
}

function packageManagerFor(targetRoot: string): "pnpm" | "yarn" | "npm" {
  if (existsSync(join(targetRoot, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (existsSync(join(targetRoot, "yarn.lock"))) {
    return "yarn";
  }

  return "npm";
}

async function projectNameFor(targetRoot: string): Promise<string> {
  try {
    const raw = await readFile(join(targetRoot, "package.json"), "utf8");
    const name = (JSON.parse(raw) as { name?: string }).name;

    if (typeof name === "string" && name !== "") {
      return name;
    }
  } catch {
    // fall through
  }

  return basename(targetRoot);
}

// ---------------------------------------------------------------------------
// Output parsing (exported for direct testing)
// ---------------------------------------------------------------------------

export interface TestCounts {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
}

const ZERO: TestCounts = { passed: 0, failed: 0, total: 0 };

/**
 * Extracts counts from Jest/Vitest machine-readable JSON output
 * (`vitest run --reporter=json`, `jest --json`). Returns the LAST result
 * object found, tolerating log noise around the payload.
 */
export function parseJestJson(text: string): TestCounts | undefined {
  for (const candidate of extractBalancedObjects(text)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;

      if (
        typeof parsed["numTotalTests"] === "number" &&
        typeof parsed["numPassedTests"] === "number" &&
        typeof parsed["numFailedTests"] === "number"
      ) {
        return {
          passed: parsed["numPassedTests"],
          failed: parsed["numFailedTests"],
          total: parsed["numTotalTests"]
        };
      }
    } catch {
      // Not JSON after all; keep scanning.
    }
  }

  return undefined;
}

/** Yields balanced `{...}` substrings (brace counting, string-aware enough). */
function* extractBalancedObjects(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      if (depth > 0) {
        inString = true;
      }

      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = i;
      }

      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;

        if (depth === 0 && start >= 0) {
          yield text.slice(start, i + 1);
          start = -1;
        }
      }
    }
  }
}

/** Parses human summary lines: vitest, jest, mocha, and node:test styles. */
export function parseSummaryText(text: string): TestCounts | undefined {
  // node:test TAP-ish footer: "# pass 4\n# fail 1\n# cancelled 0"
  const tapPass = /^#\s*pass\s+(\d+)/im.exec(text);
  const tapFail = /^#\s*fail(?:ed)?\s+(\d+)/im.exec(text);

  if (tapPass !== null || tapFail !== null) {
    return finalize(+(tapPass?.[1] ?? 0), +(tapFail?.[1] ?? 0));
  }

  // Vitest default reporter: " Tests  5 passed | 1 failed (12ms)"
  const vitest = /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?/i.exec(text);

  if (vitest !== null) {
    return finalize(+(vitest[1] ?? 0), +(vitest[2] ?? 0));
  }

  // Jest summary: "Tests:       5 passed, 1 failed, 6 total"
  const jest = /Tests:\s*(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i.exec(text);

  if (jest !== null) {
    return finalize(+(jest[1] ?? 0), +(jest[2] ?? 0));
  }

  // Mocha spec reporter: "  5 passing (100ms)" / "  1 failing"
  const mocha = /(\d+)\s+passing/i.exec(text);

  if (mocha !== null) {
    const failing = /(\d+)\s+failing/i.exec(text);

    return finalize(+(mocha[1] ?? 0), +(failing?.[1] ?? 0));
  }

  return undefined;
}

function finalize(passed: number, failed: number): TestCounts {
  return { passed, failed, total: passed + failed };
}

// ---------------------------------------------------------------------------
// Child execution
// ---------------------------------------------------------------------------

interface SpawnOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function execCapture(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  onOutput: ((chunk: string) => void) | undefined
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);

      stdout += text;
      onOutput?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);

      stderr += text;
      onOutput?.(text);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: `${stderr}${String(error)}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

async function runStrategy(
  runner: RunnerKind,
  targetRoot: string,
  timeoutMs: number,
  onOutput: ((chunk: string) => void) | undefined
): Promise<{ outcome: SpawnOutcome; counts: TestCounts }> {
  const pm = packageManagerFor(targetRoot);
  let command = pm;
  let args: string[];

  switch (runner) {
    case "vitest": {
      args = ["exec", "vitest", "run", "--reporter=json"];
      break;
    }
    case "jest": {
      args = ["exec", "jest", "--json", "--silent"];
      break;
    }
    default: {
      args = pm === "npm" ? ["run", "test", "--silent"] : ["test"];
    }
  }

  const outcome = await execCapture(command, args, targetRoot, timeoutMs, onOutput);
  const combined = `${outcome.stdout}\n${outcome.stderr}`;
  const counts =
    runner === "npm-test"
      ? (parseSummaryText(combined) ?? ZERO)
      : (parseJestJson(outcome.stdout) ?? parseSummaryText(combined) ?? ZERO);

  return { outcome, counts };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DEFAULT_URL = "ws://127.0.0.1:4000/ws";
const DEFAULT_TIMEOUT_MS = 120_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;

type Timer = ReturnType<typeof setTimeout>;

export class PreFlightRunner {
  private readonly targetRoot: string;
  private readonly url: string;
  private readonly intervalMs: number | undefined;
  private readonly runnerOverride: RunnerKind | undefined;
  private readonly timeoutMs: number;
  private readonly onOutput: ((chunk: string) => void) | undefined;

  private socket: WebSocket | undefined;
  private reconnectTimer: Timer | undefined;
  private scheduleTimer: Timer | undefined;
  private started = false;
  private closing = false;
  private attempts = 0;
  private running = false;

  private runsCompleted = 0;
  private published = 0;
  private publishSkipped = 0;
  private reconnects = 0;
  private last: TestRunResult | undefined;

  constructor(options: PreFlightOptions = {}) {
    this.targetRoot = resolvePath(
      options.targetRoot ?? process.env.ORBITAL_PREFLIGHT_TARGET ?? process.cwd()
    );
    this.url = options.url ?? process.env.ORBITAL_BRIDGE_WS_URL ?? DEFAULT_URL;
    this.intervalMs = options.intervalMs;
    this.runnerOverride = options.runnerOverride;
    this.timeoutMs =
      options.timeoutMs ??
      readNumberEnv("ORBITAL_PREFLIGHT_TIMEOUT_MS") ??
      DEFAULT_TIMEOUT_MS;
    this.onOutput = options.onOutput;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.openSocket();

    if (this.intervalMs !== undefined && this.intervalMs > 0) {
      this.scheduleTimer = setInterval(() => this.trigger(), this.intervalMs);
      this.scheduleTimer.unref?.();
      this.trigger();
    }
  }

  /**
   * Requests one background run. Non-blocking and re-entrancy safe: a run
   * requested while another is still executing is dropped.
   */
  trigger(): void {
    if (!this.started || this.running || this.closing) {
      return;
    }

    void this.runOnce().catch((error) => {
      console.error("[sentinel] pre-flight run failed:", error);
    });
  }

  /**
   * Runs one suite and resolves with its parsed result (or undefined when
   * a run is already in flight). Used directly by CLI consumers.
   */
  async runOnce(): Promise<TestRunResult | undefined> {
    if (this.running || this.closing) {
      return undefined;
    }

    this.running = true;

    try {
      const startedAt = Date.now();
      const runner = this.runnerOverride ?? (await detectRunner(this.targetRoot));

      const { outcome, counts } = await runStrategy(
        runner,
        this.targetRoot,
        this.timeoutMs,
        this.onOutput
      );

      const result: TestRunResult = {
        runner,
        passed: counts.passed,
        failed: counts.failed,
        total: counts.total,
        durationMs: Date.now() - startedAt,
        ok: counts.failed === 0 && counts.total > 0 && outcome.code === 0
      };

      this.last = result;
      this.runsCompleted += 1;

      console.log(
        `[sentinel] pre-flight ${result.ok ? "OK" : "FAIL"} (${runner}): ${result.passed} passed, ${result.failed} failed of ${result.total}`
      );

      await this.publish(
        createOrbitalEvent({
          type: "preflight.reported",
          source: "sentinel",
          metadata: { runner, ok: result.ok },
          payload: {
            project: await projectNameFor(this.targetRoot),
            runner,
            passed: result.passed,
            failed: result.failed,
            total: result.total,
            durationMs: result.durationMs
          }
        })
      );

      return result;
    } finally {
      this.running = false;
    }
  }

  stats(): PreFlightStats {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      running: this.running,
      runsCompleted: this.runsCompleted,
      published: this.published,
      publishSkipped: this.publishSkipped,
      reconnects: this.reconnects,
      last: this.last === undefined ? undefined : { ...this.last },
      targetRoot: this.targetRoot
    };
  }

  close(): void {
    this.closing = true;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.scheduleTimer !== undefined) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }

    const socket = this.socket;

    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      return;
    }

    socket.terminate();
  }

  private async publish(event: ReturnType<typeof createOrbitalEvent>): Promise<void> {
    const socket = this.socket;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      this.publishSkipped += 1;

      return;
    }

    socket.send(JSON.stringify(event));
    this.published += 1;
  }

  private openSocket(): void {
    if (this.closing) {
      return;
    }

    const socket = new WebSocket(this.url);

    this.socket = socket;

    socket.on("message", (data) => {
      // Handshake frames are ignored; inbound bus traffic is not consumed.
      try {
        const frame = JSON.parse(data.toString());

        if (!isOrbitalEvent(frame)) {
          return;
        }
      } catch {
        // Ignore non-JSON link frames.
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
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : undefined;
}
