import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Env vars that pin a git invocation to a shadow repo rather than any
 * real .git a project might have.
 */
export interface ShadowGitEnv {
  GIT_DIR: string;
  GIT_WORK_TREE: string;
  GIT_INDEX_FILE: string;
  [key: string]: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Runs `git <args>` with the given env merged over process.env, returning
 * stdout. Never touches a real project's .git — callers must always pass
 * GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE pointed at the shadow repo.
 */
export async function runGit(
  args: string[],
  env: ShadowGitEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024 * 64,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(
      `git ${args.join(" ")} failed: ${e.stderr ?? e.message ?? "unknown error"}`,
      args,
      e.stderr ?? "",
    );
  }
}
