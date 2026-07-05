// Tiny HTTP client for the sojourn daemon (docs/API.md).
// Kept dependency-free (uses global fetch, available on Node >=18).

export interface HttpResponse<T> {
  status: number;
  body: T;
}

export class DaemonClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async get<T = unknown>(path: string): Promise<HttpResponse<T>> {
    const res = await fetch(this.url(path), { method: "GET" });
    const body = (await safeJson(res)) as T;
    return { status: res.status, body };
  }

  async post<T = unknown>(path: string, payload?: unknown): Promise<HttpResponse<T>> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: payload === undefined ? undefined : { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = (await safeJson(res)) as T;
    return { status: res.status, body };
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** encode a ChronoNode/Flag id (contains ":") for use in a URL path segment */
export function encodeNodeId(id: string): string {
  return encodeURIComponent(id);
}
