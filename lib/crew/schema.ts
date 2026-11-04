import { z } from "zod";

// TASK-058. Requests carry no owner id, agent id or policy: the session owns the crew, and each member comes from a
// server-side template. A repeated create is the same request.
export const starterCrewPostSchema = z.object({}).strict();

export interface StarterMemberView {
  templateId: string;
  agentId: string;
  state: "pending" | "creating" | "created" | "failed";
  errorCode: string | null;
  agentName: string | null;
  agentStatus: "active" | "paused" | null;
}

export interface StarterCrewView {
  setup: { id: string; state: "creating" | "partial" | "complete"; updatedAt: string } | null;
  members: StarterMemberView[];
  summary: { total: number; created: number; failed: number; inProgress: number };
}

export const EMPTY_STARTER_CREW: StarterCrewView = {
  setup: null,
  members: [],
  summary: { total: 0, created: 0, failed: 0, inProgress: 0 },
};
