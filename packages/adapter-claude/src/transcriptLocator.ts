import os from "node:os";
import path from "node:path";

/**
 * Root directory Claude Code stores per-project transcript JSONL files under.
 * Honors CLAUDE_CONFIG_DIR (Claude Code's own env override for its config
 * home) when set; otherwise defaults to `~/.claude`.
 */
export function claudeProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const base = configDir && configDir.length > 0 ? configDir : path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

/**
 * Glob pattern (for chokidar or similar) matching every session transcript
 * file across every project directory.
 */
export function watchGlob(): string {
  return path.join(claudeProjectsDir(), "**", "*.jsonl");
}
