import type { ConnectionBinding, ConnectionPreset } from "./schema";

// TASK-070. A preset is a fixed set of exact host bindings. One GitHub token therefore serves the hosted MCP
// server (Bearer), the REST API (Bearer) and git (Basic), so the same secret never has to be copied three times.
export interface ConnectionPresetDefinition {
  label: string;
  description: string;
  bindings: ConnectionBinding[];
  test: boolean;
}

export const CONNECTION_PRESETS: Record<ConnectionPreset, ConnectionPresetDefinition> = {
  github: {
    label: "GitHub",
    description: "Fine-grained token for the GitHub MCP server, REST API and git over HTTPS.",
    bindings: [
      { host: "api.githubcopilot.com", scheme: "bearer" },
      { host: "api.github.com", scheme: "bearer" },
      { host: "github.com", scheme: "basic", username: "x-access-token" },
    ],
    test: true,
  },
  custom: {
    label: "Custom",
    description: "One exact host, sent as a Bearer token or in a fixed header.",
    bindings: [],
    test: false,
  },
};

export function presetBindings(preset: ConnectionPreset, host: string | undefined, scheme: "bearer" | "header" = "bearer"): ConnectionBinding[] {
  if (preset === "github") return CONNECTION_PRESETS.github.bindings.map((binding) => ({ ...binding }));
  if (!host) throw new Error("host_required");
  return [scheme === "header"
    ? { host, scheme: "header", header: "x-api-key" }
    : { host, scheme: "bearer" }];
}
