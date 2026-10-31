import "server-only";
import { requestErrorResponse } from "../auth/request";
import { AgentLifecycleError } from "./service";

export function agentErrorResponse(error: unknown): Response {
  if (error instanceof AgentLifecycleError) {
    const status = error.code === "agent_not_found" ? 404 : error.code === "confirmation_mismatch" ? 409 : 503;
    return Response.json({ error: error.code }, { status });
  }
  return requestErrorResponse(error);
}
