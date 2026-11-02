import "server-only";

import { RequestError, requestErrorResponse } from "../auth/request";
import { ConnectionError } from "../connections/errors";
import { McpError } from "./errors";

export function mcpErrorResponse(error: unknown): Response {
  if (error instanceof RequestError || error instanceof ConnectionError) {
    const response = error instanceof RequestError ? requestErrorResponse(error) : Response.json({ error: error.code }, { status: error.status });
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (error instanceof McpError) {
    return Response.json({ error: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
