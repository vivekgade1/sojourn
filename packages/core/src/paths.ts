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

export function projectIdFor(root: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(root))
    .digest("hex")
    .slice(0, 12);
}
