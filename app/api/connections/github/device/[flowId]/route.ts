import { z } from "zod";

import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { connectionErrorResponse } from "@/lib/connections/http";
import { getGithubDeviceFlow } from "@/lib/connections/github-device";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TASK-088. The UI polls this owner-scoped view. It never contains the device code, the access token or the refresh token.
export async function GET(request: Request, { params }: { params: Promise<{ flowId: string }> }) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const id = z.string().uuid().safeParse((await params).flowId);
    if (!id.success) return Response.json({ error: "invalid_id" }, { status: 400 });
    const flow = await getGithubDeviceFlow(await getDatabase(), session.ownerId, id.data);
    return Response.json(flow, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
