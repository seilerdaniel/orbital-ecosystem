/**
 * AgentShield — deterministic security scanner for code diffs.
 *
 * Flags exposed credentials (API keys, tokens, private keys), destructive
 * shell/SQL commands, and risky file additions in unified diffs or raw text.
 * Pure pattern matching: no I/O, no network, fully reproducible verdicts so
 * receipts can bind to an exact scan result.
 */

export type ShieldSeverity = "critical" | "high" | "medium" | "low";

export interface ShieldFinding {
  readonly ruleId: string;
  readonly severity: ShieldSeverity;
  readonly message: string;
  /** File the finding belongs to (diff path or caller-provided label). */
  readonly file?: string;
  /** 1-based line number inside the added content. */
  readonly line?: number;
  /** Trimmed offending line (secrets are partially redacted). */
  readonly excerpt: string;
}

export interface ShieldReport {
  readonly scannedFiles: number;
  readonly findings: readonly ShieldFinding[];
  readonly maxSeverity: ShieldSeverity | undefined;
  /**
   * pass = no findings; warn = medium/low only; fail = any critical/high.
   */
  readonly verdict: "pass" | "warn" | "fail";
}

/** One file's diff in unified format (`@@ … @@` hunks with +/- lines). */
export interface DiffFile {
  readonly path: string;
  readonly patch: string;
}

interface ShieldRule {
  readonly id: string;
  readonly severity: ShieldSeverity;
  readonly message: string;
  readonly pattern: RegExp;
}

const SEVERITY_ORDER: Readonly<Record<ShieldSeverity, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

