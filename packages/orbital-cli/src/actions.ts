/**
 * Shared wizard/subcommand actions. Every function prints its own report
 * and returns an ActionResult so callers (CLI dispatch, interactive
 * wizard, smoke harnesses) can branch on the outcome.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { PreFlightRunner } from "@orbital/sentinel";
import { renderContentPackage } from "@orbital/forge";
import { SqliteVault, DEFAULT_VAULT_PATH } from "@orbital/vault";
import { VectorStore } from "@orbital/synapse";

import { askHidden } from "./prompt.js";

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Vault (orbital-vault)
// ---------------------------------------------------------------------------

function vaultPathFrom(flagValue: string | undefined): string {
  return resolve(flagValue ?? process.env.ORBITAL_VAULT_DB ?? DEFAULT_VAULT_PATH);
}

/** Non-interactive state report; never decrypts anything. */
export async function vaultStatus(dbFlag?: string): Promise<ActionResult> {
  const dbPath = vaultPathFrom(dbFlag);
  const lines = ["Vault status", `  path : ${dbPath}`];

  if (!existsSync(dbPath)) {
    lines.push("  file : absent", "  hint : create it with 'orbital vault set <key>'");
    console.log(lines.join("\n"));

    return { ok: true, message: "absent" };
  }

  lines.push("  file : present");
  lines.push("  state: LOCKED (passphrase required for any secret access)");

  console.log(lines.join("\n"));

  return { ok: true, message: "locked" };
}

async function unlockedVault(
  dbFlag: string | undefined,
  passphraseOverride?: string
): Promise<SqliteVault> {
  const vault = new SqliteVault({ path: vaultPathFrom(dbFlag) });
  const passphrase =
    passphraseOverride ??
    (await askHidden(`Passphrase for ${vaultPathFrom(dbFlag)}: `));

  try {
    vault.unlock(passphrase);

    return vault;
  } catch {
    vault.close();

    throw new Error("unlock failed: wrong passphrase or corrupted vault");
  }
}

/** Lists REGISTERED KEY NAMES only — values never leave the store. */
export async function vaultList(dbFlag?: string): Promise<ActionResult> {
  let vault: SqliteVault;

  try {
    vault = await unlockedVault(dbFlag);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return { ok: false, message: "locked" };
  }

  try {
    const names = vault.listSecrets();

    console.log(`${names.length} key(s) registered:`);

    for (const name of names) {
      console.log(`  - ${name}`);
    }

    return { ok: true, message: `${names.length} key(s)` };
  } finally {
    vault.close();
  }
}

/** Stores one secret read through hidden input. */
export async function vaultSet(key: string | undefined, dbFlag?: string): Promise<ActionResult> {
  if (key === undefined || key.trim() === "") {
    console.error("usage: orbital vault set <key>");

    return { ok: false, message: "missing key" };
  }

  const normalizedKey = key.trim();
  const value = await askHidden(`Value for "${normalizedKey}" (hidden): `);

  if (value === "") {
    console.error("empty value rejected");

    return { ok: false, message: "empty value" };
  }

  let vault: SqliteVault;

  try {
    vault = await unlockedVault(dbFlag);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return { ok: false, message: "locked" };
  }

  try {
    vault.setSecret(normalizedKey, value);
    console.log(`stored "${normalizedKey}".`);

    return { ok: true, message: `stored ${normalizedKey}` };
  } finally {
    vault.close();
  }
}

/**
 * Credential injection for subagent processes: resolves the alias map
 * ({ ENV_NAME: "vault/key" }) into real env vars for ONE child process.
 * Values exist only in that child's environment — never printed.
 */
