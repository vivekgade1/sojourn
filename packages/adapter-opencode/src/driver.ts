/**
 * Written against the documented OpenCode CLI/server API
 * (https://opencode.ai/docs/server/, https://opencode.ai/docs/cli/) as of
 * implementation time. NOT integration-tested against a live OpenCode
 * install in this environment. Fails soft: `revertTo` never throws — it
 * returns the client's ClientResult so callers can inspect ok/error without
 * a try/catch, matching OpenCodeClient's own fail-soft contract.
 */
import type { OpenCodeClient, ClientResult } from "./client.js";

/**
 * Builds the shell command used to resume an OpenCode session in a fresh
 * process (conversation-restore driver — see SOJOURN_BUILD_PLAN_V1.md's
 * "Live-agent caveat": restores launch a freshly resumed session rather than
 * mutating a running process).
 */
export function buildResumeCommand(sessionId: string): string {
  return `opencode --session ${sessionId}`;
}

/**
 * Reverts a session's conversation to a given message via the OpenCode
 * server's `POST /session/:id/revert` route. Thin wrapper over
 * OpenCodeClient.revert kept as its own driver entrypoint so the
 * restore-engine (packages/core) can depend on a stable, adapter-scoped
 * function name rather than reaching into the client class directly.
 */
export async function revertTo(
  client: OpenCodeClient,
  sessionId: string,
  messageId: string,
): Promise<ClientResult<unknown>> {
  return client.revert(sessionId, messageId);
}
