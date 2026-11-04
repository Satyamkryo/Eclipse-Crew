import { z } from "zod";

import { getDatabase } from "@/db/client";
import { readBoundedJson, requireNoQuery, requireOwnerRequest } from "@/lib/auth/request";
import { createModelSettingsStore } from "@/lib/models/data";
import { modelErrorResponse } from "@/lib/models/http";
import { backgroundModelSettingsSchema, mainModelSettingsSchema, samModelSettingsSchema } from "@/lib/models/schema";
import { saveBackgroundSettings, saveMainSettings, saveSamSettings } from "@/lib/models/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, { params }: { params: Promise<{ role: string }> }) {
  try {
    const session = await requireOwnerRequest(request, { mutation: true });
    requireNoQuery(request);
    const role = z.enum(["main", "sam", "background"]).safeParse((await params).role);
    if (!role.success) return Response.json({ error: "invalid_role" }, { status: 400 });
    const body = await readBoundedJson(request, 16 * 1024);
    const store = createModelSettingsStore(await getDatabase());

    if (role.data === "main") {
      const parsed = mainModelSettingsSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
      return Response.json(await saveMainSettings(store, session.ownerId, parsed.data));
    }

    if (role.data === "background") {
      const parsed = backgroundModelSettingsSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
      return Response.json(await saveBackgroundSettings(store, session.ownerId, parsed.data));
    }

    const parsed = samModelSettingsSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: "invalid_input" }, { status: 400 });
    return Response.json(await saveSamSettings(store, session.ownerId, parsed.data));
  } catch (error) {
    return modelErrorResponse(error);
  }
}
