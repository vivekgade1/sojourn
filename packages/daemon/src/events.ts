import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ChronoNode, StoredFlag } from "@sojourn/core";

export type SojournEvent =
  | { type: "node_added"; node: ChronoNode }
  | { type: "flags_updated"; nodeId: string; flags: StoredFlag[] }
  | { type: "project_updated"; projectId: string };

/**
 * Minimal WebSocket broadcast hub. Attaches a `WebSocketServer` to an
 * existing HTTP server at path `/ws` and exposes `broadcast(event)` to push
 * JSON events to every currently-connected client. Never throws: a send
 * failure on one client is logged and does not affect others.
 */
export class EventsHub {
  private readonly wss: WebSocketServer;

  constructor(server: HttpServer, path = "/ws") {
    this.wss = new WebSocketServer({ server, path });
  }

  broadcast(event: SojournEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      } catch (err) {
        console.error("[sojourn] failed to send WS event to a client:", err);
      }
    }
  }

  close(): void {
    this.wss.close();
  }
}
