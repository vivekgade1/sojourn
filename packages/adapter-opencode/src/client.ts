/**
 * Written against the documented OpenCode server HTTP API
 * (https://opencode.ai/docs/server/) as of implementation time. NOT
 * integration-tested against a live OpenCode install in this environment —
 * there is no OpenCode server available here. Route shapes verified from
 * the docs:
 *   GET    /session                       -> Session[]
 *   GET    /session/:id                    -> Session
 *   GET    /session/:id/message            -> { info, parts }[]
 *   POST   /session/:id/revert             body { messageID, partID? }
 *   POST   /session/:id/fork               body { messageID? }
 * This client fails soft: every method catches network/parse errors and
 * returns a typed error result rather than throwing, so a caller looping
 * over sessions or polling never crashes on a transient failure or an
 * unreachable/not-yet-started OpenCode server.
 */

export interface OpenCodeSession {
  id: string;
  title?: string;
  /** Absolute path of the project directory the session runs in (per the
   * documented Session shape); consumers must treat it as optional. */
  directory?: string;
  [key: string]: unknown;
}

export interface OpenCodeMessage {
  info: Record<string, unknown>;
  parts: unknown[];
}

export type ClientResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; error: string };

export interface OpenCodeClientOptions {
  /** Base URL of the OpenCode server. Defaults to `OPENCODE_URL` env var, then http://localhost:4096. */
  baseUrl?: string;
  /** Injectable fetch, primarily for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function resolveOpenCodeBaseUrl(explicit?: string): string {
  if (explicit && explicit.length > 0) return stripTrailingSlash(explicit);
  const fromEnv = process.env.OPENCODE_URL;
  if (fromEnv && fromEnv.length > 0) return stripTrailingSlash(fromEnv);
  return "http://localhost:4096";
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenCodeClientOptions = {}) {
    this.baseUrl = resolveOpenCodeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listSessions(): Promise<ClientResult<OpenCodeSession[]>> {
    return this.request<OpenCodeSession[]>("GET", "/session");
  }

  async getSession(sessionId: string): Promise<ClientResult<OpenCodeSession>> {
    return this.request<OpenCodeSession>("GET", `/session/${encodeURIComponent(sessionId)}`);
  }

  async getMessages(sessionId: string): Promise<ClientResult<OpenCodeMessage[]>> {
    return this.request<OpenCodeMessage[]>(
      "GET",
      `/session/${encodeURIComponent(sessionId)}/message`,
    );
  }

  async revert(
    sessionId: string,
    messageId: string,
    partId?: string,
  ): Promise<ClientResult<unknown>> {
    const body: Record<string, string> = { messageID: messageId };
    if (partId) body.partID = partId;
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/revert`, body);
  }

  async fork(sessionId: string, messageId?: string): Promise<ClientResult<unknown>> {
    const body: Record<string, string> | undefined = messageId
      ? { messageID: messageId }
      : undefined;
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/fork`, body);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ClientResult<T>> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      let data: unknown = undefined;
      try {
        const text = await res.text();
        data = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        // Non-JSON or empty body: leave data undefined; still report status.
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: `HTTP ${res.status}` };
      }
      return { ok: true, status: res.status, data: data as T };
    } catch (err) {
      // Network error (server not running, DNS failure, etc.): fail soft.
      return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
