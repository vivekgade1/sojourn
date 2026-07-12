import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileChange } from "../types.js";
import type { SnapshotterLike } from "../interfaces.js";
import { runGit, type ShadowGitEnv } from "./git.js";

const execFileAsync = promisify(execFile);

const SOJOURN_HEAD_REF = "refs/sojourn/head";
const SOJOURN_SAFETY_REF = "refs/sojourn/safety";

// git's canonical empty tree hash — the well-known SHA-1 of `git hash-object
// -t tree /dev/null`. Used as the "before" side when diffing a null base
// against a tree, since `--root` requires a commit (treeB here is always a
// bare tree hash, not a commit-ish).
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * git's stderr when `git show <tree>:<path>` fails because the path is
 * genuinely absent from that tree — the ONLY failure mode readFile() and
 * readFileRaw() below treat as "this file does not exist" (-> null). Git
 * uses two phrasings depending on whether a same-named path also happens to
 * exist in the process's cwd: the normal "does not exist in", and "exists
 * on disk, but not in" — both mean "absent from the given tree" here.
 *
 * Any OTHER failure — a stale/bad tree hash ("Not a valid object name"), the
 * process's stdio maxBuffer being exceeded on a large blob, a spawn error —
 * is NOT an absence signal and must propagate as a thrown error instead of
 * silently returning null. (This was a probe-proven destructive bug: the old
 * catch-all here returned null on ANY failure, including maxBuffer overruns
 * on large branch files; harvestEngine's classifier then read that null as
 * "the branch deleted the file" and deleted the mainline copy of a file that
 * in fact still existed on the branch — it just couldn't be read.)
 */
const GIT_PATH_ABSENT_RE =
  /fatal: [Pp]ath '.*' (?:does not exist in|exists on disk, but not in)/;

function gitStderrText(err: unknown): string {
  const raw = (err as { stderr?: unknown } | null | undefined)?.stderr;
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return "";
}

function isGitPathAbsent(err: unknown): boolean {
  return GIT_PATH_ABSENT_RE.test(gitStderrText(err));
}

const EXCLUDE_ENTRIES = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".cache/",
  "*.log",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  ".sojourn/",
  ".DS_Store",
  "*.p12",
  "*.keystore",
  "id_rsa",
  "id_rsa.*",
  "*.token",
  "credentials",
  "credentials.*",
  ".aws/",
  ".ssh/",
  "*.secret",
  "*.pfx",
];

export interface ShadowSnapshotterOptions {
  projectRoot: string;
  shadowDir: string;
}

/**
 * Snapshots a project's working directory into a "shadow" git repo whose
 * gitdir lives outside the project (shadowDir), so the project's own .git
 * (if any) is never touched. All git invocations are pinned to the shadow
 * repo via GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE.
 */
export class ShadowSnapshotter implements SnapshotterLike {
  private readonly projectRoot: string;
  private readonly shadowDir: string;

  constructor(opts: ShadowSnapshotterOptions) {
    this.projectRoot = opts.projectRoot;
    this.shadowDir = opts.shadowDir;
  }

  private get env(): ShadowGitEnv {
    return {
      GIT_DIR: this.shadowDir,
      GIT_WORK_TREE: this.projectRoot,
      GIT_INDEX_FILE: path.join(this.shadowDir, "sojourn-index"),
    };
  }

  async init(): Promise<void> {
    await fs.mkdir(this.shadowDir, { recursive: true });

    // GIT_DIR is already set to shadowDir via env, so `git init` (no path
    // argument) initializes the shadow dir itself rather than creating a
    // nested `<shadowDir>/shadowDir` directory.
    await runGit(["init"], this.env);
    await runGit(["config", "core.bare", "false"], this.env);
    await runGit(["config", "user.email", "sojourn@local"], this.env);
    await runGit(["config", "user.name", "sojourn"], this.env);

    await fs.mkdir(path.join(this.shadowDir, "info"), { recursive: true });
    await fs.writeFile(
      path.join(this.shadowDir, "info", "exclude"),
      EXCLUDE_ENTRIES.join("\n") + "\n",
      "utf8",
    );
  }

