import "server-only";

import { RequestError, requestErrorResponse } from "../auth/request";
import { ConnectionError } from "./errors";

export function connectionErrorResponse(error: unknown): Response {
  if (error instanceof RequestError) {
    const response = requestErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (error instanceof ConnectionError) {
    return Response.json({ error: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
