import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceEntry {
  readonly name: string;
  readonly type: "file" | "directory";
  readonly size: number;
}

export interface FileReadResult {
  readonly kind: "file";
  readonly path: string;
  readonly size: number;
  readonly contents: string;
}

export interface DirectoryReadResult {
  readonly kind: "directory";
  readonly path: string;
  readonly entries: readonly WorkspaceEntry[];
}

export type PathResolution =
  | { readonly ok: true; readonly absolutePath: string; readonly relativePath: string }
  | { readonly ok: false; readonly reason: string };

export interface SafeWorkspaceOptions {
  /** Absolute root directory exposed by the bridge. Defaults to process.cwd(). */
  readonly root?: string;
  /** Directory names that must never be touched anywhere under the root. */
  readonly blockedNames?: readonly string[];
}

export const DEFAULT_BLOCKED_NAMES = [".git", "node_modules"] as const;

/**
 * Filesystem facade for the Inverse MCP Bridge.
 *
 * Every operation is constrained to a single workspace root and refuses
 * paths that escape it or traverse into protected directories (.git,
 * node_modules). This is what makes the local CRUD endpoints safe to
 * expose over HTTP on a developer machine.
 */
export class SafeWorkspace {
  readonly root: string;

  private readonly blockedNames: ReadonlySet<string>;

  constructor(options: SafeWorkspaceOptions = {}) {
    this.root = path.resolve(options.root ?? process.cwd());
    this.blockedNames = new Set(
      (options.blockedNames ?? DEFAULT_BLOCKED_NAMES).map((name) => name.toLowerCase())
    );
  }

  /**
   * Validates a client-supplied path against traversal and blocklist rules.
   * Paths must be relative to the workspace root; absolute paths are rejected
   * so clients cannot anchor outside the project.
   */
  resolve(relativePath: string): PathResolution {
    if (typeof relativePath !== "string") {
      return { ok: false, reason: "Path must be a string" };
    }

    const trimmed = relativePath.trim();

    if (trimmed.includes("\0")) {
      return { ok: false, reason: "Path contains null bytes" };
    }

    if (path.isAbsolute(trimmed)) {
      return { ok: false, reason: `Path must be relative to the workspace root (${this.root})` };
    }

    const normalized = path.normalize(trimmed);
    const absolutePath = path.resolve(this.root, normalized);
    const fromRoot = path.relative(this.root, absolutePath);

    if (fromRoot === "" || (!fromRoot.startsWith("..") && !path.isAbsolute(fromRoot))) {
      const segments = normalized.split(/[\\/]+/).filter((segment) => segment.length > 0);

      for (const segment of segments) {
        if (this.blockedNames.has(segment.toLowerCase())) {
          return {
            ok: false,
            reason: `Access to "${segment}" is not allowed through the bridge`
          };
        }
      }

      return {
        ok: true,
        absolutePath,
        // Client-facing paths are always POSIX-style regardless of host OS,
        // so dock/mobile consumers see identical shapes on Windows and Unix.
        relativePath: normalized.split(path.sep).join("/")
      };
    }

    return { ok: false, reason: "Path escapes the workspace root" };
  }

  async read(relativePath: string): Promise<FileReadResult | DirectoryReadResult> {
    const resolved = this.resolve(relativePath);

    if (!resolved.ok) {
      throw new WorkspaceError(resolved.reason, 400);
    }

    let info = await stat(resolved.absolutePath).catch(() => undefined);

    if (info === undefined && resolved.relativePath === "") {
      info = await stat(this.root);
    }

    if (info === undefined) {
      throw new WorkspaceError(`Not found: ${resolved.relativePath || "/"}`, 404);
    }

    if (info.isDirectory()) {
      const dirents = await readdir(resolved.absolutePath, { withFileTypes: true });
      const entries: WorkspaceEntry[] = [];

      for (const dirent of dirents) {
        const entryStat = await stat(path.join(resolved.absolutePath, dirent.name)).catch(
          () => undefined
        );

        entries.push({
          name: dirent.name,
          type: dirent.isDirectory() ? "directory" : "file",
          size: entryStat?.size ?? 0
        });
      }

      return {
        kind: "directory",
        path: resolved.relativePath || "/",
        entries: entries.sort((a, b) => a.name.localeCompare(b.name))
      };
    }

    return {
      kind: "file",
      path: resolved.relativePath,
      size: info.size,
      contents: await readFile(resolved.absolutePath, "utf8")
    };
  }

  /** Creates a file. Fails when the file already exists (POST semantics). */
  async createFile(relativePath: string, contents: string): Promise<string> {
    const resolved = this.resolveFile(relativePath);
    await this.ensureParentDir(resolved.absolutePath);

    try {
      await writeFile(resolved.absolutePath, contents, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new WorkspaceError(`Already exists: ${resolved.relativePath}`, 409);
      }

      throw error;
    }

    return resolved.relativePath;
  }

  /** Creates or fully replaces a file (PUT semantics). */
  async writeFile(relativePath: string, contents: string): Promise<string> {
    const resolved = this.resolveFile(relativePath);
    await this.ensureParentDir(resolved.absolutePath);
    await writeFile(resolved.absolutePath, contents, "utf8");

    return resolved.relativePath;
  }

  async delete(relativePath: string, recursive: boolean): Promise<string> {
    const resolved = this.resolve(relativePath);

    if (!resolved.ok) {
      throw new WorkspaceError(resolved.reason, 400);
    }

    if (resolved.relativePath === "") {
      throw new WorkspaceError("Refusing to delete the workspace root", 400);
    }

    const info = await stat(resolved.absolutePath).catch(() => undefined);

    if (info === undefined) {
      throw new WorkspaceError(`Not found: ${resolved.relativePath}`, 404);
    }

    if (info.isDirectory() && !recursive) {
      throw new WorkspaceError(
        `"${resolved.relativePath}" is a directory: pass recursive=true to delete it`,
        400
      );
    }

    await rm(resolved.absolutePath, { recursive: info.isDirectory(), force: false });

    return resolved.relativePath;
  }

  private resolveFile(relativePath: string): {
    absolutePath: string;
    relativePath: string;
  } {
    const resolved = this.resolve(relativePath);

    if (!resolved.ok) {
      throw new WorkspaceError(resolved.reason, 400);
    }

    if (resolved.relativePath === "") {
      throw new WorkspaceError("Path must point to a file, not the workspace root", 400);
    }

    return resolved;
  }

  private async ensureParentDir(absolutePath: string): Promise<void> {
    const parent = path.dirname(absolutePath);

    if (path.relative(this.root, parent).startsWith("..")) {
      throw new WorkspaceError("Parent directory escapes the workspace root", 400);
    }

    await mkdir(parent, { recursive: true });
  }
}

export class WorkspaceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "WorkspaceError";
    this.statusCode = statusCode;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value;
}
