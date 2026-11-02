import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { getOutboxFileCard } from "@/lib/chat/data";
import { desktopDownloadOutbox } from "@/lib/desktop/client";
import { NO_STORE, outboxError } from "@/lib/chat/outbox-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contentDisposition(name: string) {
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "download";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Always a download, never rendered in the app's origin. The desktop confirms the file still matches its card
// (size and SHA-256) before it sends the first byte.
export async function GET(request: Request, { params }: { params: Promise<{ agentId: string; messageId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    if (new URL(request.url).search) throw new RequestError(400, "invalid_query");
    const ids = z.object({ agentId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(await params);
    if (!ids.success) throw new RequestError(400, "invalid_agent");
    const card = await getOutboxFileCard(await getDatabase(), session.ownerId, ids.data.agentId, ids.data.messageId);
    if (!card) return Response.json({ error: "file_not_found" }, { status: 404, headers: NO_STORE });
    const body = await desktopDownloadOutbox(ids.data.agentId, session.ownerId, card, request.signal);
    return new Response(body, { status: 200, headers: { ...NO_STORE, "Content-Type": "application/octet-stream", "Content-Length": String(card.size),
      "Content-Disposition": contentDisposition(card.name), "Content-Security-Policy": "sandbox; default-src 'none'" } });
  } catch (error) {
    return outboxError(error);
  }
}
