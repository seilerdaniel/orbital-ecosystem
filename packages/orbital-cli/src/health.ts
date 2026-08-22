/**
 * Ecosystem health probes used by `orbital status` and the interactive
 * wizard. A service is healthy when its `/health` endpoint answers within
 * the timeout with an ok HTTP status.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

/** Counts @orbital/* workspace packages whose dist output is present. */
export function builtPackages(rootDir: string): { total: number; built: number } {
  const packagesDir = join(rootDir, "packages");

  if (!existsSync(packagesDir)) {
    return { total: 0, built: 0 };
  }

  const entries = readdirSafe(packagesDir);
  const total = entries.length;

  let built = 0;

  for (const entry of entries) {
    if (existsSync(join(packagesDir, entry, "dist", "index.js"))) {
      built += 1;
    }
  }

  return { total, built };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

export async function checkEcosystem(
  rootDir: string = process.cwd()
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