const RULES: readonly ShieldRule[] = [
  // --- Exposed credentials -------------------------------------------------
  {
    id: "aws-access-key",
    severity: "critical",
    message: "AWS access key id looks hardcoded",
    pattern: /\bAKIA[0-9A-Z]{16}\b/
  },
  {
    id: "github-token",
    severity: "critical",
    message: "GitHub token looks hardcoded",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/
  },
  {
    id: "private-key-block",
    severity: "critical",
    message: "Private key material embedded in source",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  },
  {
    id: "openai-key",
    severity: "high",
    message: "OpenAI-style API key looks hardcoded",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/
  },
  {
    id: "google-api-key",
    severity: "high",
    message: "Google API key looks hardcoded",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/
  },
  {
    id: "slack-token",
    severity: "high",
    message: "Slack token looks hardcoded",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/
  },
  {
    id: "jwt-in-source",
    severity: "medium",
    message: "Serialized JWT committed in source",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/
  },
  {
    id: "generic-secret-assignment",
    severity: "medium",
    message: "Secret-like assignment to a literal string",
    pattern: /\b(api[_-]?key|secret|password|passwd|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i
  },

  // --- Destructive commands ------------------------------------------------
  {
    id: "rm-rf-root",
    severity: "critical",
    message: "Recursive forced delete of a root/home/glob path",
    pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(--\s+)?(\/|~|\*)(\s|\/\*|$)/
  },
  {
    id: "fork-bomb",
    severity: "critical",
    message: "Shell fork bomb",
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:?/
  },
  {
    id: "disk-wipe",
    severity: "critical",
    message: "Filesystem/disk destruction command",
    pattern: /\bmkfs(\.\w+)?\s|dd\s+if=\/dev\/(zero|random)\s+of=\/dev\/|:\s*>\s*\/dev\/sd[a-z]/
  },
  {
    id: "windows-del-tree",
    severity: "high",
    message: "Windows recursive force delete",
    pattern: /\bdel\s+\/[fsq]/i
  },
  {
    id: "sql-drop",
    severity: "high",
    message: "Destructive SQL statement",
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i
  },
  {
    id: "truncate-table",
    severity: "medium",
    message: "Table truncation statement",
    pattern: /\bTRUNCATE\s+TABLE\b/i
  },
  {
    id: "force-push",
    severity: "medium",
    message: "Force push (history rewrite) — verify intent",
    pattern: /\bgit\s+push\s+(?!.*--force-with-lease).*--force\b|\bgit\s+push\s+-f\b/
  },
  {
    id: "chmod-777",
    severity: "medium",
    message: "World-writable permission change",
    pattern: /\bchmod\s+(-R\s+)?777\b/
  },
  {
    id: "host-shutdown",
    severity: "low",
    message: "Host power/reboot command in script",
    pattern: /\bshutdown\s+(-h|-r|\/[sr])\b/i
  }
];

const ENV_FILE_PATTERN = /(^|\/)\.env(\..+)?$/;
const MAX_EXCERPT = 120;

function redact(excerpt: string): string {
  const trimmed = excerpt.trim();

  return trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT)}…` : trimmed;
}

function maxSeverityOf(findings: readonly ShieldFinding[]): ShieldSeverity | undefined {
  let max: ShieldSeverity | undefined;

  for (const finding of findings) {
    if (max === undefined || SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[max]) {
      max = finding.severity;
    }
  }

  return max;
}

function verdictFor(findings: readonly ShieldFinding[]): ShieldReport["verdict"] {
  if (findings.length === 0) {
    return "pass";
  }

  const max = maxSeverityOf(findings);

  return max === undefined || SEVERITY_ORDER[max] <= SEVERITY_ORDER.medium ? "warn" : "fail";
}

/**
 * Runs every rule against one line of added content.
 * Returns one finding per matching rule (a line can match several).
 * Matched spans are masked in the excerpt so secrets never leave the
 * scanner even though findings may travel over the bus or into receipts.
 */
function scanLine(
  line: string,
  lineNumber: number | undefined,
  file: string | undefined,
  out: ShieldFinding[]
): void {
  for (const rule of RULES) {
    const match = rule.pattern.exec(line);

    if (match === null) {
      continue;
    }

    const masked =
      match[0].length > 8
        ? line.replace(match[0], `${match[0].slice(0, 4)}…`)
        : line;

    out.push({
      ruleId: rule.id,
      severity: rule.severity,
      message: rule.message,
      ...(file === undefined ? {} : { file }),
      ...(lineNumber === undefined ? {} : { line: lineNumber }),
      excerpt: redact(masked)
    });
  }
}

/**
 * Scans a unified diff patch. Only added lines count: context and removed
 * lines describe history, not what this candidate would introduce.
 * Line numbers come from `@@ -a,b +c,d @@` hunk headers.
 */
function scanPatch(patch: string, file: string | undefined, out: ShieldFinding[]): void {
  let newLine: number | undefined;

  for (const rawLine of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);

    if (hunk !== null) {
      newLine = Number.parseInt(hunk[1] as string, 10);

      continue;
    }

    if (rawLine.startsWith("diff ") || rawLine.startsWith("index ")) {
      continue;
    }

    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) {
      continue;
    }

    if (rawLine.startsWith("+")) {
      scanLine(rawLine.slice(1), newLine, file, out);

      if (newLine !== undefined) {
        newLine += 1;
      }

      continue;
    }

    if (rawLine.startsWith("-")) {
      continue;
    }

    // Context line advances the new-file cursor.
    if (newLine !== undefined) {
      newLine += 1;
    }
  }
}

/**
 * The AgentShield scanner. Feed it unified diffs (preferred) or raw file
 * contents; both paths produce the same {@link ShieldReport} shape.
 */
export class AgentShield {
  private readonly envFileDetection: boolean;

  constructor(options: { detectEnvFiles?: boolean } = {}) {
    this.envFileDetection = options.detectEnvFiles ?? true;
  }

  scan(input: string | readonly DiffFile[], fileLabel?: string): ShieldReport {
    const findings: ShieldFinding[] = [];
    let scannedFiles = 0;

    if (typeof input === "string") {
      scannedFiles = 1;
      scanPatch(input, fileLabel, findings);
    } else {
      for (const entry of input) {
        scannedFiles += 1;
        scanPatch(entry.patch, entry.path, findings);

        if (
          this.envFileDetection &&
          ENV_FILE_PATTERN.test(entry.path) &&
          /^\+/m.test(entry.patch)
        ) {
          findings.push({
            ruleId: "env-file-committed",
            severity: "high",
            message: "Environment file with potential secrets is being added",
            file: entry.path,
            excerpt: entry.path
          });
        }
      }
    }

    return Object.freeze({
      scannedFiles,
      findings: Object.freeze(findings),
      maxSeverity: maxSeverityOf(findings),
      verdict: verdictFor(findings)
    });
  }

  /** Convenience wrapper for whole-file content already read from disk. */
  scanText(content: string, file?: string): ShieldReport {
    // Whole-file content is "all added": every line is new material this
    // candidate would introduce, unlike a diff where context is history.
    const findings: ShieldFinding[] = [];

    content.split(/\r?\n/).forEach((line, index) => {
      scanLine(line, index + 1, file, findings);
    });

    return Object.freeze({
      scannedFiles: 1,
      findings: Object.freeze(findings),
      maxSeverity: maxSeverityOf(findings),
      verdict: verdictFor(findings)
    });
  }
}
