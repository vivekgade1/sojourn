import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectWs } from "../src/ws";

type Listener = (evt: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, evt: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(evt);
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}

describe("connectWs status reporting", () => {
  const RealWS = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (RealWS) globalThis.WebSocket = RealWS;
  });

  it("reports connected on open and disconnected on close — without any message traffic", () => {
    const statuses: boolean[] = [];
    const unsubscribe = connectWs(
      () => {},
      (connected) => statuses.push(connected),
    );

    const ws = FakeWebSocket.instances[0]!;
    ws.emit("open");
    expect(statuses).toEqual([true]); // an idle-but-open socket IS connected

    ws.emit("close");
    expect(statuses).toEqual([true, false]);
    unsubscribe();
  });

  it("still delivers parsed events to the event listener", () => {
    const events: unknown[] = [];
    const unsubscribe = connectWs((e) => events.push(e));
    const ws = FakeWebSocket.instances[0]!;
    ws.emit("message", { data: JSON.stringify({ type: "project_updated", projectId: "p1" }) });
    expect(events).toEqual([{ type: "project_updated", projectId: "p1" }]);
    unsubscribe();
  });
});
