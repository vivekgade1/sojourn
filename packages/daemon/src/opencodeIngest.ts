import path from "node:path";
import {
  OpenCodeClient,
  parseOpenCodeMessages,
  subscribeToEvents,
  type Subscription,
} from "@sojourn/adapter-opencode";
import type { IngestDeps } from "./ingest.js";
import { ingestBatch } from "./ingest.js";
import { runSerialized } from "./serialize.js";

/**
 * OpenCode capture wiring for the daemon.
 *
 * Written against the documented OpenCode server HTTP API
 * (https://opencode.ai/docs/server/) via `@sojourn/adapter-opencode`'s
 * client/parser. NOT integration-tested against a live OpenCode install in
 * this environment — there is no OpenCode server available here; the flow
 * below is exercised only against a stubbed `node:http` OpenCode server in
 * the daemon tests.
 *
 * Flow: `rescanOpenCodeSession(sessionId)` pulls the session (for its
 * project directory) and its full message list from the local OpenCode
 * server, parses them into an `IngestBatch`, and runs it through the SAME
 * per-project serializer the Claude watcher/hook path uses — two capture
 * sources for the same project must never race on that project's single
 * ShadowSnapshotter.
 *
 * Everything fails soft: an unreachable OpenCode server (the common case —
 * most environments run no OpenCode server at all) is logged ONCE and never
 * throws; capture must never surface an error to the hook caller.
 */

export interface OpenCodeIngestOptions {
  /** Base URL of the OpenCode server. Defaults to OPENCODE_URL env, then http://localhost:4096. */
  baseUrl?: string;
  /** Injectable fetch, primarily for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// Log the "OpenCode server unreachable" condition once per daemon process,
// not once per hook ping — a busy session would otherwise spam stderr.
let warnedUnreachable = false;

function logUnreachableOnce(detail: string): void {
  if (warnedUnreachable) return;
  warnedUnreachable = true;
  console.error(
    `[sojourn] opencode: server unreachable (${detail}); OpenCode capture is disabled until it responds (this is logged once)`,
  );
}

/** Test-only: reset the log-once latch between test cases. */
export function __resetOpenCodeWarnings(): void {
  warnedUnreachable = false;
}

/**
 * Pulls one OpenCode session's messages and ingests them. Never throws.
 * The project root comes from the parsed batch (which gets it from the
 * session's `directory`); a session without a usable directory is skipped.
 */
export async function rescanOpenCodeSession(
  deps: IngestDeps,
  sessionId: string,
  options: OpenCodeIngestOptions = {},
): Promise<void> {
  try {
    const client = new OpenCodeClient({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });

    const session = await client.getSession(sessionId);
    if (!session.ok) {
      if (session.status === null) logUnreachableOnce(session.error);
      else console.error(`[sojourn] opencode: getSession(${sessionId}) failed: HTTP ${session.status}`);
      return;
    }
    warnedUnreachable = false; // reachable again: re-arm the log-once latch

    const directory =
      session.data && typeof session.data.directory === "string" ? session.data.directory : "";
    if (!directory) {
      console.error(
        `[sojourn] opencode: session ${sessionId} has no directory; skipping (cannot resolve project root)`,
      );
      return;
    }

    const messages = await client.getMessages(sessionId);
    if (!messages.ok) {
      if (messages.status === null) logUnreachableOnce(messages.error);
      else console.error(`[sojourn] opencode: getMessages(${sessionId}) failed: HTTP ${messages.status}`);
      return;
    }

    const batch = parseOpenCodeMessages(messages.data, sessionId, {
      root: directory,
      name: path.basename(directory) || directory,
    });
    if (batch === null) return;
    if (typeof session.data.title === "string" && session.data.title.length > 0) {
      batch.session.title = session.data.title;
    }

    // Same per-project serializer key as the Claude watcher/hook path.
    const key = path.resolve(batch.project.root);
    await runSerialized(key, () => ingestBatch(deps, batch));
  } catch (err) {
    // Absolute backstop: capture never throws out of a hook/rescan.
    console.error(`[sojourn] opencode: rescan of session ${sessionId} failed:`, err);
  }
}

/**
 * Optionally subscribes to the OpenCode `/event` SSE stream and re-scans a
 * session whenever the bus reports activity for it. OFF by default — the
 * daemon only starts this when `SOJOURN_OPENCODE=1` is set (see main.ts),
 * because most environments run no OpenCode server and the subscriber would
 * just reconnect-loop forever. All errors are swallowed (the SSE layer
 * itself reconnects with capped backoff and never throws).
 */
export function startOpenCodeSubscriber(
  deps: IngestDeps,
  options: OpenCodeIngestOptions = {},
): Subscription {
  return subscribeToEvents({
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    onEvent: (event) => {
      const sessionId = extractSessionId(event);
      if (!sessionId) return;
      void rescanOpenCodeSession(deps, sessionId, options);
    },
    onError: (err) => {
      logUnreachableOnce(err instanceof Error ? err.message : String(err));
    },
  });
}

/**
 * Best-effort session-id extraction from an OpenCode bus event (same
 * defensive reading as plugins/opencode/sojourn.ts): `properties.sessionID`
 * first, then `properties.info.sessionID` / `properties.info.id`.
 */
function extractSessionId(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const properties = (event as Record<string, unknown>).properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const props = properties as Record<string, unknown>;
  if (typeof props.sessionID === "string" && props.sessionID.length > 0) return props.sessionID;
  const info = props.info;
  if (typeof info === "object" && info !== null) {
    const infoRec = info as Record<string, unknown>;
    if (typeof infoRec.sessionID === "string" && infoRec.sessionID.length > 0) {
      return infoRec.sessionID;
    }
    if (typeof infoRec.id === "string" && infoRec.id.length > 0) return infoRec.id;
  }
  return undefined;
}
