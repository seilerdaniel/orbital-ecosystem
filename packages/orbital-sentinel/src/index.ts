/**
 * @orbital/sentinel — QA auditor for the Orbital ecosystem.
 *
 * Library surface (this barrel): event contract validation, the AgentShield
 * diff scanner, and the RDD receipt generator. The long-running audit
 * service lives behind the `./service` subpath so library consumers do not
 * need the WebSocket transport.
 */

export {
  Sentinel,
  type SentinelReport,
  type SentinelViolation
} from "./sentinel.js";

export {
  AgentShield,
  type DiffFile,
  type ShieldFinding,
  type ShieldReport,
  type ShieldSeverity
} from "./scanners/agent-shield.js";

export {
  RECEIPT_FILE_NAME,
  RECEIPT_SCHEMA_VERSION,
  generateReceipt,
  isRddReceipt,
  readReceipt,
  writeReceipt,
  type GenerateReceiptOptions,
  type ReceiptCandidate,
  type ReceiptCheck,
  type ReceiptCheckStatus,
  type ReceiptEvidence,
  type ReceiptShieldSummary,
  type ReceiptVerdict,
  type RDDReceipt
} from "./receipt/generator.js";

export {
  PreFlightRunner,
  parseJestJson,
  parseSummaryText,
  type PreFlightOptions,
  type PreFlightStats,
  type RunnerKind,
  type TestCounts,
  type TestRunResult
} from "./runners/test-runner.js";
