import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface SpawnResult {
  pid: number | undefined;
  unref(): void;
}

export interface SpawnFn {
  (command: string, args: string[], options: Record<string, unknown>): SpawnResult;
}

/**
 * Resolve the daemon's built entry point lazily (never import @sojourn/daemon
 * at module top level — it may not be built yet). Overridable via
 * SOJOURN_DAEMON_ENTRY for tests / dev.
 */
export function resolveDaemonEntry(): string {
  const override = process.env.SOJOURN_DAEMON_ENTRY;
  if (override) return override;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@sojourn/daemon/package.json");
  return join(dirname(pkgPath), "dist", "main.js");
}

export function pidfilePath(sojournHome: string): string {
  return join(sojournHome, "daemon.pid");
}

/** The daemon's log file: both the daemon's own logger and the CLI's spawn
 * piping (child stdout/stderr) append here. */
export function daemonLogPath(sojournHome: string): string {
  return join(sojournHome, "daemon.log");
}

/** Last `n` non-empty lines of $SOJOURN_HOME/daemon.log; [] when the file
 * is missing or unreadable (forensics helpers must never throw). */
export function tailLogLines(sojournHome: string, n: number): string[] {
  try {
    const raw = readFileSync(daemonLogPath(sojournHome), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

export function readPid(sojournHome: string): number | null {
  const file = pidfilePath(sojournHome);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function writePid(sojournHome: string, pid: number): void {
  mkdirSync(sojournHome, { recursive: true });
  writeFileSync(pidfilePath(sojournHome), String(pid), "utf8");
}

export function removePidfile(sojournHome: string): void {
  const file = pidfilePath(sojournHome);
  if (existsSync(file)) unlinkSync(file);
}

/** Returns true if a process with this pid appears to be alive. ESRCH-tolerant. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    // EPERM means it exists but we can't signal it -> still alive.
    if (e.code === "EPERM") return true;
    return false;
  }
}

/** ESRCH-tolerant kill of a pid. Returns true if a signal was actually sent. */
export function killPid(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    throw err;
  }
}

export interface PsCommandFn {
  (pid: number): Promise<string>;
}

/** Default ps command lookup: `ps -p <pid> -o command=` (works on darwin & linux). */
async function defaultPsCommand(pid: number): Promise<string> {
  const { stdout } = await execFile("ps", ["-p", String(pid), "-o", "command="]);
  return stdout;
}

export interface IsDaemonProcessDeps {
  /** injectable for tests; defaults to a real `ps -p <pid> -o command=` invocation */
  psCommand?: PsCommandFn;
}

/**
 * Verifies that the process currently holding `pid` is actually a sojourn
 * daemon, not some unrelated process the OS has recycled the pid onto.
 *
 * Looks up the process's command line via `ps` (cross-platform enough for
 * darwin/linux) and checks it mentions "sojourn", or is running the daemon's
 * built entry file ("main.js" under a path containing "daemon"). If the ps
 * lookup fails for any reason (process gone, ps unavailable, etc.) this is
 * treated as "not the daemon" — safer to treat an unverifiable pid as stale
 * than to signal an unrelated process.
 */
export async function isDaemonProcess(pid: number, deps: IsDaemonProcessDeps = {}): Promise<boolean> {
  const psCommand = deps.psCommand ?? defaultPsCommand;
  let command: string;
  try {
    command = await psCommand(pid);
  } catch {
    return false;
  }
  const normalized = command.toLowerCase().trim();
  if (normalized.length === 0) return false;
  if (normalized.includes("sojourn")) return true;
  if (normalized.includes("main.js") && normalized.includes("daemon")) return true;
  return false;
}

export interface FetchJsonFn {
  (url: string): Promise<{ status: number; body: unknown }>;
}

export interface PollHealthOptions {
  baseUrl: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchJson: FetchJsonFn;
}

/** Poll GET /api/health until it responds ok, or timeoutMs elapses. */
export async function pollHealth(opts: PollHealthOptions): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await opts.fetchJson(`${opts.baseUrl.replace(/\/$/, "")}/api/health`);
      if (res.status === 200 && (res.body as { ok?: boolean } | undefined)?.ok) {
        return true;
      }
    } catch {
      // daemon not up yet; keep polling
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
