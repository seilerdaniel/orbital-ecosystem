#!/usr/bin/env node

/**
 * @orbital/cli — command line entry point.
 *
 * Interactive wizard by default (TTY, no args); subcommands stay available
 * for scripting: status, events, test/verify, help, --version.
 */

import { pathToFileURL } from "node:url";
import { stdin } from "node:process";

import { checkEcosystem, renderHealthReport } from "./health.js";
import { collectRecentEvents, formatTailEvent } from "./events-tail.js";
import { runVerification } from "./tests.js";

const VERSION = "0.1.0";

const HELP = `orbital - Orbital ecosystem CLI

Usage:
  orbital [wizard]         Interactive step-by-step wizard
  orbital status           Non-interactive ecosystem health report
  orbital events           List recent Sentinel/Pulse events (live tail)
  orbital test             Run tests (--if-present) + workspace typecheck
  orbital agents           List registered commands
  orbital --help | help    Show this message
  orbital --version        Print the CLI version`;

function parseSources(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
}

async function printStatus(): Promise<number> {
  console.log(renderHealthReport(await checkEcosystem()));

  return 0;
}

async function printEvents(argv: readonly string[]): Promise<number> {
  const sourceFlagIndex = argv.indexOf("--source");
  const sources = parseSources(sourceFlagIndex === -1 ? undefined : argv[sourceFlagIndex + 1]);
  const durationFlagIndex = argv.indexOf("--duration");
  const rawDuration =
    durationFlagIndex === -1 ? undefined : Number(argv[durationFlagIndex + 1]);
  const durationMs =
    rawDuration !== undefined && Number.isFinite(rawDuration)
      ? Math.min(Math.max(rawDuration, 1000), 60_000)
      : 6000;

  console.log(`Tailing bridge events for ${Math.round(durationMs / 1000)}s...`);

  const events = await collectRecentEvents({ sources, durationMs });

  if (events.length === 0) {
    console.log("No matching events observed.");

    return 0;
  }

  for (const event of events) {
    console.log(formatTailEvent(event));
  }

  console.log(`${events.length} event(s).`);

  return 0;
}

function printVerification(): number {
  const results = runVerification();

  for (const result of results) {
    console.log(`${result.ok ? "[ok]" : "[FAIL]"} $ ${result.command}`);

    if (result.detail !== "") {
      console.log(result.detail.split(/\r?\n/).map((line) => `    ${line}`).join("\n"));
    }
  }

  return results.every((result) => result.ok) ? 0 : 1;
}

export async function run(argv: readonly string[]): Promise<number> {
  const command = argv[0];

  switch (command) {
    case undefined: {
      if (stdin.isTTY) {
        const { runWizard } = await import("./wizard.js");

        return runWizard();
      }

      console.log(HELP);

      return 0;
    }
    case "wizard": {
      const { runWizard } = await import("./wizard.js");

      return runWizard();
    }
    case "--help":
    case "help": {
      console.log(HELP);

      return 0;
    }
    case "--version": {
      console.log(VERSION);

      return 0;
    }
    case "agents": {
      console.log("Registered commands: wizard, status, events, test");

      return 0;
    }
    case "status": {
      return printStatus();
    }
    case "events": {
      return printEvents(argv.slice(1));
    }
    case "test":
    case "verify": {
      return printVerification();
    }
    default: {
      console.error(`Unknown command: ${String(command)}\n\n${HELP}`);

      return 1;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
