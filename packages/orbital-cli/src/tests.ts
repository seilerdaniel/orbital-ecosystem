/**
 * Verification runner used by `orbital test` and the wizard.
 *
 * Runs workspace tests when packages define a `test` script, then always
 * runs the root typecheck as a compile-level gate. Output is streamed to
 * the console and summarized per step.
 */

import { spawnSync } from "node:child_process";

export interface CheckResult {
  readonly command: string;
  readonly ok: boolean;
  readonly detail: string;
}

function runStep(command: string, args: readonly string[]): CheckResult {
  const child = spawnSync(command, [...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
    env: process.env
  });

  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`.trim();

  if (child.error !== undefined) {
    return { command: [command, ...args].join(" "), ok: false, detail: String(child.error) };
  }

  const tail = output.split(/\r?\n/).slice(-6).join("\n");

  return {
    command: [command, ...args].join(" "),
    ok: child.status === 0,
    detail: tail
  };
}

/** Tests first (`--if-present`), then the typecheck gate. Never throws. */
export function runVerification(): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(runStep("pnpm", ["-r", "--if-present", "run", "test"]));
  results.push(runStep("pnpm", ["-w", "run", "typecheck"]));

  return results;
}