  async snapshot(): Promise<string> {
    await runGit(["add", "-A"], this.env);
    const tree = (await runGit(["write-tree"], this.env)).trim();

    const prevHead = await this.currentHeadCommit();
    const commitArgs = ["commit-tree", tree, "-m", "snap"];
    if (prevHead) {
      commitArgs.push("-p", prevHead);
    }
    const commit = (await runGit(commitArgs, this.env)).trim();
    await runGit(["update-ref", SOJOURN_HEAD_REF, commit], this.env);

    return tree;
  }

  /**
   * Concurrency-safe sibling of snapshot(): captures the working tree using
   * a PRIVATE temp index and records the commit on refs/sojourn/safety —
   * never the shared ingest index or refs/sojourn/head. Restore's safety
   * snapshot uses this so it can run while capture is mid-snapshot.
   * (Git object-database writes are concurrency-safe; the only shared
   * mutable state in snapshot() is the index file and the head ref, and
   * this method touches neither.)
   */
  async snapshotSafety(): Promise<string> {
    const tempIndexFile = path.join(
      this.shadowDir,
      `safety-index-${crypto.randomBytes(8).toString("hex")}`,
    );
    const safetyEnv = { ...this.env, GIT_INDEX_FILE: tempIndexFile };
    try {
      await runGit(["add", "-A"], safetyEnv);
      const tree = (await runGit(["write-tree"], safetyEnv)).trim();

      let prevSafety: string | null = null;
      try {
        prevSafety = (await runGit(["rev-parse", "--verify", SOJOURN_SAFETY_REF], safetyEnv)).trim();
      } catch {
        prevSafety = null;
      }
      const commitArgs = ["commit-tree", tree, "-m", "safety"];
      if (prevSafety) commitArgs.push("-p", prevSafety);
      const commit = (await runGit(commitArgs, safetyEnv)).trim();
      await runGit(["update-ref", SOJOURN_SAFETY_REF, commit], safetyEnv);

      return tree;
    } finally {
      await fs.rm(tempIndexFile, { force: true }).catch(() => {});
    }
  }

  async hasTree(tree: string): Promise<boolean> {
    try {
      const kind = (await runGit(["cat-file", "-t", tree], this.env)).trim();
      return kind === "tree";
    } catch {
      return false;
    }
  }

  async diff(treeA: string | null, treeB: string): Promise<FileChange[]> {
    if (treeA === null) {
      const files = await this.listFiles(treeB);
      return files.map((p) => ({ path: p, status: "A" as const }));
    }

    // -c core.quotepath=false: without it git octal-quotes non-ASCII paths
    // ("\303\274mlaut.txt" with surrounding quotes), which parseNameStatus
    // would pass through verbatim — downstream consumers (harvest) would then
    // silently drop those files because the quoted string matches nothing.
    const output = await runGit(
      ["-c", "core.quotepath=false", "diff-tree", "-r", "-M", "--name-status", treeA, treeB],
      this.env,
    );
    return this.parseNameStatus(output);
  }

  async diffFile(
    treeA: string | null,
    treeB: string,
    filePath: string,
  ): Promise<string> {
    const fromTree = treeA ?? EMPTY_TREE_HASH;

    try {
      const output = await runGit(
        ["diff-tree", "-r", "-p", fromTree, treeB, "--", filePath],
        this.env,
      );
      return output;
    } catch {
      return "";
    }
  }

