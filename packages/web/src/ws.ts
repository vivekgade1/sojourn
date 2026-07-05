import type { WsEvent } from "./types";

export type WsListener = (event: WsEvent) => void;

/**
 * Opens a WebSocket to /ws (proxied to the daemon in dev) and reconnects with
 * backoff on close. Returns an unsubscribe function.
 */
export function connectWs(onEvent: WsListener): () => void {
  let socket: WebSocket | null = null;
  let closedByCaller = false;
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const url = () => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  };

  function connect() {
    socket = new WebSocket(url());

    socket.addEventListener("message", (evt) => {
      try {
        const parsed = JSON.parse(evt.data) as WsEvent;
        onEvent(parsed);
      } catch {
        // ignore malformed frames
      }
    });

    socket.addEventListener("close", () => {
      if (closedByCaller) return;
      retryTimer = setTimeout(() => {
        retryDelay = Math.min(retryDelay * 2, 15000);
        connect();
      }, retryDelay);
    });

    socket.addEventListener("open", () => {
      retryDelay = 1000;
    });
  }

  connect();

  return () => {
    closedByCaller = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
}
