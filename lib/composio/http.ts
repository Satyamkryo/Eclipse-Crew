import "server-only";

import { RequestError, requestErrorResponse } from "../auth/request";
import { ComposioError } from "./errors";

export function composioErrorResponse(error: unknown): Response {
  if (error instanceof RequestError) {
    const response = requestErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (error instanceof ComposioError) {
    return Response.json({ error: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
