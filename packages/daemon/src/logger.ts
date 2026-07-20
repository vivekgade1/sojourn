/**
 * Tiny file logger for the daemon — no deps, fail-soft by construction.
 *
 * Appends timestamped `<iso> [level] message` lines to
 * `$SOJOURN_HOME/daemon.log`, rotating to `daemon.log.1` (one generation
 * kept) once the file exceeds {@link MAX_LOG_BYTES}. Rotation is
 * copy-then-truncate, NOT rename: the detached daemon's stdout/stderr is an
 * inherited fd on this same inode (see {@link appendToFile}).
 *
 * Two-mode design:
 *  - UNINITIALIZED (library/test use — anything that imports daemon modules
 *    without running the daemon binary): `logInfo`/`logError` only mirror to
 *    console.log/console.error, exactly like the plain console calls they
 *    replaced. No file is ever touched, so tests can never write to the real
 *    `~/.sojourn`.
 *  - INITIALIZED (the daemon process — `main.ts` calls `initDaemonLogger()`
 *    first thing): every line is appended to the log file, and mirrored to
 *    the console UNLESS the process was spawned detached by the CLI
 *    (`SOJOURN_DAEMON_DETACHED=1`), whose stdout/stderr are already piped
 *    into the same daemon.log — mirroring there would double every line.
 *
 * Logging must NEVER throw: an unwritable log file degrades to console-only
 * (or silence), never to a crashed capture pipeline.
 */
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { daemonLogPath } from "@sojourn/core";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

interface LoggerState {
  /** null = uninitialized: console mirroring only, no file writes. */
  filePath: string | null;
  mirror: boolean;
}

const state: LoggerState = { filePath: null, mirror: true };

/** `$SOJOURN_HOME/daemon.log`, resolved at call time (env-sensitive for tests).
 * Defined in @sojourn/core so the CLI can share it without depending on the
 * daemon; re-exported here because this module is its natural home for
 * daemon-side callers. */
export { daemonLogPath };

/**
 * Enables the file sink. Called exactly once, first thing, by the daemon
 * entry point. Returns the resolved log path. Never throws.
 */
export function initDaemonLogger(opts: { filePath?: string; mirror?: boolean } = {}): string {
  const filePath = opts.filePath ?? daemonLogPath();
  state.filePath = filePath;
  state.mirror = opts.mirror ?? process.env.SOJOURN_DAEMON_DETACHED !== "1";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // fail-soft: appendToFile below will simply no-op if the dir is missing
  }
  return filePath;
}

/** Test hook: back to the uninitialized (console-mirroring-only) state. */
export function resetDaemonLoggerForTests(): void {
  state.filePath = null;
  state.mirror = true;
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? String(arg);
  try {
    return inspect(arg, { depth: 4, breakLength: 120 });
  } catch {
    return String(arg);
  }
}

function formatLine(level: "info" | "error", args: unknown[]): string {
  return `${new Date().toISOString()} [${level}] ${args.map(formatArg).join(" ")}`;
}

function appendToFile(line: string): void {
  const filePath = state.filePath;
  if (filePath === null) return;
  try {
    try {
      const st = fs.statSync(filePath);
      if (st.size >= MAX_LOG_BYTES) {
        // Size-cap rotation: contents are COPIED to the (single) previous
        // generation, replacing any older one, then the live file is
        // truncated in place — one generation kept, same as a rename would.
        //
        // Copy+truncate rather than rename, because we do NOT own the only
        // handle on this file. When the CLI starts the daemon detached it
        // opens daemon.log with O_APPEND and hands that fd to the child as
        // stdout AND stderr, so raw process output (V8 OOM banners, native
        // aborts, anything printed before/around the logger) is written
        // through an fd bound to the INODE, not the path. `rename` would
        // move that inode to daemon.log.1 — splitting structured lines and
        // raw crash output across two files — and the NEXT rotation would
        // overwrite daemon.log.1, unlinking the inode the child's fd still
        // points at, so the crash banner this log exists to capture would
        // be written to a deleted file and lost. Truncating keeps the inode
        // alive and shared; O_APPEND recomputes the offset on every write,
        // so the child resumes at the new end with no sparse gap.
        fs.copyFileSync(filePath, `${filePath}.1`);
        fs.truncateSync(filePath, 0);
      }
    } catch {
      // missing file (first write) or unstat-able: just try the append
    }
    fs.appendFileSync(filePath, line + "\n", "utf8");
  } catch {
    // Logging must never throw or crash the daemon.
  }
}

export function logInfo(...args: unknown[]): void {
  const line = formatLine("info", args);
  appendToFile(line);
  if (state.mirror) {
    try {
      console.log(line);
    } catch {
      /* EPIPE etc. — never throw from logging */
    }
  }
}

export function logError(...args: unknown[]): void {
  const line = formatLine("error", args);
  appendToFile(line);
  if (state.mirror) {
    try {
      console.error(line);
    } catch {
      /* EPIPE etc. — never throw from logging */
    }
  }
}
