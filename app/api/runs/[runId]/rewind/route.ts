import { z } from "zod";
import { getDatabase } from "@/db/client";
import { readBoundedJson, requestErrorResponse, requireNoQuery, requireOwnerRequest, RequestError } from "@/lib/auth/request";
import { RewindError, startBranch } from "@/lib/rewind/branch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const bodySchema = z.object({
  step: z.number().int().min(0).max(1000),
  correction: z.string().min(1).max(600)
    .refine((value) => value.trim().length > 0, "a correction is required")
    .refine((value) => !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(value), "no control characters"),
}).strict();

// Restores one checkpoint and starts a new branch run. Files are restored inside this request; the model run then answers
// as a chat card and a History run, like any other run.
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const runId = z.string().uuid().safeParse((await params).runId);
    if (!runId.success) throw new RequestError(400, "invalid_run");
    const body = bodySchema.safeParse(await readBoundedJson(request, 16 * 1024));
    if (!body.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });

    const result = await startBranch({
      database: await getDatabase(), ownerId: session.ownerId, runId: runId.data,
      step: body.data.step, correction: body.data.correction,
    });
    return Response.json(result, { status: result.starting ? 202 : 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof RewindError) {
      return Response.json({ error: error.code, ...(error.restored ? { restored: error.restored } : {}) },
        { status: error.status, headers: NO_STORE });
    }
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
