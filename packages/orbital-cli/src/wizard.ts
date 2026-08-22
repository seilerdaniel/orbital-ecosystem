/**
 * Interactive step-by-step wizard: monorepo health, Sentinel/Pulse event
 * listing, and the verification suite. Plain readline — no TUI deps.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  checkEcosystem,
  renderHealthReport
} from "./health.js";
import {
  collectRecentEvents,
  formatTailEvent
} from "./events-tail.js";
import { runVerification } from "./tests.js";

const MENU = `
=== Orbital wizard ===

 1) Monorepo health check (bridge / pulse / packages)
 2) List recent Sentinel/Pulse events (live tail)
 3) Run verification (tests + typecheck)
 0) Exit
`;

export async function runWizard(): Promise<number> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    for (;;) {
      console.log(MENU);
      const answer = (await rl.question("Choose a step: ")).trim();

      switch (answer) {
        case "1": {
          await healthStep();
          break;
        }
        case "2": {
          await eventsStep(rl);
          break;
        }
        case "3": {
          verificationStep();
          break;
        }
        case "0":
        case "q":
        case "exit": {
          console.log("Bye.");
          return 0;
        }
        default: {
          console.log(`Unknown option: ${answer}`);
        }
      }
    }
  } finally {
    rl.close();
  }
}

async function healthStep(): Promise<void> {
  console.log("Probing services...");
  const report = renderHealthReport(await checkEcosystem());

  console.log(report);
}

async function eventsStep(rl: ReturnType<typeof createInterface>): Promise<void> {
  const scope = (
    await rl.question("Scope [s]entinel / [p]ulse / [a]ll (default s+p): ")
  )
    .trim()
    .toLowerCase();

  const sources =
    scope === "a" || scope === "all"
      ? ["dock", "mobile", "cli", "bridge", "vault", "pulse", "forge", "sentinel", "synapse"]
      : scope === "p"
        ? ["pulse"]
        : scope === "s"
          ? ["sentinel"]
          : ["sentinel", "pulse"];

  const seconds = Number((await rl.question("Listen seconds (default 5): ")).trim()) || 5;

  console.log(`Tailing ws://127.0.0.1:4000/ws for ${seconds}s (sources: ${sources.join(", ")})...`);

  const events = await collectRecentEvents({
    sources,
    durationMs: Math.min(Math.max(seconds * 1000, 1000), 60_000),
    onEvent: (event) => console.log(`  ${formatTailEvent(event)}`)
  });

  console.log(events.length === 0 ? "No matching events observed." : `${events.length} event(s).`);
}

function verificationStep(): void {
  console.log("Running tests (--if-present) and the workspace typecheck...");

  const results = runVerification();

  for (const result of results) {
    console.log(`${result.ok ? "[ok]" : "[FAIL]"} $ ${result.command}`);

    if (result.detail !== "") {
      console.log(result.detail.split(/\r?\n/).map((line) => `    ${line}`).join("\n"));
    }
  }

  console.log(
    results.every((result) => result.ok)
      ? "Verification: GREEN"
      : "Verification: FAILED (see steps above)"
  );
}
