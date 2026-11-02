import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { scriptNameSchema } from "@/lib/replay/script";
import { compileRun, scriptView } from "@/lib/replay/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const bodySchema = z.object({ name: scriptNameSchema.optional() }).strict();

// Saves one finished, chain-verified run as a replay script. Saving the same run again returns the first script.
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const runId = z.string().uuid().safeParse((await params).runId);
    if (!runId.success) throw new RequestError(400, "invalid_run");
    const body = bodySchema.safeParse(await readBoundedJson(request, 16 * 1024));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const result = await compileRun(await getDatabase(), session.ownerId, runId.data, body.data.name);
    if (result.ok) return Response.json({ script: scriptView(result.script), created: result.created }, { status: result.created ? 201 : 200, headers: NO_STORE });
    if (result.error === "not_replayable") return Response.json({ error: result.error, reasons: result.reasons }, { status: 422, headers: NO_STORE });
    return Response.json({ error: result.error }, { status: result.error === "script_unreadable" ? 500 : 404, headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
