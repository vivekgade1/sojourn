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
const HARD_EXIT_TIMEOUT_MS = 3000;

// Belt-and-suspenders hard kill: no matter what happens above (a stdin
// stream that never closes, an unexpected hang inside postToDaemon, etc.),
// this guarantees the process exits within ~3s. It is intentionally NOT
// unref()'d so it can force an exit even if something else is keeping the
// event loop alive; the normal-completion path clears it in main()'s
// `finally` so a healthy run doesn't have to wait out the full 3s.
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

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload = tolerantParse(raw);
  await postToDaemon(payload);
}

main()
  .catch(() => {
    // Swallow everything: a hook must never break the user's session.
  })
  .finally(() => {
    clearTimeout(hardExitTimer);
    process.exit(0);
  });
