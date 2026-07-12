#!/usr/bin/env node
/**
 * Sojourn Claude Code hook entrypoint.
 *
 * Claude Code invokes this as a `command` hook for SessionStart, PostToolUse,
 * and Stop (see plugins/claude/hooks/hooks.json). It receives the hook event
 * payload as JSON on stdin (`{session_id, transcript_path, cwd,
 * hook_event_name, ...}`) and forwards it, best-effort, to the local Sojourn
 * daemon so it can re-scan the affected transcript immediately instead of
 * waiting on the file watcher's poll interval.
 *
 * This script must NEVER break the user's Claude Code session: every error
 * (daemon not running, malformed stdin, network failure, timeout, etc.) is
 * swallowed, and the process always exits 0.
 */

const DEFAULT_PORT = 4177;
const POST_TIMEOUT_MS = 500;
const STDIN_TIMEOUT_MS = 2000;
// Budget invariant: STDIN_TIMEOUT_MS + POST_TIMEOUT_MS + FLAGS_TIMEOUT_MS
// (2000 + 500 + 500 = 3000) must stay strictly under HARD_EXIT_TIMEOUT_MS so
// the hard-exit timer never preempts a legitimately-running GET in the
// worst case (stdin never closes, POST eats its whole budget); the 500ms
// gap below is scheduling slack, not part of any single step's budget.
const HARD_EXIT_TIMEOUT_MS = 3500;
// Added-latency budget for the opt-in terminal flag delivery step (GET
// turn-flags), separate from and in addition to POST_TIMEOUT_MS above.
const FLAGS_TIMEOUT_MS = 500;

// Belt-and-suspenders hard kill: no matter what happens above (a stdin
// stream that never closes, an unexpected hang inside postToDaemon, etc.),
// this guarantees the process exits within ~3.5s (still far under Claude
// Code's ~5s hook tolerance). It is intentionally NOT unref()'d so it can
// force an exit even if something else is keeping the event loop alive; the
// normal-completion path clears it in main()'s `finally` so a healthy run
// doesn't have to wait out the full 3.5s.
const hardExitTimer = setTimeout(() => {
  process.exit(0);
}, HARD_EXIT_TIMEOUT_MS);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  const collect = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  })();

  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, STDIN_TIMEOUT_MS);
    t.unref();
  });

  // Race the stdin read against a hard deadline: if the caller never closes
  // stdin (no EOF), proceed with whatever partial data was read so far
  // instead of hanging forever.
  await Promise.race([collect, timeout]);

  return Buffer.concat(chunks).toString("utf8");
}

function tolerantParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function resolvePort(): number {
  const envPort = process.env.SOJOURN_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

async function postToDaemon(payload: unknown): Promise<void> {
  const port = resolvePort();
  const url = `http://localhost:${port}/api/hooks/claude`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True only for a well-formed Stop event payload carrying a non-empty
 * `session_id` — the two things needed to look up that session's
 * turn-flags. Anything else (missing/blank session id, non-Stop event,
 * malformed payload) means the opt-in flags step must not run.
 */
function stopEventSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.hook_event_name !== "Stop") return null;
  return typeof p.session_id === "string" && p.session_id.length > 0 ? p.session_id : null;
}

/**
 * Fetches this session's last-turn verified flag lines from the daemon's
 * `GET /api/sessions/:id/turn-flags` route (docs/API.md), budgeted
 * independently of the POST above via `FLAGS_TIMEOUT_MS`. Every failure
 * mode — daemon down/slow, non-200, malformed body, `lines` missing or not
 * an array — resolves to an empty array rather than throwing, so callers
 * never need a try/catch to stay silent.
 */
async function fetchTurnFlagLines(sessionId: string): Promise<string[]> {
  const port = resolvePort();
  const url = `http://localhost:${port}/api/sessions/${encodeURIComponent(sessionId)}/turn-flags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FLAGS_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") return [];
    const lines = (data as Record<string, unknown>).lines;
    if (!Array.isArray(lines)) return [];
    return lines.filter((line): line is string => typeof line === "string");
  } catch {
    return [];
  }
}

/**
 * Writes a single chunk to stdout and resolves only once it is safe to
 * write again — either the callback fired (the OS accepted the data, or
 * buffered it internally) or, when `write` reports backpressure (`false`),
 * once the stream emits `drain`. Node's `process.exit()` truncates any
 * data still sitting in the stdout pipe buffer that hasn't been flushed to
 * the OS; under backpressure (a slow-reading consumer on the other end of
 * the hook's stdout pipe, e.g. Claude Code itself), `write`'s callback can
 * fire before the OS has actually accepted the bytes, so without the
 * `drain` wait a large flag payload can be silently cut off mid-stream.
 * Waiting for `drain` too is the documented way to know a writable stream
 * has caught up.
 */
function writeAndWait(chunk: string): Promise<void> {
  return new Promise((resolve) => {
    const ok = process.stdout.write(chunk, () => {
      if (ok) resolve();
    });
    if (!ok) {
      process.stdout.once("drain", resolve);
    }
  });
}

/**
 * Prints each flag line to stdout, prefixed so it reads as coming from
 * Sojourn inside Claude Code's hook-stdout surface. Defensively drops any
 * line mentioning "advisory": the turn-flags route contract is
 * verified-only (docs/API.md), but stdout is the one surface a user reads
 * unprompted, so this is a second guard against advisory content ever
 * appearing to carry verified confidence (design principle #3).
 *
 * Awaits each write's completion (see writeAndWait) so that, combined with
 * main() awaiting this function before the process exits, none of the
 * output is lost to process.exit() truncating an unflushed pipe buffer
 * under backpressure.
 */
async function printFlagLines(lines: string[]): Promise<void> {
  for (const line of lines) {
    if (line.toLowerCase().includes("advisory")) continue;
    await writeAndWait(`Sojourn: ${line}\n`);
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload = tolerantParse(raw);

  try {
    await postToDaemon(payload);
  } catch {
    // Fire-and-forget: a POST failure (daemon down, timeout, network
    // error) must not stop the opt-in flags step below from getting its
    // own chance to run.
  }

  if (process.env.SOJOURN_HOOK_FLAGS === "1") {
    const sessionId = stopEventSessionId(payload);
    if (sessionId) {
      const lines = await fetchTurnFlagLines(sessionId);
      await printFlagLines(lines);
    }
  }
}

main()
  .catch(() => {
    // Swallow everything: a hook must never break the user's session.
  })
  .finally(() => {
    clearTimeout(hardExitTimer);
    process.exit(0);
  });
