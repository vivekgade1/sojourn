import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App";
import { api } from "../src/api";
import { FakeWebSocket, graphResponse, makeSession, project } from "./harness";

const sessionB = makeSession("sB", "2026-07-02T10:00:00.000Z", [
  "prompt",
  "assistant",
  "prompt",
  "assistant",
]);

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubHealthyApi() {
  const listSpy = vi.spyOn(api, "listProjects").mockResolvedValue([project]);
  const graphSpy = vi.spyOn(api, "getGraph").mockResolvedValue(graphResponse(sessionB));
  const healthSpy = vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "test" });
  return { listSpy, graphSpy, healthSpy };
}

describe("App / reconnect recovery", () => {
  it("does not duplicate fetches on the FIRST successful connect", async () => {
    const { listSpy, graphSpy } = stubHealthyApi();
    render(<App />);
    await waitFor(() => expect(graphSpy).toHaveBeenCalledTimes(1));

    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.emit("open");
    });
    await waitFor(() => expect(screen.getByText("live")).toBeTruthy());

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(graphSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches projects and the current graph after disconnect → reconnect", async () => {
    const { listSpy, graphSpy } = stubHealthyApi();
    render(<App />);
    await waitFor(() => expect(graphSpy).toHaveBeenCalledTimes(1));

    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.emit("open");
    });
    await act(async () => {
      ws.emit("close");
    });
    await act(async () => {
      ws.emit("open");
    });

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(graphSpy).toHaveBeenCalledTimes(2));
    expect(graphSpy).toHaveBeenLastCalledWith(project.id);
  });
});

describe("App / daemon-down banner", () => {
  it("shows the banner when the ws is disconnected AND a fetch has failed", async () => {
    vi.spyOn(api, "listProjects").mockRejectedValue(new Error("daemon gone"));
    vi.spyOn(api, "health").mockRejectedValue(new Error("daemon gone"));
    render(<App />);

    const banner = await screen.findByTestId("daemon-banner");
    expect(banner.textContent).toMatch(/daemon unreachable/i);
    expect(banner.textContent).toMatch(/soj start/);
    expect(banner.textContent).toMatch(/recover automatically/i);
    // The small pill stays, distinct from the banner.
    expect(screen.getByText("disconnected")).toBeTruthy();
  });

  it("shows the banner when the daemon dies mid-session (ws close + failing health probe)", async () => {
    const { graphSpy, healthSpy } = stubHealthyApi();
    render(<App />);
    await waitFor(() => expect(graphSpy).toHaveBeenCalledTimes(1));

    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.emit("open");
    });
    expect(screen.queryByTestId("daemon-banner")).toBeNull();

    healthSpy.mockRejectedValue(new Error("connection refused"));
    await act(async () => {
      ws.emit("close");
    });
    await waitFor(() => expect(screen.getByTestId("daemon-banner")).toBeTruthy());
  });

  it("does NOT show the banner on a transient socket blip while the daemon is reachable", async () => {
    const { graphSpy } = stubHealthyApi();
    render(<App />);
    await waitFor(() => expect(graphSpy).toHaveBeenCalledTimes(1));

    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.emit("open");
    });
    await act(async () => {
      ws.emit("close");
    });

    await waitFor(() => expect(screen.getByText("disconnected")).toBeTruthy());
    expect(screen.queryByTestId("daemon-banner")).toBeNull();
  });

  it("does NOT show the banner when a fetch fails but the ws is connected", async () => {
    vi.spyOn(api, "listProjects").mockRejectedValue(new Error("one-off failure"));
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "test" });
    render(<App />);

    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.emit("open");
    });

    // Failure surfaces through the existing error state, not the banner.
    await waitFor(() => expect(screen.getByText("one-off failure")).toBeTruthy());
    expect(screen.queryByTestId("daemon-banner")).toBeNull();
  });

  it("is dismissible", async () => {
    vi.spyOn(api, "listProjects").mockRejectedValue(new Error("daemon gone"));
    vi.spyOn(api, "health").mockRejectedValue(new Error("daemon gone"));
    render(<App />);

    const banner = await screen.findByTestId("daemon-banner");
    expect(banner).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: /dismiss/i }).click();
    });
    expect(screen.queryByTestId("daemon-banner")).toBeNull();
  });

  it("clears itself and recovers the data when the daemon comes back", async () => {
    const listSpy = vi
      .spyOn(api, "listProjects")
      .mockRejectedValueOnce(new Error("daemon gone"))
      .mockResolvedValue([project]);
    const graphSpy = vi.spyOn(api, "getGraph").mockResolvedValue(graphResponse(sessionB));
    vi.spyOn(api, "health").mockResolvedValue({ ok: true, version: "test" });

    render(<App />);
    await screen.findByTestId("daemon-banner");

    // Daemon restarts: the socket connects for the first time. Because the
    // initial fetches failed, this must trigger a full refetch.
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.emit("open");
    });

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(graphSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("daemon-banner")).toBeNull());
    // Graph actually recovered — waypoints render.
    await waitFor(() => expect(screen.getAllByTestId("map-waypoint").length).toBeGreaterThan(0));
  });

  it("does not console.error raw stacks for App's own fetch failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(api, "listProjects").mockRejectedValue(new Error("quiet-failure"));
    vi.spyOn(api, "health").mockRejectedValue(new Error("quiet-failure"));

    render(<App />);
    // Surfaced through the existing error state...
    await waitFor(() => expect(screen.getByText("quiet-failure")).toBeTruthy());

    // ...not through console.error.
    const noisy = errorSpy.mock.calls.filter((args) =>
      args.some((a) => String(a).includes("quiet-failure")),
    );
    expect(noisy).toEqual([]);
  });
});
