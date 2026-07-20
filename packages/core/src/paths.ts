import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function sojournHome(): string {
  return process.env.SOJOURN_HOME ?? path.join(os.homedir(), ".sojourn");
}

export function dbPath(): string {
  return path.join(sojournHome(), "sojourn.db");
}

export function snapshotsDir(projectId: string): string {
  return path.join(sojournHome(), "snapshots", projectId);
}

export function worktreesDir(): string {
  return path.join(sojournHome(), "worktrees");
}

/**
 * `$SOJOURN_HOME/daemon.log` — the single sink both the daemon's own logger
 * and the CLI's detached-spawn piping (child stdout/stderr) append to.
 *
 * Lives in core because both packages need it and neither should depend on
 * the other: the CLI must not pull in the daemon's module graph (express,
 * chokidar, ws) just to derive a path.
 *
 * Pass `home` to resolve against an explicit root — the CLI threads one
 * through its command deps. Omit it to resolve `sojournHome()` at call time,
 * which stays env-sensitive for tests.
 */
export function daemonLogPath(home?: string): string {
  return path.join(home ?? sojournHome(), "daemon.log");
}

export function projectIdFor(root: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(root))
    .digest("hex")
    .slice(0, 12);
}
