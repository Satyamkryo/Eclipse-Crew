import "server-only";

import { RequestError, requestErrorResponse } from "../auth/request";
import { ModelSettingsError } from "./errors";

export function modelErrorResponse(error: unknown): Response {
  if (error instanceof RequestError) return requestErrorResponse(error);
  if (error instanceof ModelSettingsError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  return Response.json({ error: "service_unavailable" }, { status: 503 });
}
