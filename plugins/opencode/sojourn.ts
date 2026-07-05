/**
 * Sojourn OpenCode plugin.
 *
 * Written against the documented OpenCode plugin API
 * (https://opencode.ai/docs/plugins/) as of implementation time: a plugin
 * module exports an async function `({ client, project, ... }) => hooks`,
 * where `hooks` may include a general `"event"` hook of the form
 * `async ({ event }) => void` that receives every server bus event (the
 * same events streamed over `GET /event`). NOT integration-tested against a
 * live OpenCode install in this environment — there is no OpenCode install
 * available here to load this plugin into.
 *
 * Responsibility: forward this session's id to the local Sojourn daemon's
 * `POST /api/hooks/opencode` route (see docs/API.md) whenever OpenCode
 * reports session activity, so the daemon can re-poll/re-scan that session
 * immediately instead of waiting on its own polling interval. This plugin
 * does NOT implement the daemon route itself (owned by packages/daemon) and
 * does NOT parse messages — it is purely a low-latency "something happened"
 * signal; the daemon pulls the authoritative message history via the REST
 * client in this same package (see src/client.ts).
 *
 * This plugin must never break the user's OpenCode session: every failure
 * (daemon not running, network error, malformed event, timeout) is caught
 * and swallowed. Nothing here throws out of a hook callback.
 */

const DEFAULT_DAEMON_PORT = 4177;
const POST_TIMEOUT_MS = 500;

function resolveDaemonPort(): number {
  const envPort = process.env.SOJOURN_PORT;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DAEMON_PORT;
}

/**
 * Best-effort extraction of a session id from an OpenCode bus event. Event
 * shapes are not fully pinned down by the public docs beyond `{type,
 * properties}`, so this reads defensively across the property names the
 * documented event catalogue suggests (`sessionID` on session.* events,
 * nested under `properties.info.id` for some, `properties.sessionID` for
 * others). Returns undefined rather than throwing when nothing matches.
 */
function extractSessionId(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const properties = (event as Record<string, unknown>).properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const props = properties as Record<string, unknown>;

  if (typeof props.sessionID === "string" && props.sessionID.length > 0) {
    return props.sessionID;
  }
  const info = props.info;
  if (typeof info === "object" && info !== null) {
    const infoRec = info as Record<string, unknown>;
    if (typeof infoRec.sessionID === "string" && infoRec.sessionID.length > 0) {
      return infoRec.sessionID;
    }
    if (typeof infoRec.id === "string" && infoRec.id.length > 0) {
      return infoRec.id;
    }
  }
  return undefined;
}

async function postSessionIdToDaemon(sessionId: string): Promise<void> {
  const port = resolveDaemonPort();
  const url = `http://localhost:${port}/api/hooks/opencode`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Minimal structural type for the plugin context this module relies on —
// deliberately loose (not importing @opencode-ai/sdk, per the "no new
// deps" constraint) since only `event.type`/`event.properties` are used.
interface PluginEvent {
  event: unknown;
}

export const SojournPlugin = async (_ctx: unknown) => {
  return {
    event: async ({ event }: PluginEvent): Promise<void> => {
      try {
        const sessionId = extractSessionId(event);
        if (!sessionId) return;
        await postSessionIdToDaemon(sessionId);
      } catch {
        // Fail soft: never let a daemon-forwarding error surface to OpenCode.
      }
    },
  };
};

export default SojournPlugin;
