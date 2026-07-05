import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { FileChange } from "../types.js";
import type { SnapshotterLike } from "../interfaces.js";
import { runGit, type ShadowGitEnv } from "./git.js";

const SOJOURN_HEAD_REF = "refs/sojourn/head";

// git's canonical empty tree hash — the well-known SHA-1 of `git hash-object
// -t tree /dev/null`. Used as the "before" side when diffing a null base
// against a tree, since `--root` requires a commit (treeB here is always a
// bare tree hash, not a commit-ish).
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

    const output = await runGit(
      ["diff-tree", "-r", "-M", "--name-status", treeA, treeB],
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
    const output = await runGit(
      ["ls-tree", "-r", "--name-only", tree],
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
    } catch {
      return null;
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
