import { z } from "zod";
import { ChatDataError, appendUserFile, requireActiveAgent, serializeMessage } from "@/lib/chat/data";
import { getDatabase } from "@/db/client";
import { requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { requireMaxUploadBytes } from "@/lib/config/server";
import { desktopUploadInbox } from "@/lib/desktop/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// proxy.ts does not run for this route (its body would be buffered and cut at 10 MB), so this route does the
// owner, Origin and CSRF checks itself and sets the security headers on every answer.
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox" };
const UPLOAD_ERRORS: Record<string, number> = { file_too_large: 413, type_blocked: 415, name_invalid: 400, empty_file: 400,
  incomplete_upload: 400, upload_busy: 409, agent_paused: 409, agent_not_found: 404, agent_unavailable: 404 };
const json = (value: unknown, status: number) => Response.json(value, { status, headers: HEADERS });
const fail = (code: string) => json({ error: code }, UPLOAD_ERRORS[code] ?? 503);

async function discard(request: Request, maximum: number) {
  const reader = request.body?.getReader();
  if (!reader) return;
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 60_000);
  let seen = 0;
  try {
    while (seen <= maximum) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value.byteLength;
    }
  } catch { /* connection gone */ } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const agent = z.string().uuid().safeParse((await params).agentId);
    if (!agent.success) throw new RequestError(400, "invalid_agent");
    const agentId = agent.data;
    const limit = requireMaxUploadBytes();
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/octet-stream")
      throw new RequestError(415, "octet_stream_required");
    if (request.headers.has("transfer-encoding")) throw new RequestError(411, "length_required");
    const declared = request.headers.get("content-length");
    if (declared === null) throw new RequestError(411, "length_required");
    if (!/^[0-9]{1,13}$/.test(declared)) throw new RequestError(400, "invalid_length");
    const size = Number(declared);
    const encodedName = request.headers.get("x-file-name");
    if (!encodedName || encodedName.length > 3072) throw new RequestError(400, "name_invalid");
    let name: string;
    try { name = decodeURIComponent(encodedName); } catch { throw new RequestError(400, "name_invalid"); }
    if (name.length > 1024 || /[\u0000-\u001f\u007f]/.test(name)) throw new RequestError(400, "name_invalid");
    if (size < 1) return fail("empty_file");
    if (size > limit) {
      // Read a body that is only a little too large so the browser gets a clear answer, not a reset connection.
      if (size <= limit + 64 * 1024 * 1024) await discard(request, size);
      return fail("file_too_large");
    }
    if (!request.body) return fail("incomplete_upload");

    const database = await getDatabase();
    try { await requireActiveAgent(database, session.ownerId, agentId); }
    catch (error) {
      await discard(request, size);
      if (error instanceof ChatDataError) return fail(error.code);
      throw error;
    }

    // Count what really arrives. A body that differs from the declared length is refused, never stored short.
    let seen = 0; let mismatch = false;
    const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > size) { mismatch = true; controller.error(new Error("incomplete_upload")); return; }
        controller.enqueue(chunk);
      },
      flush(controller) { if (seen !== size) { mismatch = true; controller.error(new Error("incomplete_upload")); } },
    }));
    let stored;
    try { stored = await desktopUploadInbox(agentId, session.ownerId, body, { name, size, limit }); }
    catch (error) {
      if (mismatch) return fail("incomplete_upload");
      const code = (error as { code?: string })?.code;
      if (code && code in UPLOAD_ERRORS) return fail(code);
      return fail("upload_failed");
    }
    const message = await appendUserFile(database, session.ownerId, agentId,
      { name: stored.storedName, size: stored.size, kind: stored.kind, sha256: stored.sha256 });
    return json({ message: serializeMessage(message) }, 201);
  } catch (error) {
    if (error instanceof ChatDataError) return fail(error.code === "invalid_card" ? "upload_failed" : error.code);
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(HEADERS)) response.headers.set(key, value);
    return response;
  }
}
