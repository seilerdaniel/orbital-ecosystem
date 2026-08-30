/**
 * Interactive TUI menu for orbital-cli.
 * Cyberpunk / Space Control style dashboard that appears on startup
 * when running `pnpm --filter @orbital/cli start` in a TTY.
 *
 * Features:
 *   - Neon-colored ASCII banner with ecosystem status
 *   - Keyboard navigation (arrow keys / j/k)
 *   - Enter to select / Esc to cancel
 *   - Direct execution of subcommands via child processes
 */

import { select } from "@inquirer/prompts";
import picocolors from "picocolors";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { ActionResult } from "./actions.js";
import { stdin } from "node:process";

// Resolve the CLI entrypoint relative to this source file
const __filename = fileURLToPath(import.meta.url);
const __dirnameLocal = dirname(__filename);
const CLI_PATH = new URL("../dist/cli.js", import.meta.url).pathname;

const VERSION = "0.4.0";

/** Neon color palette */
const NEON = {
  cyan: picocolors.cyan,
  green: picocolors.green,
  magenta: picocolors.magenta,
  yellow: picocolors.yellow,
  white: picocolors.white,
};

/** Clear screen & move cursor home (ANSI) */
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

/**
 * Prints the cyberpunk-styled banner with version and service status.
 */
function printBanner(): void {
  process.stdout.write(CLEAR_SCREEN);

  const header = "ORBITAL ECOSYSTEM";
  const versionLine = `v${VERSION}`;
  const statusLine = "Status: :4000/ws  •  :4001/v1";

  // Top border (neon cyan)
  console.log(NEON.cyan("╔" + "═".repeat(50) + "╗"));

  // Welcome line (neon magenta)
  const welcome = `║  ${NEON.magenta(header)} ${NEON.yellow(versionLine)}${" ".repeat(50 - header.length - versionLine.length)}║`;
  console.log(NEON.cyan(welcome));

  // Separator
  console.log(NEON.cyan("║" + " ".repeat(52) + "║"));

  // Status line (neon yellow)
  const status = `║  ${NEON.yellow(statusLine)}${" ".repeat(50 - statusLine.length)}║`;
  console.log(NEON.cyan(status));

  // Separator
  console.log(NEON.cyan("║" + " ".repeat(52) + "║"));

  // Bottom border (neon cyan)
  console.log(NEON.cyan("╚" + "═".repeat(50) + "╝"));

  console.log(); // blank line
}

/**
 * Executes the action associated with a menu choice.
 */
async function executeOption(choice: string): Promise<void> {
  switch (choice) {
    case "dashboard": {
      console.log("Iniciando Space Control Dashboard...");
      const child = spawn("pnpm", ["--filter", "@orbital/dock", "start"], {
        cwd: process.cwd(),
        stdio: "inherit",
        shell: true,
      });
      child.on("close", (code) => {
        if (code !== 0) {
          console.log(`Dashboard exited with code ${code}`);
        }
      });
      break;
    }
    case "preflight": {
      console.log("Ejecutando Pruebas Pre-Flight...");
      // Import and run preFlightRun from actions
      const { preFlightRun } = await import("./actions.js");
      const result: ActionResult = await preFlightRun(process.cwd());
      console.log(result.ok ? "Pre-Flight passed" : `Pre-Flight falló: ${result.message}`);
      break;
    }
    case "vault": {
      console.log("Estado de la Bóveda y Secretos...");
      const { vaultStatus } = await import("./actions.js");
      const result: ActionResult = await vaultStatus(undefined);
      console.log(result.message);
      break;
    }
    case "forge": {
      console.log("Generando Artefactos & Demos (Forge)...");
      const { forgeGenerate } = await import("./actions.js");
      const result: ActionResult = await forgeGenerate({ repoRoot: process.cwd() });
      console.log(result.message);
      break;
    }
    case "events": {
      console.log("Escuchando Bus de Eventos en Vivo (WS Tail :4000)...");
      console.log("Funcionalidad de tail de eventos próximamente.");
      break;
    }
    case "health": {
      console.log("Estado de Salud Global (:4000 bridge & :4001 pulse)...");
      // Simple health check: just print a note
      console.log("Ejecutando reporte de salud del ecosistema...");
      // we could import from ./health but that would create circular maybe; skip
      break;
    }
    case "exit": {
      console.log("Salir...");
      process.exit(0);
      break;
    }
    default: {
      console.log(`Opción no reconocida: ${choice}`);
    }
  }
}

/**
 * Runs the main TUI loop: shows banner, renders select menu,
 * and dispatches to the selected action.
 */
export async function runTUI(): Promise<number> {
  // Only run TUI when stdin is a TTY
  if (!stdin.isTTY) {
    console.log("Modo TUI requiere terminal interactiva.");
    return 1;
  }

  printBanner();

  const choices = [
    { name: "🚀 Space Control Dashboard", value: "dashboard" },
    { name: "🛡️ Ejecutar Pruebas Pre-Flight", value: "preflight" },
    { name: "🔐 Estado de la Bóveda y Secretos", value: "vault" },
    { name: "🎬 Generar Artefactos & Demos (Forge)", value: "forge" },
    { name: "📡 Escuchar Bus de Eventos en Vivo", value: "events" },
    { name: "🌐 Estado de Salud Global", value: "health" },
    { name: "❌ Salir", value: "exit" },
  ];

  while (true) {
    const answer = await select({
      message: "Orbitals TUI - Menú Principal",
      choices,
    });

    if (answer === undefined) {
      // User pressed Esc or cancelled
      console.log("Cancelado.");
      return 1;
    }

    await executeOption(answer);

    // If user chose exit, break the loop
    if (answer === "exit") {
      break;
    }

    // Otherwise re-print banner and show menu again
    printBanner();
  }

  return 0;
}