import { z } from "zod";

// TASK-049. One vocabulary for every model request. Only `user` content may instruct an agent; everything else is data.
export const SOURCE_TAGS = ["user", "agent", "web", "email", "document", "tool"] as const;
export type SourceTag = (typeof SOURCE_TAGS)[number];

export const sourceTagSchema = z.enum(SOURCE_TAGS);

export function canInstruct(tag: SourceTag): boolean {
  return tag === "user";
}
