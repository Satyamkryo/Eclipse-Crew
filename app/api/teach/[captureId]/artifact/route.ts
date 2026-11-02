import { z } from "zod";
import { getDatabase } from "@/db/client";
import { requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { getCaptureArtifact, ownedCapture, parseStoredManifest } from "@/lib/teach/store";
import { teachHash } from "@/lib/teach/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ captureId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    const id = z.string().uuid().safeParse((await params).captureId);
    const entries = [...new URL(request.url).searchParams];
    const query = z.object({ hash: teachHash }).strict().safeParse(Object.fromEntries(entries));
    if (!id.success || !query.success || entries.length !== 1) throw new RequestError(400, "invalid_artifact");
    const row = await ownedCapture(await getDatabase(), session.ownerId, id.data);
    if (row.state !== "complete") throw new RequestError(409, "capture_not_complete");
    const descriptor = parseStoredManifest(row.manifest).artifacts.find((item) => item.hash === query.data.hash);
    if (!descriptor) throw new RequestError(404, "artifact_not_found");
    const bytes = await getCaptureArtifact(session.ownerId, id.data, descriptor.hash);
    if (!bytes) throw new RequestError(404, "artifact_not_found");
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": descriptor.mime, "Content-Length": String(bytes.length),
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
      "Content-Disposition": `inline; filename="teach-${descriptor.kind}.${descriptor.mime === "video/webm" ? "webm" : descriptor.mime === "audio/wav" ? "wav" : "png"}"` } });
  } catch (error) { return requestErrorResponse(error); }
}
