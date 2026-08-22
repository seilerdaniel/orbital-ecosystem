#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const HELP = `orbital - Orbital ecosystem CLI

Usage:
  orbital agents            List available commands
  orbital status            Show ecosystem status
  orbital --help | help     Show this message
  orbital --version         Print the CLI version`;

const VERSION = "0.1.0";

export function run(argv: readonly string[]): number {
  const command = argv[0];

  switch (command) {
    case undefined:
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
      console.log("Registered commands: agents, status");

      return 0;
    }
    case "status": {
      console.log("Orbital ecosystem: scaffolded, awaiting first mission.");

      return 0;
    }
    default: {
      console.error(`Unknown command: ${String(command)}\n\n${HELP}`);

      return 1;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
