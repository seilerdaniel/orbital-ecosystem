/**
 * Forge content pipeline — automatic release notes and demo packages.
 *
 * Two inputs feed the generator:
 * - git history: conventional commits parsed from `git log`
 * - orbital-synapse memory: verified patterns captured from approved RDD
 *   receipts
 *
 * Output artifacts: a CHANGELOG-style markdown draft, a narration script,
 * and an OpenMontage project skeleton (JSON timeline) ready for a real
 * montage renderer to pick up.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import {
  HybridSearchEngine,
  VectorStore,
  type StoredMemory
} from "@orbital/synapse";

// ---------------------------------------------------------------------------
// Git history
// ---------------------------------------------------------------------------

export interface ConventionalCommit {
  readonly hash: string;
  readonly type: string;
  readonly scope?: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
  readonly breaking: boolean;
}

const CONVENTIONAL_PATTERN =
  /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;
/** Prefixes every record; bodies may span lines, so we split on it. */
const RECORD_MARKER = "\u0001orbital-commit\u0001";
const LOG_FORMAT = `${RECORD_MARKER}%H%x09%s%x09%an%x09%aI%x09%b`;

/** Reads conventional commits; empty array when git is unavailable. */
export function collectCommits(
  options: {
    readonly repoRoot?: string;
    readonly limit?: number;
    readonly sinceTag?: string;
  } = {}
): ConventionalCommit[] {
  const args = [
    "log",
    `--pretty=${LOG_FORMAT}`,
    "-n",
    String(options.limit ?? 50)
  ];

  if (options.sinceTag !== undefined) {
    args.push(`${options.sinceTag}..HEAD`);
  }

  const child = spawnSync("git", args, {
    cwd: options.repoRoot ?? process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });

  if (child.status !== 0 || typeof child.stdout !== "string") {
    return [];
  }

  const commits: ConventionalCommit[] = [];

  for (const rawChunk of child.stdout.split(RECORD_MARKER)) {
    const chunk = rawChunk.replace(/^\r?\n+/, "");

    if (chunk === "") {
      continue;
    }

    const eol = chunk.indexOf("\n");
    const headerLine = eol === -1 ? chunk : chunk.slice(0, eol);
    const bodyRest = eol === -1 ? "" : chunk.slice(eol + 1);

    const [hash = "", subjectRaw = "", author = "", date = "", bodyFirst = ""] =
      headerLine.split("\t");
    const match = CONVENTIONAL_PATTERN.exec(subjectRaw);

    if (match === null) {
      continue;
    }

    const body = `${bodyFirst}\n${bodyRest}`;
    const breaking =
      match[3] === "!" || /^BREAKING\s+CHANGE/m.test(body);

    commits.push({
      hash,
      type: (match[1] as string).toLowerCase(),
      ...(match[2] === undefined || match[2] === "" ? {} : { scope: match[2] }),
      subject: match[4] as string,
      author,
      date,
      breaking
    });
  }

  return commits;
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

const SECTION_BY_TYPE: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  test: "Tests"
};

function bulletFor(commit: ConventionalCommit): string {
  const scope = commit.scope === undefined ? "" : `**${commit.scope}**: `;
  const shortHash = commit.hash.slice(0, 7);

  return `- ${scope}${commit.subject} (${shortHash})`;
}

/**
 * Compiles markdown release notes grouped by conventional-commit type,
 * plus a "Verified Patterns" section sourced from synapse memory.
 */
