/**
 * Process-level crash guards for the daemon.
 *
 * Capture is passive: one bad transcript, one rejected promise, one throwing
 * batch must NEVER kill the daemon (design principle 2). So both
 * `unhandledRejection` and `uncaughtException` are logged — full stack,
 * never rethrown — and the process keeps running.
 *
 * The one escape hatch is the crash-storm breaker: if `uncaughtException`
 * fires more than `crashLimit` times inside `windowMs` (default: >20 in
 * 60s), something is systemically broken (a hot error loop), and limping on
 * would just spin the CPU and flood the log — log "crash storm" and exit 1
 * so the supervisor/user can restart into a clean state.
 *
 * Startup errors (initial DB-open / listen) are NOT handled here — main.ts
 * treats those as fatal explicitly (log + exit 1), because a daemon that
 * never came up has nothing to keep alive.
 */
import { logError as defaultLogError } from "./logger.js";

export interface CrashStormBreaker {
  /** Records one crash at `now` (ms). Returns true when the storm limit is exceeded. */
  record(now?: number): boolean;
}

export function createCrashStormBreaker(limit = 20, windowMs = 60_000): CrashStormBreaker {
  const times: number[] = [];
  return {
    record(now = Date.now()): boolean {
      times.push(now);
      while (times.length > 0 && now - times[0] > windowMs) times.shift();
      return times.length > limit;
    },
  };
}

export interface ProcessGuardOptions {
  /** Event source to attach to; defaults to the real `process`. Injectable for tests. */
  proc?: NodeJS.Process;
  logError?: (...args: unknown[]) => void;
  exit?: (code: number) => void;
  /** Storm breaker: exit 1 after MORE than this many uncaughtExceptions per window. */
  crashLimit?: number;
  windowMs?: number;
}

export function installProcessGuards(opts: ProcessGuardOptions = {}): void {
  const proc = opts.proc ?? process;
  const logError = opts.logError ?? defaultLogError;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const breaker = createCrashStormBreaker(opts.crashLimit ?? 20, opts.windowMs ?? 60_000);

  proc.on("unhandledRejection", (reason: unknown) => {
    try {
      logError(
        "[sojourn] unhandledRejection (daemon continues — capture is passive):",
        reason,
      );
    } catch {
      // the guard itself must never throw
    }
  });

  proc.on("uncaughtException", (err: unknown) => {
    try {
      logError("[sojourn] uncaughtException (daemon continues — capture is passive):", err);
    } catch {
      // the guard itself must never throw
    }
    if (breaker.record()) {
      try {
        logError(
          `[sojourn] crash storm — more than ${opts.crashLimit ?? 20} uncaught exceptions in ${
            (opts.windowMs ?? 60_000) / 1000
          }s — exiting`,
        );
      } catch {
        // still exit even if the logger is broken
      }
      exit(1);
    }
  });
}
