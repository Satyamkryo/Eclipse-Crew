import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse, RequestError } from "@/lib/auth/request";
import { narrationUpload } from "@/lib/teach/schema";
import { transcribeCapture, uploadNarration } from "@/lib/teach/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ captureId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true }); requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).captureId);
    if (!id.success) throw new RequestError(400, "invalid_capture");
    const raw = await readBoundedJson(request, 5 * 1024 * 1024);
    const transcribe = z.object({ action: z.literal("transcribe") }).strict().safeParse(raw);
    if (transcribe.success) return Response.json(await transcribeCapture(await getDatabase(), session, id.data));
    const parsed = narrationUpload.safeParse(raw);
    if (!parsed.success) throw new RequestError(400, "invalid_audio");
    return Response.json(await uploadNarration(await getDatabase(), session, id.data, parsed.data));
  } catch (error) { return requestErrorResponse(error); }
}
