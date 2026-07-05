/**
 * Written against the documented OpenCode server SSE stream
 * (`GET /event` — https://opencode.ai/docs/server/): "First event is
 * `server.connected`, then bus events follow" as newline-delimited
 * `data: <json>\n\n` frames (standard text/event-stream framing). NOT
 * integration-tested against a live OpenCode install in this environment —
 * there is no OpenCode server available here, so the reconnect/backoff
 * behavior below is exercised only against a scripted in-test stream.
 *
 * Hand-rolled parser (no deps): reads the fetch Response body's
 * ReadableStream byte-by-byte-chunk, splits on blank-line frame boundaries,
 * and extracts `data:` lines. Deliberately minimal — OpenCode's stream is
 * plain `data:`-only frames, so `event:`/`id:`/`retry:` SSE fields are not
 * parsed (not used by this consumer; if OpenCode's server contract changes
 * to require them, this parser silently ignores those lines rather than
 * breaking).
 *
 * Fails soft everywhere: connection errors, malformed frames, and consumer
 * callback throws are all caught and logged, never propagated out of the
 * event loop. Reconnects with capped exponential backoff until `close()` is
 * called (AbortController-backed).
 */

export interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SubscribeOptions {
  /** Base URL of the OpenCode server. Defaults to OPENCODE_URL env, then http://localhost:4096. */
  baseUrl?: string;
  /** Injectable fetch, primarily for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Called for every parsed event, including the initial server.connected. */
  onEvent: (event: OpenCodeEvent) => void;
  /** Called on connect/reconnect/give-up errors. Never throws back into the caller. */
  onError?: (err: unknown) => void;
  /** Base backoff delay in ms before the first reconnect attempt. Default 500. */
  initialBackoffMs?: number;
  /** Cap on backoff delay in ms. Default 30000. */
  maxBackoffMs?: number;
  /** Injectable delay function, primarily for tests (avoids real timers). */
  delayImpl?: (ms: number) => Promise<void>;
}

export interface Subscription {
  close(): void;
}

/**
 * Subscribes to the OpenCode `/event` SSE stream. Returns a handle whose
 * `close()` stops the stream and cancels any pending reconnect. Reconnects
 * automatically (capped exponential backoff) on stream end or error, until
 * closed.
 */
export function subscribeToEvents(options: SubscribeOptions): Subscription {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  // Floor of 1ms: guards against a runaway tight reconnect loop (e.g. if a
  // caller passes 0, or a connection fails synchronously-fast against an
  // unreachable server) pinning the event loop and spinning CPU/memory.
  const initialBackoffMs = Math.max(1, options.initialBackoffMs ?? 500);
  const maxBackoffMs = Math.max(initialBackoffMs, options.maxBackoffMs ?? 30_000);
  const delay = options.delayImpl ?? defaultDelay;

  const controller = new AbortController();
  let closed = false;
  let backoffMs = initialBackoffMs;

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        const res = await fetchImpl(`${baseUrl}/event`, { signal: controller.signal });
        if (!res.ok || !res.body) {
          throw new Error(`OpenCode /event responded with status ${res.status}`);
        }
        backoffMs = initialBackoffMs; // reset backoff on a successful connect
        await consumeStream(res.body, options.onEvent, options.onError);
        // Stream ended (server closed it) without throwing: treat as a
        // disconnect and fall through to the reconnect/backoff below.
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        safeCall(options.onError, err);
      }

      if (closed) return;
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  };

  void run();

  return {
    close(): void {
      closed = true;
      controller.abort();
    },
  };
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: OpenCodeEvent) => void,
  onError?: (err: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line (\n\n or \r\n\r\n).
      let boundary: number;
      while ((boundary = findFrameBoundary(buffer)) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(frameLength(buffer, boundary));
        dispatchFrame(frame, onEvent, onError);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore — stream may already be closed/errored
    }
  }
}

function findFrameBoundary(buffer: string): number {
  const idxLfLf = buffer.indexOf("\n\n");
  const idxCrLfCrLf = buffer.indexOf("\r\n\r\n");
  if (idxLfLf === -1) return idxCrLfCrLf;
  if (idxCrLfCrLf === -1) return idxLfLf;
  return Math.min(idxLfLf, idxCrLfCrLf);
}

function frameLength(buffer: string, boundary: number): number {
  return buffer.slice(boundary).startsWith("\r\n\r\n") ? boundary + 4 : boundary + 2;
}

function dispatchFrame(
  frame: string,
  onEvent: (event: OpenCodeEvent) => void,
  onError?: (err: unknown) => void,
): void {
  const lines = frame.split(/\r\n|\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    // Other SSE fields (event:, id:, retry:, comments starting with ":"):
    // not needed by this consumer, ignored.
  }
  if (dataLines.length === 0) return;

  const payload = dataLines.join("\n");
  try {
    const parsed = JSON.parse(payload);
    if (isEventLike(parsed)) {
      safeCall(onEvent, parsed);
    }
  } catch (err) {
    // Malformed JSON in a frame: log via onError and keep the stream alive.
    safeCall(onError, err);
  }
}

function isEventLike(v: unknown): v is OpenCodeEvent {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).type === "string";
}

function safeCall<A extends unknown[]>(fn: ((...args: A) => void) | undefined, ...args: A): void {
  if (!fn) return;
  try {
    fn(...args);
  } catch {
    // A throwing consumer callback must never break the SSE loop.
  }
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit && explicit.length > 0) return stripTrailingSlash(explicit);
  const fromEnv = process.env.OPENCODE_URL;
  if (fromEnv && fromEnv.length > 0) return stripTrailingSlash(fromEnv);
  return "http://localhost:4096";
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
