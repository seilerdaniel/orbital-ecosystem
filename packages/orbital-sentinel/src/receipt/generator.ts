/**
 * RDD receipt generator — compiles the evidence of one verified candidate
 * into a portable `.receipt.json` artifact.
 *
 * A receipt binds an exact candidate (commit/branch/files) to its checks,
 * command evidence, and optional AgentShield outcome. Downstream consumers
 * (synapse memory, CI gates) must treat a receipt as valid only when it
 * passes {@link isRddReceipt} and carries verdict "approved".
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const RECEIPT_FILE_NAME = ".receipt.json";
export const RECEIPT_SCHEMA_VERSION = "1.0" as const;

export type ReceiptVerdict = "approved" | "rejected" | "blocked";
export type ReceiptCheckStatus = "pass" | "fail" | "skipped";

export interface ReceiptCheck {
  readonly name: string;
  readonly status: ReceiptCheckStatus;
  readonly detail?: string;
}

export interface ReceiptEvidence {
  /** Exact command or procedure executed. */
  readonly command: string;
  readonly ok: boolean;
  /** One-line result summary (no secrets). */
  readonly summary: string;
}

export interface ReceiptCandidate {
  readonly commit?: string;
  readonly branch?: string;
  readonly filesChanged?: readonly string[];
}

export interface ReceiptShieldSummary {
  readonly verdict: "pass" | "warn" | "fail";
  readonly findings: number;
  readonly criticalFindings?: number;
}

export interface RDDReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly createdAt: string;
  readonly taskId?: string;
  readonly title: string;
  readonly candidate: ReceiptCandidate;
  readonly checks: readonly ReceiptCheck[];
  readonly evidence: readonly ReceiptEvidence[];
  readonly shield?: ReceiptShieldSummary;
  readonly verdict: ReceiptVerdict;
  readonly lineage?: { readonly parentReceiptId?: string; readonly note?: string };
  readonly notes?: string;
}

export interface GenerateReceiptOptions {
  readonly title: string;
  readonly taskId?: string;
  readonly candidate?: ReceiptCandidate;
  readonly checks?: readonly ReceiptCheck[];
  readonly evidence?: readonly ReceiptEvidence[];
  readonly shield?: ReceiptShieldSummary;
  /** Overrides automatic derivation when provided. */
  readonly verdict?: ReceiptVerdict;
  readonly lineage?: { readonly parentReceiptId?: string; readonly note?: string };
  readonly notes?: string;
  readonly now?: Date;
  readonly id?: string;
}

/**
 * Derives the verdict from evidence unless explicitly overridden:
 * - any failing check -> rejected
 * - shield fail -> blocked
 * - otherwise approved (skipped checks do not block approval)
 */
function deriveVerdict(options: GenerateReceiptOptions): ReceiptVerdict {
  if (options.verdict !== undefined) {
    return options.verdict;
  }

  if ((options.checks ?? []).some((check) => check.status === "fail")) {
    return "rejected";
  }

  if (options.shield?.verdict === "fail") {
    return "blocked";
  }

  return "approved";
}

/** Compiles a fully populated, candidate-bound receipt. */
export function generateReceipt(options: GenerateReceiptOptions): RDDReceipt {
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId: options.id ?? randomUUID(),
    createdAt: (options.now ?? new Date()).toISOString(),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    title: options.title,
    candidate: options.candidate ?? {},
    checks: Object.freeze([...(options.checks ?? [])]),
    evidence: Object.freeze([...(options.evidence ?? [])]),
    ...(options.shield === undefined ? {} : { shield: options.shield }),
    verdict: deriveVerdict(options),
    ...(options.lineage === undefined ? {} : { lineage: options.lineage }),
    ...(options.notes === undefined ? {} : { notes: options.notes })
  });
}

/** Structural guard for untrusted receipts read back from disk or the bus. */
export function isRddReceipt(value: unknown): value is RDDReceipt {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    candidate.schemaVersion === RECEIPT_SCHEMA_VERSION &&
    typeof candidate.receiptId === "string" &&
    candidate.receiptId.length > 0 &&
    typeof candidate.createdAt === "string" &&
    !Number.isNaN(Date.parse(candidate.createdAt)) &&
    typeof candidate.title === "string" &&
    typeof candidate.candidate === "object" &&
    candidate.candidate !== null &&
    Array.isArray(candidate.checks) &&
    Array.isArray(candidate.evidence) &&
    (candidate.verdict === "approved" ||
      candidate.verdict === "rejected" ||
      candidate.verdict === "blocked")
  );
}

/**
 * Writes the receipt as `<directory>/.receipt.json` (pretty-printed,
 * trailing newline) and resolves with the absolute path.
 */
export async function writeReceipt(directory: string, receipt: RDDReceipt): Promise<string> {
  const target = resolve(directory, RECEIPT_FILE_NAME);

  await mkdir(resolve(directory), { recursive: true });
  await writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  return target;
}

/** Reads and validates a receipt file; undefined when missing. */
export async function readReceipt(filePath: string): Promise<RDDReceipt | undefined> {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(`Receipt at ${filePath} is not valid JSON`);
  }

  if (!isRddReceipt(parsed)) {
    throw new TypeError(`Receipt at ${filePath} does not satisfy the RDD contract`);
  }

  return parsed;
}
