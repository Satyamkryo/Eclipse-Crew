import { getDatabase } from "@/db/client";
import { requireNoQuery, requireOwnerRequest, requestErrorResponse } from "@/lib/auth/request";
import { auditSigningAvailable, loadAuditExport } from "@/lib/security/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TASK-052. The export is the owner's chain only: public key and key id, never the signing seed.
export async function GET(request: Request) {
  try {
    const session = await requireOwnerRequest(request);
    requireNoQuery(request);
    if (!auditSigningAvailable()) {
      return Response.json({ error: "audit_signing_unavailable" }, {
        status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    const exported = await loadAuditExport(await getDatabase(), session.ownerId);
    return new Response(JSON.stringify(exported), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="eclipse-crew-audit.json"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const response = requestErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  }
}
