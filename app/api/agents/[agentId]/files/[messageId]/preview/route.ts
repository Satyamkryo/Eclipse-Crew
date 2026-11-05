import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { getMediaFileCard } from "@/lib/chat/data";
import { desktopDownloadOutbox } from "@/lib/desktop/client";
import { NO_STORE, outboxError } from "@/lib/chat/outbox-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Inline previews for chat media. Only these non-scriptable types are ever rendered in the app's origin (no SVG,
// no HTML); everything else stays download-only through the parent route. The desktop still confirms size and SHA-256.
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
};

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string; messageId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    if (new URL(request.url).search) throw new RequestError(400, "invalid_query");
    const ids = z.object({ agentId: z.string().uuid(), messageId: z.string().uuid() }).safeParse(await params);
    if (!ids.success) throw new RequestError(400, "invalid_agent");
    const card = await getMediaFileCard(await getDatabase(), session.ownerId, ids.data.agentId, ids.data.messageId);
    const type = card ? MEDIA_TYPES[card.name.split(".").pop()?.toLowerCase() ?? ""] : undefined;
    if (!card || !type || !type.startsWith(`${card.kind}/`) || card.size === 0) {
      return Response.json({ error: "preview_unavailable" }, { status: 404, headers: NO_STORE });
    }
    const body = await desktopDownloadOutbox(ids.data.agentId, session.ownerId, card, request.signal, card.direction);
    return new Response(body, { status: 200, headers: { ...NO_STORE, "Content-Type": type, "Content-Length": String(card.size),
      "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" } });
  } catch (error) {
    return outboxError(error);
  }
}
