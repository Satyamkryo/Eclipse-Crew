import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { crewReportActionSchema } from "@/lib/crew/schema";
import { generateReportNow, loadReportSettings, saveReportSettings } from "@/lib/crew/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    const settings = await loadReportSettings(await getDatabase(), session.ownerId);
    return Response.json({ settings }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const parsed = crewReportActionSchema.safeParse(await readBoundedJson(request, 4 * 1024));
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400, headers: NO_STORE });
    const database = await getDatabase();
    if (parsed.data.action === "save") {
      const settings = await saveReportSettings(database, session.ownerId, parsed.data);
      return Response.json({ settings, result: null }, { headers: NO_STORE });
    }
    const result = await generateReportNow(database, session.ownerId);
    const settings = await loadReportSettings(database, session.ownerId);
    return Response.json({ settings, result }, { headers: NO_STORE });
  } catch (error) {
    const response = requestErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
