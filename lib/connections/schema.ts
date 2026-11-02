import { z } from "zod";

// TASK-070. Hosts are exact DNS names (no wildcards, no IP literals), using the same rule as agent domains.
export const CONNECTION_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const CONNECTION_HEADERS = ["x-api-key", "apikey"] as const;

export const connectionPresetSchema = z.enum(["github", "custom"]);
export const connectionSchemeSchema = z.enum(["bearer", "basic", "header"]);

const host = z.string().max(253).regex(CONNECTION_HOST);
const token = z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/, "Tokens must be printable ASCII without spaces.");

export const connectionBindingSchema = z.object({
  host,
  scheme: connectionSchemeSchema,
  header: z.enum(CONNECTION_HEADERS).optional(),
  username: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.scheme === "header" && !value.header) {
    context.addIssue({ code: "custom", path: ["header"], message: "Choose a header." });
  }
  if (value.scheme !== "header" && value.header) {
    context.addIssue({ code: "custom", path: ["header"], message: "Headers are only used with the header scheme." });
  }
  if (value.scheme === "basic" && !value.username) {
    context.addIssue({ code: "custom", path: ["username"], message: "A basic binding needs a username." });
  }
  if (value.scheme !== "basic" && value.username) {
    context.addIssue({ code: "custom", path: ["username"], message: "Usernames are only used with the basic scheme." });
  }
});

export const connectionBindingsSchema = z.array(connectionBindingSchema).min(1).max(4);

export const connectionCreateSchema = z.object({
  agentId: z.string().uuid(),
  preset: connectionPresetSchema,
  label: z.string().trim().min(1).max(60),
  token,
  host: host.optional(),
  scheme: z.enum(["bearer", "header"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.preset === "custom" && !value.host) {
    context.addIssue({ code: "custom", path: ["host"], message: "Enter the tool's host." });
  }
  if (value.preset !== "custom" && value.host) {
    context.addIssue({ code: "custom", path: ["host"], message: "This preset sets its own hosts." });
  }
  if (value.preset !== "custom" && value.scheme) {
    context.addIssue({ code: "custom", path: ["scheme"], message: "This preset sets its own scheme." });
  }
});

export const connectionUpdateSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  token: z.union([token, z.literal("")]).optional(),
}).strict().refine((value) => value.label !== undefined || value.token !== undefined, {
  message: "Change the label or replace the token.",
});

export const connectionIdSchema = z.string().uuid();

export type ConnectionPreset = z.infer<typeof connectionPresetSchema>;
export type ConnectionBinding = z.infer<typeof connectionBindingSchema>;
export type ConnectionCreateInput = z.infer<typeof connectionCreateSchema>;
export type ConnectionUpdateInput = z.infer<typeof connectionUpdateSchema>;
