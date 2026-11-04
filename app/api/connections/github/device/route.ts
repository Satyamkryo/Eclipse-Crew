import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { connectionErrorResponse } from "@/lib/connections/http";
import { startGithubDevice } from "@/lib/connections/github-device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TASK-088. Starts a GitHub App device sign-in. The response carries the short code and link only; the device
// code stays encrypted on the server.
export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const flow = await startGithubDevice(await getDatabase(), session.ownerId, await readBoundedJson(request, 4 * 1024));
    return Response.json(flow, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