export function compileReleaseNotes(spec: {
  readonly title: string;
  readonly tag?: string;
  readonly commits: readonly ConventionalCommit[];
  readonly patterns?: readonly StoredMemory[];
}): string {
  const lines: string[] = [`# ${spec.title}`, ""];

  if (spec.tag !== undefined) {
    lines.push(`Release: \`${spec.tag}\``, "");
  }

  const breaking = spec.commits.filter((commit) => commit.breaking);
  const grouped = new Map<string, ConventionalCommit[]>();

  for (const commit of spec.commits) {
    if (commit.breaking) {
      continue;
    }

    const bucket = grouped.get(commit.type) ?? [];

    bucket.push(commit);
    grouped.set(commit.type, bucket);
  }

  if (breaking.length > 0) {
    lines.push("## ⚠️ Breaking Changes", "");

    for (const commit of breaking) {
      lines.push(bulletFor(commit));
    }

    lines.push("");
  }

  for (const [type, section] of Object.entries(SECTION_BY_TYPE)) {
    const bucket = grouped.get(type);

    if (bucket === undefined || bucket.length === 0) {
      continue;
    }

    lines.push(`## ${section}`, "");

    for (const commit of bucket) {
      lines.push(bulletFor(commit));
    }

    lines.push("");
  }

  const leftovers = [...grouped.keys()].filter((type) => !(type in SECTION_BY_TYPE));

  if (leftovers.length > 0) {
    lines.push("## Other Changes", "");

    for (const type of leftovers.sort()) {
      for (const commit of grouped.get(type) ?? []) {
        lines.push(bulletFor(commit));
      }
    }

    lines.push("");
  }

  const patterns = spec.patterns ?? [];

  if (patterns.length > 0) {
    lines.push("## Verified Patterns", "");
    lines.push(
      "Practices proven by approved receipts and stored in synapse memory:",
      ""
    );

    for (const pattern of patterns) {
      lines.push(`- **${pattern.title}**`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// OpenMontage storyboard structure
// ---------------------------------------------------------------------------

export interface Scene {
  readonly id: string;
  readonly title: string;
  readonly narration: string;
  /** Seconds; montage renderers map this to clip length. */
  readonly durationSec: number;
  readonly visualPrompt: string;
}

export interface DemoStoryboard {
  readonly title: string;
  readonly audience?: string;
  readonly scenes: readonly Scene[];
  readonly totalDurationSec: number;
}

/**
 * Deterministic storyboard builder: intro, one scene per highlight,
 * outro. Same input always yields the same demo skeleton.
 */
export function buildDemoStoryboard(spec: {
  readonly title: string;
  readonly highlights: readonly string[];
  readonly audience?: string;
}): DemoStoryboard {
  const scenes: Scene[] = [];
  let clock = 0;

  const push = (
    id: string,
    title: string,
    narration: string,
    durationSec: number,
    visualPrompt: string
  ): void => {
    scenes.push({ id, title, narration, durationSec, visualPrompt });
    clock += durationSec;
  };

  push(
    "intro",
    spec.title,
    `${spec.title}: what changed and why it matters.`,
    6,
    `Animated logo reveal, title "${spec.title}" over gradient backdrop`
  );

  spec.highlights.forEach((highlight, index) => {
    push(
      `highlight-${index + 1}`,
      highlight.slice(0, 60),
      `${highlight.replace(/^[-*]\s*/, "")}.`,
      10,
      `Screen capture or diagram illustrating "${highlight.slice(0, 40)}"`
    );
  });

  push(
    "outro",
    "Wrap up",
    "Install it, try it, and tell us what you think.",
    4,
    "Call-to-action card with repository link"
  );

  return {
    title: spec.title,
    ...(spec.audience === undefined ? {} : { audience: spec.audience }),
    scenes,
    totalDurationSec: clock
  };
}

/** Human-readable narration script derived from the storyboard. */
export function renderStoryboardMarkdown(board: DemoStoryboard): string {
  const lines: string[] = [
    `# ${board.title} — demo script`,
    "",
    board.audience === undefined ? "" : `_Audience: ${board.audience}_`,
    `Total runtime: ${board.totalDurationSec}s`,
    ""
  ];

  for (const scene of board.scenes) {
    lines.push(`## [${scene.id}] ${scene.title} (${scene.durationSec}s)`, "");
    lines.push(`> ${scene.narration}`, "");
    lines.push(`Visual: ${scene.visualPrompt}`, "");
  }

  return lines
    .map((line) => line ?? "")
    .join("\n");
}

/**
 * OpenMontage project skeleton. The real renderer consumes this JSON;
 * until one is wired up, the file itself is the integration contract.
 */
export interface OpenMontageProject {
  readonly format: "openmontage";
  readonly version: "0.1";
  readonly generator: "orbital-forge";
  readonly title: string;
  readonly fps: 30;
  readonly durationSec: number;
  readonly tracks: {
    readonly narration: readonly {
      readonly startSec: number;
      readonly durationSec: number;
      readonly text: string;
    }[];
    readonly visuals: readonly {
      readonly startSec: number;
      readonly durationSec: number;
      readonly prompt: string;
    }[];
  };
}

export function toOpenMontageProject(board: DemoStoryboard): OpenMontageProject {
  let cursor = 0;

  const narration = board.scenes.map((scene) => {
    const clip = {
      startSec: cursor,
      durationSec: scene.durationSec,
      text: scene.narration
    };

    cursor += scene.durationSec;

    return clip;
  });

  cursor = 0;
  const visuals = board.scenes.map((scene) => {
    const clip = {
      startSec: cursor,
      durationSec: scene.durationSec,
      prompt: scene.visualPrompt
    };

    cursor += scene.durationSec;

    return clip;
  });

  return {
    format: "openmontage",
    version: "0.1",
    generator: "orbital-forge",
    title: board.title,
    fps: 30,
    durationSec: board.totalDurationSec,
    tracks: { narration, visuals }
  };
}

// ---------------------------------------------------------------------------
// Renderer facade
// ---------------------------------------------------------------------------

export interface RenderResult {
  readonly notesMarkdown: string;
  readonly storyboard: DemoStoryboard;
  readonly files: readonly GeneratedFileAbs[];
}

export interface GeneratedFileAbs {
  readonly path: string;
  readonly bytes: number;
}

export interface RenderOptions {
  readonly title: string;
  readonly tag?: string;
  readonly repoRoot?: string;
  readonly outputDir: string;
  readonly commitLimit?: number;
  readonly sinceTag?: string;
  readonly demoQuery?: string;
  /** Verified-pattern source; when omitted no pattern section is added. */
  readonly store?: VectorStore;
}

async function writeArtifact(
  dir: string,
  fileName: string,
  contents: string
): Promise<GeneratedFileAbs> {
  await mkdir(dir, { recursive: true });
  const target = resolve(join(dir, fileName));

  await writeFile(target, contents, "utf8");

  return { path: target, bytes: Buffer.byteLength(contents, "utf8") };
}

/**
 * Full render: release notes from git + synapse, demo storyboard, and
 * OpenMontage project written to disk as three artifacts.
 */
export async function renderContentPackage(
  options: RenderOptions
): Promise<RenderResult> {
  const commits = collectCommits({
    ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
    ...(options.sinceTag === undefined ? {} : { sinceTag: options.sinceTag }),
    ...(options.commitLimit === undefined ? {} : { commitLimit: options.commitLimit })
  });

  let patterns: StoredMemory[] = [];

  if (options.store !== undefined) {
    patterns =
      options.demoQuery === undefined
        ? options.store.list({ kind: "pattern", limit: 5 })
        : new HybridSearchEngine(options.store)
            .search(options.demoQuery, { kind: "pattern", limit: 5 })
            .map((hit) => hit.memory);
  }

  const notesMarkdown = compileReleaseNotes({
    title: options.title,
    ...(options.tag === undefined ? {} : { tag: options.tag }),
    commits,
    patterns
  });

  const highlights =
    commits.filter((c) => c.type === "feat").map((c) => c.subject).slice(0, 4);

  const storyboard = buildDemoStoryboard({
    title: options.title,
    highlights:
      highlights.length > 0
        ? highlights
        : ["Automated release content generated by orbital-forge"],
    audience: "developers evaluating the Orbital ecosystem"
  });

  const files = [
    await writeArtifact(options.outputDir, "RELEASE_NOTES.md", notesMarkdown),
    await writeArtifact(
      options.outputDir,
      "DEMO_SCRIPT.md",
      renderStoryboardMarkdown(storyboard)
    ),
    await writeArtifact(
      options.outputDir,
      "openmontage.project.json",
      `${JSON.stringify(toOpenMontageProject(storyboard), null, 2)}\n`
    )
  ];

  return { notesMarkdown, storyboard, files };
}