  async listFiles(tree: string): Promise<string[]> {
    // core.quotepath=false for the same reason as diff(): non-ASCII paths
    // must come back verbatim, not octal-quoted.
    const output = await runGit(
      ["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", tree],
      this.env,
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async readFile(tree: string, filePath: string): Promise<string | null> {
    try {
      return await runGit(["show", `${tree}:${filePath}`], this.env);
    } catch (err) {
      // Absence (confirmed by git's own stderr) -> null. Anything else (a
      // stale tree, a spawn error, ...) is a real failure — propagate it
      // rather than let callers mistake "we couldn't read it" for "it's
      // gone". See GIT_PATH_ABSENT_RE above for why this distinction matters.
      if (isGitPathAbsent(err)) return null;
      throw err;
    }
  }

  /**
   * Byte-exact sibling of readFile(): returns the blob as a Buffer with NO
   * encoding round-trip, so binary content (NUL bytes, invalid UTF-8) comes
   * back exactly as snapshotted. Harvest uses this for all content moves —
   * readFile()'s utf8 decode corrupts binary files into U+FFFD sequences.
   */
  async readFileRaw(tree: string, filePath: string): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${tree}:${filePath}`],
        {
          env: { ...process.env, ...this.env },
          encoding: "buffer",
          maxBuffer: 1024 * 1024 * 64,
        },
      );
      return stdout;
    } catch (err) {
      // Same absence-vs-failure split as readFile() above — critically
      // including maxBuffer overruns (ERR_CHILD_PROCESS_STDIO_MAXBUFFER),
      // which have empty/no stderr and so never match GIT_PATH_ABSENT_RE and
      // correctly propagate here instead of being swallowed into null.
      if (isGitPathAbsent(err)) return null;
      throw err;
    }
  }

  async restoreToWorktree(tree: string, destDir: string): Promise<void> {
    await fs.mkdir(destDir, { recursive: true });

    const tempIndexFile = path.join(
      this.shadowDir,
      `restore-index-${crypto.randomBytes(8).toString("hex")}`,
    );
    const restoreEnv: ShadowGitEnv = {
      GIT_DIR: this.shadowDir,
      GIT_WORK_TREE: destDir,
      GIT_INDEX_FILE: tempIndexFile,
    };

    // git's checkout-index --prefix always expects a forward slash,
    // regardless of the host OS (even on Windows).
    const prefix = destDir.endsWith("/") ? destDir : `${destDir}/`;

    try {
      await runGit(["read-tree", tree], restoreEnv);
      await runGit(
        ["checkout-index", "-a", `--prefix=${prefix}`],
        restoreEnv,
      );
    } finally {
      await fs.rm(tempIndexFile, { force: true });
    }
  }

  private async currentHeadCommit(): Promise<string | null> {
    try {
      const out = await runGit(
        ["rev-parse", "--verify", SOJOURN_HEAD_REF],
        this.env,
      );
      return out.trim();
    } catch {
      return null;
    }
  }

  // KNOWN LIMITATION (pre-existing, not fixed here — see task-6-report.md):
  // this parser assumes one path per line, trimmed. git C-quotes paths
  // containing tabs, double quotes, or other control characters even with
  // core.quotepath=false (that setting only controls octal-escaping of
  // non-ASCII bytes); a C-quoted line's surrounding quotes and backslash
  // escapes pass through `line.trim()` and the `\t`-split verbatim instead
  // of being unquoted, so such a path never matches anything downstream
  // (e.g. harvest's classifier) and is silently dropped. A file whose name
  // starts or ends with whitespace is similarly mangled by `.trim()`. Fixing
  // this requires a real C-quote-aware parser and is out of scope here.
  private parseNameStatus(output: string): FileChange[] {
    const changes: FileChange[] = [];
    const lines = output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of lines) {
      const parts = line.split("\t");
      const rawStatus = parts[0];
      const statusChar = rawStatus[0] as FileChange["status"];

      if (statusChar === "R" && parts.length >= 3) {
        changes.push({ path: parts[2], status: "R", oldPath: parts[1] });
      } else if (parts.length >= 2) {
        changes.push({ path: parts[1], status: statusChar });
      }
    }

    return changes;
  }
}
