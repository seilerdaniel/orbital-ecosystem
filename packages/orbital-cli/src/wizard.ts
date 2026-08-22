/**
 * Interactive step-by-step wizard exposing the whole monorepo: ecosystem
 * health + vault state, Pre-Flight test runs, Forge content generation,
 * and the live bridge event tail. Plain readline — no TUI deps.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { checkEcosystem, renderHealthReport } from "./health.js";
import { collectRecentEvents, formatTailEvent } from "./events-tail.js";
import { forgeGenerate, preFlightRun, vaultList, vaultStatus } from "./actions.js";

const MENU = `
=== Orbital wizard ===

 1) Ecosystem health & vault status
 2) Run Pre-Flight tests
 3) Generate releases & demos (Forge)
 4) Listen to live events (WS tail)
 v) List vault keys
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
          await healthAndVaultStep();
          break;
        }
        case "2": {
          await preflightStep(rl);
          break;
        }
        case "3": {
          await forgeStep(rl);
          break;
        }
        case "4": {
          await eventsStep(rl);
          break;
        }
        case "v":
        case "V": {
          await vaultList();
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

async function healthAndVaultStep(): Promise<void> {
  console.log("Probing services...");
  console.log(renderHealthReport(await checkEcosystem()));
  console.log("");
  await vaultStatus();
}

async function preflightStep(rl: ReturnType<typeof createInterface>): Promise<void> {
  const target = (await rl.question(`Target directory (default ${process.cwd()}): `)).trim();

  const result = await preFlightRun(target === "" ? process.cwd() : target);

  if (!result.ok) {
    console.log(`Pre-Flight did not pass: ${result.message}`);
  }
}

async function forgeStep(rl: ReturnType<typeof createInterface>): Promise<void> {
  const title = (await rl.question("Release title (blank = today's date): ")).trim();
  const outDir = (await rl.question(`Output directory (default ./forge-out): `)).trim();

  const result = await forgeGenerate({
    ...(title === "" ? {} : { title }),
    ...(outDir === "" ? {} : { outDir }),
    repoRoot: process.cwd()
  });

  if (!result.ok) {
    console.log(`Forge render failed: ${result.message}`);
  }
}

async function eventsStep(rl: ReturnType<typeof createInterface>): Promise<void> {
  const scope = (
    await rl.question("Scope [s]entinel / [p]ulse / [f]orge / [y]napse / [a]ll (default all): ")
  )
    .trim()
    .toLowerCase();

  const sources =
    scope === "s"
      ? ["sentinel"]
      : scope === "p"
        ? ["pulse"]
        : scope === "f"
          ? ["forge"]
          : scope === "y"
            ? ["synapse"]
            : ["dock", "mobile", "cli", "bridge", "vault", "pulse", "forge", "sentinel", "synapse"];

  const seconds = Number((await rl.question("Listen seconds (default 5): ")).trim()) || 5;

  console.log(
    `Tailing ws://127.0.0.1:4000/ws for ${seconds}s (sources: ${sources.join(", ")})...`
  );

  const events = await collectRecentEvents({
    sources,
    durationMs: Math.min(Math.max(seconds * 1000, 1000), 60_000),
    onEvent: (event) => console.log(`  ${formatTailEvent(event)}`)
  });

  console.log(events.length === 0 ? "No matching events observed." : `${events.length} event(s).`);
}
