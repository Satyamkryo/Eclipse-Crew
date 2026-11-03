// Shared view-only stream gate. A cached "running" status is not enough to open a desktop WebSocket: the stream route is
// the authority, and the server rejects the upgrade when the desktop is not streaming. Callers must resolve this URL
// immediately before constructing noVNC's RFB viewer and must never fall back to a cached frame.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ViewOnlyStreamError extends Error {
  readonly code = "stream_unavailable";
  constructor() {
    super("stream_unavailable");
    this.name = "ViewOnlyStreamError";
  }
}

type StreamState = {
  state?: unknown;
  graphics?: unknown;
  generation?: unknown;
};

// Uses the exact connectionId that the later WebSocket upgrade will present. Any non-streaming state, including a 409
// from the stream route, resolves to the same fixed error so the UI can show a stopped placeholder.
export async function viewOnlyStreamUrl(httpUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(httpUrl, { cache: "no-store" });
  } catch {
    throw new ViewOnlyStreamError();
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ViewOnlyStreamError();
  }
  const state = (typeof body === "object" && body !== null ? body : {}) as StreamState;
  if (!response.ok || state.state !== "running" || state.graphics !== "running" ||
      typeof state.generation !== "string" || !UUID.test(state.generation)) {
    throw new ViewOnlyStreamError();
  }
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
