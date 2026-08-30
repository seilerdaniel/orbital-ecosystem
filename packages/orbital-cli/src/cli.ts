#!/usr/bin/env node

/**
 * @orbital/cli — command line entry point.
 *
 * Interactive wizard by default (TTY, no args); subcommands expose every
 * module: vault secret management, sentinel Pre-Flight runs, forge content
 * generation, bridge status and event tail.
 */

import { pathToFileURL } from "node:url";
import { stdin } from "node:process";

import { checkEcosystem, renderHealthReport } from "./health.js";
import { collectRecentEvents, formatTailEvent } from "./events-tail.js";
import { runVerification } from "./tests.js";
import {
  forgeGenerate,
  preFlightRun,
  vaultExec,
  vaultList,
  vaultSet,
  vaultStatus
} from "./actions.js";

const VERSION = "1.0.0";

const HELP = `orbital - Orbital ecosystem CLI

Usage:
  orbital [wizard]         Interactive step-by-step wizard
  orbital status           Ecosystem health report
  orbital events           List recent bus events (live tail)
  orbital test             Pre-Flight suite for the active directory
  orbital verify           Legacy gate: workspace tests + typecheck
  orbital forge            Render RELEASE_NOTES.md + DEMO_SCRIPT.md now
  orbital vault status     Vault file/state report (no decryption)
  orbital vault list       List registered key names (requires unlock)
  orbital vault set <key>  Store a secret via hidden input
  orbital vault exec       Inject credentials into a child process
  orbital agents           List registered commands
  orbital --help | help    Show this message
  orbital --version        Print the CLI version

Vault exec example:
  orbital vault exec --map '{"GITHUB_TOKEN":"github/pat"}' -- node agent.js`;

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);

  return index === -1 ? undefined : args[index + 1];
}

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
  const sources = parseSources(flagValue(argv, "--source"));
  const rawDuration = Number(flagValue(argv, "--duration"));
  const durationMs =
    Number.isFinite(rawDuration) && rawDuration > 0
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

async function runPreFlightCommand(args: readonly string[]): Promise<number> {
  const targetRoot = flagValue(args, "--target") ?? process.cwd();
  const result = await preFlightRun(targetRoot);

  return result.ok ? 0 : 1;
}

async function runForgeCommand(args: readonly string[]): Promise<number> {
  const result = await forgeGenerate({
    title: flagValue(args, "--title"),
    outDir: flagValue(args, "--out"),
    repoRoot: process.cwd(),
    query: flagValue(args, "--query")
  });

  return result.ok ? 0 : 1;
}

const VAULT_HELP = `orbital vault - encrypted secret store management

Usage:
  orbital vault status           File/state report (no decryption)
  orbital vault list             Registered key names (asks passphrase)
  orbital vault set <key>        Store/update one secret (hidden input)
  orbital vault exec ...         Spawn a child with resolved credentials
  orbital vault --help | help    Show this message

Exec options:
  --map '<json>'                 {"ENV_NAME":"vault/key"} alias map
  --db <path>                    Vault file override
  -- <command> [args...]         Child command receiving the env`;

async function runVault(args: readonly string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case undefined:
    case "--help":
    case "help": {
      console.log(VAULT_HELP);

      return 0;
    }
    case "status": {
      const result = await vaultStatus(flagValue(rest, "--db"));

      return result.ok ? 0 : 1;
    }
    case "list": {
      const result = await vaultList(flagValue(rest, "--db"));

      return result.ok ? 0 : 1;
    }
    case "set": {
      const result = await vaultSet(rest[0], flagValue(rest, "--db"));

      return result.ok ? 0 : 1;
    }
    case "exec": {
      const result = await vaultExec(rest);

      return result.ok ? 0 : 1;
    }
    default: {
      console.error(`Unknown vault subcommand: ${String(sub)}\n\n${VAULT_HELP}`);

      return 1;
    }
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  const command = argv[0];

  switch (command) {
    case undefined: {
      if (stdin.isTTY) {
        const { runTUI } = await import("./tui.js");

        return runTUI();
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
      console.log("Registered commands: wizard, status, events, test, verify, forge, vault");

      return 0;
    }
    case "status": {
      return printStatus();
    }
    case "events": {
      return printEvents(argv.slice(1));
    }
    case "test": {
      return runPreFlightCommand(argv.slice(1));
    }
    case "verify": {
      return printVerification();
    }
    case "forge": {
      return runForgeCommand(argv.slice(1));
    }
    case "vault": {
      return runVault(argv.slice(1));
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
