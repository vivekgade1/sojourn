import { describe, it, expect, vi } from "vitest";
import { subscribeToEvents, type OpenCodeEvent } from "../src/sse.js";

/** Builds a ReadableStream<Uint8Array> that yields the given raw SSE text chunks, then ends. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

/**
 * A delay stub that never resolves. Used once a test has captured everything
 * it needs from the first connection attempt, so the subscribeToEvents
 * reconnect loop parks forever on `delay()` instead of tight-looping against
 * an exhausted stream (which would spin unboundedly fast and OOM the test
 * process, since a real reconnect target would rate-limit itself via real
 * wall-clock backoff).
 */
function parkForever(): Promise<void> {
  return new Promise(() => {});
}

describe("subscribeToEvents", () => {
  it("parses data: frames separated by blank lines into events", async () => {
    const events: OpenCodeEvent[] = [];
    const stream = streamOf([
      'data: {"type":"server.connected"}\n\n',
      'data: {"type":"session.updated","properties":{"info":{"id":"ses_1"}}}\n\n',
    ]);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: stream }) as unknown as Response);
    const delayImpl = vi.fn(parkForever);

    const sub = subscribeToEvents({
      baseUrl: "http://fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      delayImpl,
    });

    // Allow the async run() loop to drain the scripted stream; once it hits
    // the end it calls delayImpl (parked forever), so no reconnect happens.
    await vi.waitFor(() => expect(events.length).toBe(2));

    expect(events[0]).toEqual({ type: "server.connected" });
    expect(events[1].type).toBe("session.updated");
    expect(events[1].properties).toEqual({ info: { id: "ses_1" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    sub.close();
  });

  it("requests GET /event against the configured base URL", async () => {
    const stream = streamOf(['data: {"type":"server.connected"}\n\n']);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: stream }) as unknown as Response);
    const delayImpl = vi.fn(parkForever);

    const sub = subscribeToEvents({
      baseUrl: "http://fake:9999",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: () => {},
      delayImpl,
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://fake:9999/event");
    expect(init).toHaveProperty("signal");

    sub.close();
  });

  it("splits multiple frames delivered in a single chunk", async () => {
    const events: OpenCodeEvent[] = [];
    const stream = streamOf([
      'data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n',
    ]);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: stream }) as unknown as Response);
    const delayImpl = vi.fn(parkForever);

    const sub = subscribeToEvents({
      baseUrl: "http://fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      delayImpl,
    });

    await vi.waitFor(() => expect(events.length).toBe(3));
    expect(events.map((e) => e.type)).toEqual(["a", "b", "c"]);

    sub.close();
  });

  it("reassembles a frame split across multiple stream chunks", async () => {
    const events: OpenCodeEvent[] = [];
    const stream = streamOf(['data: {"type":"sess', 'ion.idle"}\n\n']);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: stream }) as unknown as Response);
    const delayImpl = vi.fn(parkForever);

    const sub = subscribeToEvents({
      baseUrl: "http://fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      delayImpl,
    });

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0].type).toBe("session.idle");

    sub.close();
  });

  it("ignores malformed JSON frames via onError and keeps the stream alive for later valid frames", async () => {
    const events: OpenCodeEvent[] = [];
    const errors: unknown[] = [];
    const stream = streamOf(["data: not-json\n\n", 'data: {"type":"ok"}\n\n']);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, body: stream }) as unknown as Response);
    const delayImpl = vi.fn(parkForever);

    const sub = subscribeToEvents({
      baseUrl: "http://fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e),
      delayImpl,
    });

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0].type).toBe("ok");
    expect(errors.length).toBeGreaterThanOrEqual(1);

    sub.close();
  });

  it("reconnects at the flat initial backoff after each successful-but-ended stream", async () => {
    const events: OpenCodeEvent[] = [];
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      const stream = streamOf([`data: {"type":"connect-${callCount}"}\n\n`]);
      return { ok: true, status: 200, body: stream } as unknown as Response;
    });
    const delays: number[] = [];
    // Record each requested delay but still actually yield to the event loop
    // (a real, tiny setTimeout) rather than resolving synchronously-fast —
    // an instant-resolving stub here would let the reconnect loop spin as
    // fast as the CPU allows between polls of vi.waitFor, which can run away
    // before the assertion ever gets a chance to observe it.
    const recordingDelay = vi.fn(async (ms: number) => {
      delays.push(ms);
      await new Promise((r) => setTimeout(r, 1));
    });

    const sub = subscribeToEvents({
      baseUrl: "http://fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      delayImpl: recordingDelay,
      initialBackoffMs: 10,
      maxBackoffMs: 40,
    });

    await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(3));
    sub.close();

    // Each disconnect here is a *successful* connect that then ended (not a
    // failure), so backoff resets to the flat initial value every time
    // rather than compounding — a healthy server that occasionally drops
    // the stream shouldn't make reconnects progressively slower.
    expect(delays[0]).toBe(10);
    expect(delays[1]).toBe(10);
  });

  it("grows backoff across consecutive connection failures, capped at maxBackoffMs", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const delays: number[] = [];
    const recordingDelay = vi.fn(async (ms: number) => {
      delays.push(ms);
      if (delays.length >= 4) return parkForever();
      await new Promise((r) => setTimeout(r, 1));
    });
    const errors: unknown[] = [];

    const sub = subscribeToEvents({
      baseUrl: "http://fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: () => {},
      onError: (e) => errors.push(e),
      delayImpl: recordingDelay,
      initialBackoffMs: 10,
      maxBackoffMs: 40,
    });

    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(4));
    sub.close();

    expect(delays.slice(0, 4)).toEqual([10, 20, 40, 40]); // grows then caps
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it("fails soft and retries when the initial connection is rejected (non-2xx)", async () => {
    const errors: unknown[] = [];
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 500, body: null } as unknown as Response;
      }
      const stream = streamOf(['data: {"type":"recovered"}\n\n']);
      return { ok: true, status: 200, body: stream } as unknown as Response;
    });
    const events: OpenCodeEvent[] = [];
    const delayImpl = vi.fn(async (ms: number) => {
      // First backoff (after the rejected connection) resolves immediately;
      // subsequent ones (after the recovered stream ends) park forever so
      // we don't spin reconnecting against the exhausted recovered stream.
      if (callCount > 1) return parkForever();
      void ms;
    });

    const sub = subscribeToEvents({
      baseUrl: "http://fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e),
      delayImpl,
      initialBackoffMs: 1,
    });

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0].type).toBe("recovered");
    expect(errors.length).toBeGreaterThanOrEqual(1);

    sub.close();
  });

  it("close() stops further reconnect attempts", async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      const stream = streamOf(['data: {"type":"tick"}\n\n']);
      return { ok: true, status: 200, body: stream } as unknown as Response;
    });
    const delayImpl = vi.fn(async () => {});

    const sub = subscribeToEvents({
      baseUrl: "http://fake",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onEvent: () => {},
      delayImpl,
      initialBackoffMs: 1,
    });

    await vi.waitFor(() => expect(callCount).toBeGreaterThanOrEqual(1));
    sub.close();
    const countAtClose = callCount;

    // Give the loop a couple of ticks to notice `closed` — call count must
    // stabilize (not keep climbing) after close().
    await new Promise((r) => setTimeout(r, 20));
    const countShortlyAfter = callCount;
    await new Promise((r) => setTimeout(r, 20));
    expect(callCount).toBe(countShortlyAfter);
    expect(countShortlyAfter).toBeGreaterThanOrEqual(countAtClose);
  });
});
