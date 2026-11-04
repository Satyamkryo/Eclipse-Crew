import { requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { measureArtifacts } from "@/lib/retention/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// Owner-scoped storage meter: heavy artifact bytes vs the instance cap.
// Receipts and audit rows are append-only and not counted here.
export async function GET(request: Request) {
  try {
    await requireOwnerRequest(request);
    requireNoQuery(request);
    const usage = await measureArtifacts();
    return Response.json({ ...usage, warn: usage.fraction >= 0.8, full: usage.fraction >= 1 }, { headers: NO_STORE });
  } catch (error) {
    // Errors are no-store too, like the other owner routes.
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