export async function vaultExec(args: readonly string[]): Promise<ActionResult> {
  const mapIndex = args.indexOf("--map");

  if (mapIndex === -1 || args[mapIndex + 1] === undefined) {
    console.error('usage: orbital vault exec --map \'{"ENV_NAME":"vault/key"}\' -- <command> [args...]');

    return { ok: false, message: "missing map" };
  }

  let mapping: Record<string, string>;

  try {
    mapping = JSON.parse(args[mapIndex + 1] as string) as Record<string, string>;
  } catch {
    console.error("--map is not valid JSON");

    return { ok: false, message: "bad map" };
  }

  const separator = args.indexOf("--");
  const command = separator === -1 ? undefined : args[separator + 1];
  const commandArgs = separator === -1 ? [] : args.slice(separator + 2);

  if (command === undefined) {
    console.error("no command after '--'");

    return { ok: false, message: "missing command" };
  }

  const dbFlagIndex = args.indexOf("--db");
  let vault: SqliteVault;

  try {
    vault = await unlockedVault(dbFlagIndex === -1 ? undefined : args[dbFlagIndex + 1]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return { ok: false, message: "locked" };
  }

  try {
    const missing = Object.values(mapping).filter((alias) => vault.getSecret(alias) === undefined);

    if (missing.length > 0) {
      console.error(`unknown vault alias(es): ${missing.join(", ")}`);

      return { ok: false, message: "unknown alias" };
    }

    const childEnv = vault.buildChildEnv(mapping);

    console.log(`$ ${command} ${commandArgs.join(" ")}`);

    const code = await new Promise<number>((resolvePromise) => {
      const child = spawn(command, [...commandArgs], {
        cwd: process.cwd(),
        env: childEnv,
        stdio: "inherit",
        shell: process.platform === "win32"
      });

      child.on("error", (error) => {
        console.error(String(error));
        resolvePromise(1);
      });
      child.on("close", resolvePromise);
    });

    return { ok: code === 0, message: `exit ${code}` };
  } finally {
    vault.close();
  }
}

// ---------------------------------------------------------------------------
// Pre-Flight (orbital-sentinel)
// ---------------------------------------------------------------------------

/** Single-shot suite run with live output passthrough and parsed summary. */
export async function preFlightRun(targetRoot: string): Promise<ActionResult> {
  console.log(`[pre-flight] detecting test runner in ${resolve(targetRoot)} …`);

  const runner = new PreFlightRunner({
    targetRoot,
    onOutput: (chunk) => process.stdout.write(chunk)
  });

  const result = await runner.runOnce();
  runner.close();

  if (result === undefined) {
    console.error("[pre-flight] a run is already in progress");

    return { ok: false, message: "busy" };
  }

  const verdict =
    result.ok === true
      ? "OK"
      : result.total === 0 && result.failed === 0
        ? "NO COUNTS PARSED"
        : "FAILING";

  console.log("");
  console.log("Pre-Flight summary");
  console.log("------------------");
  console.log(`runner   : ${result.runner}`);
  console.log(`passed   : ${result.passed}`);
  console.log(`failed   : ${result.failed}`);
  console.log(`total    : ${result.total}`);
  console.log(`duration : ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`verdict  : ${verdict}`);

  return { ok: result.ok, message: `${result.passed}/${result.total} (${verdict})` };
}

// ---------------------------------------------------------------------------
// Forge content generation
// ---------------------------------------------------------------------------

export interface ForgeOptions {
  readonly title?: string;
  readonly outDir?: string;
  readonly repoRoot?: string;
  readonly query?: string;
}

/** Renders RELEASE_NOTES.md + DEMO_SCRIPT.md + montage project on demand. */
export async function forgeGenerate(options: ForgeOptions = {}): Promise<ActionResult> {
  const outputDir = resolve(options.outDir ?? process.env.ORBITAL_FORGE_OUT ?? "forge-out");
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const title = options.title ?? `Orbital release — ${new Date().toISOString().slice(0, 10)}`;

  const store = new VectorStore({});

  try {
    const result = await renderContentPackage({
      title,
      outputDir,
      repoRoot,
      ...(options.query === undefined ? {} : { demoQuery: options.query }),
      store
    });

    console.log("Forge render complete:");
    console.log(`  title : ${title}`);

    for (const file of result.files) {
      console.log(`  wrote : ${file.path} (${file.bytes} bytes)`);
    }

    console.log(
      `  scenes: ${result.storyboard.scenes.length} · runtime ${result.storyboard.totalDurationSec}s`
    );

    return { ok: true, message: `${result.files.length} artifact(s) in ${outputDir}` };
  } catch (error) {
    console.error(`forge render failed: ${error instanceof Error ? error.message : String(error)}`);

    return { ok: false, message: "render failed" };
  } finally {
    store.close();
  }
}
