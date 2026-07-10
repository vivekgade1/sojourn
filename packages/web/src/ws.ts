import type { WsEvent } from "./types";

export type WsListener = (event: WsEvent) => void;
export type WsStatusListener = (connected: boolean) => void;

/**
 * Opens a WebSocket to /ws (proxied to the daemon in dev) and reconnects with
 * backoff on close. `onStatus` reports the socket's actual OPEN/CLOSED state
 * — an idle-but-open socket is connected; message arrival is irrelevant.
 * Returns an unsubscribe function.
 */
export function connectWs(onEvent: WsListener, onStatus?: WsStatusListener): () => void {
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
      onStatus?.(false);
      if (closedByCaller) return;
      retryTimer = setTimeout(() => {
        retryDelay = Math.min(retryDelay * 2, 15000);
        connect();
      }, retryDelay);
    });

    socket.addEventListener("open", () => {
      retryDelay = 1000;
      onStatus?.(true);
    });
  }

  connect();

  return () => {
    closedByCaller = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
}
