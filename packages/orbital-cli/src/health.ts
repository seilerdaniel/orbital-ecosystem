/**
 * Ecosystem health probes used by `orbital status` and the interactive
 * wizard. A service is healthy when its `/health` endpoint answers within
 * the timeout with an ok HTTP status.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServiceHealth {
  readonly name: string;
  readonly url: string;
  readonly ok: boolean;
  readonly detail: string;
}

const DEFAULT_BRIDGE_HTTP = "http://127.0.0.1:4000";
const DEFAULT_PULSE_HTTP = "http://127.0.0.1:4001";

function summarizeBody(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }

  const record = body as Record<string, unknown>;
  const parts = Object.entries(record)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`);

  return parts.join(" ");
}

async function probeService(
  name: string,
  baseUrl: string,
  timeoutMs = 1500
): Promise<ServiceHealth> {
  const url = `${baseUrl}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));

    return {
      name,
      url,
      ok: response.ok,
      detail: response.ok ? summarizeBody(body) : `HTTP ${response.status}`
    };
  } catch {
    return { name, url, ok: false, detail: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Counts @orbital/* workspace packages whose compiled entry output is present. */
export function builtPackages(rootDir: string): { total: number; built: number } {
  const packagesDir = join(rootDir, "packages");

  if (!existsSync(packagesDir)) {
    return { total: 0, built: 0 };
  }

  const entries = readdirSafe(packagesDir);
  const total = entries.length;

  let built = 0;

  for (const entry of entries) {
    if (existsSync(join(packagesDir, entry, declaredEntry(packagesDir, entry)))) {
      built += 1;
    }
  }

  return { total, built };
}

/** Resolves the compiled entry file from package.json "main", defaulting to dist/index.js. */
function declaredEntry(packagesDir: string, name: string): string {
  const fallback = normalize("dist/index.js");

  try {
    const manifest = JSON.parse(
      readFileSync(join(packagesDir, name, "package.json"), "utf8")
    ) as { main?: string };

    return typeof manifest.main === "string" ? normalize(manifest.main) : fallback;
  } catch {
    return fallback;
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

const WORKSPACE_MARKER = "pnpm-workspace.yaml";

/**
 * Locates the monorepo root so `orbital status` reports accurate package
 * counts regardless of the working directory pnpm runs the script from
 * (filtered invocations execute with cwd set to the package directory).
 */
export function findMonorepoRoot(startDir: string = process.cwd()): string {
  for (const origin of [startDir, dirname(fileURLToPath(import.meta.url))]) {
    let current = origin;

    while (true) {
      if (existsSync(join(current, WORKSPACE_MARKER))) {
        return current;
      }

      const parent = dirname(current);

      if (parent === current) {
        break;
      }

      current = parent;
    }
  }

  return startDir;
}

export async function checkEcosystem(
  rootDir: string = findMonorepoRoot()
): Promise<{ services: ServiceHealth[]; packages: { total: number; built: number } }> {
  const services = await Promise.all([
    probeService(
      "bridge",
      process.env.ORBITAL_BRIDGE_HTTP ?? DEFAULT_BRIDGE_HTTP
    ),
    probeService(
      "pulse",
      process.env.ORBITAL_PULSE_HTTP ?? DEFAULT_PULSE_HTTP
    )
  ]);

  return { services, packages: builtPackages(rootDir) };
}

export function renderHealthReport(health: Awaited<ReturnType<typeof checkEcosystem>>): string {
  const lines: string[] = [];

  lines.push("Ecosystem health");
  lines.push("----------------");

  for (const service of health.services) {
    lines.push(`${service.ok ? "[ok]" : "[--]"} ${service.name.padEnd(8)} ${service.url}  ${service.detail}`);
  }

  lines.push(
    `${health.packages.built}/${health.packages.total} workspace packages built`
  );

  const allGreen =
    health.services.every((service) => service.ok) &&
    health.packages.built === health.packages.total;

  lines.push(allGreen ? "Overall: GREEN" : "Overall: DEGRADED (details above)");

  return lines.join("\n");
}
