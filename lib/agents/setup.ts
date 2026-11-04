import { DESKTOP_ACTIONS } from "./actions";

export interface SetupConnection { preset: "github" | "custom"; bindings: { host: string }[] }
export interface SetupServer { key: string; status: "pinned" | "changed" | "disabled" }
export interface SetupRow { label: string; done: boolean; detail: string }

// TASK-074/058. What a role's checklist actually needs. GitHub rows belong only to a policy that names GitHub; no mail or
// calendar slug is invented for the other roles. Pure so the template tests can prove it.
export function setupNeedsRemote(actions: string[], tools: string[]): boolean {
  return tools.includes("github") || actions.includes("tool_call");
}

export function setupRows(
  actions: string[], tools: string[], domains: string[],
  state: { connections: SetupConnection[]; servers: SetupServer[] },
  anyPublicWeb = false,
): SetupRow[] {
  const usesGithub = tools.includes("github");
  const usesTools = actions.includes("tool_call");
  const usesShell = actions.includes("shell");
  const usesBrowser = actions.some((action) => (DESKTOP_ACTIONS as readonly string[]).includes(action));
  const rows: SetupRow[] = [];

  if (usesGithub) {
    rows.push(
      {
        label: "GitHub connection saved",
        done: state.connections.some((connection) => connection.preset === "github" || connection.bindings.some((binding) => binding.host === "github.com")),
        detail: "Settings → Connections → Add connection",
      },
      {
        label: "GitHub MCP server pinned",
        done: state.servers.some((server) => server.key === "github" && server.status === "pinned"),
        detail: state.servers.some((server) => server.key === "github" && server.status === "changed")
          ? "The tool list changed — review and re-pin it in Settings → Connections"
          : "Settings → Connections → MCP servers → Add MCP server",
      },
    );
  } else if (usesTools) {
    rows.push(
      {
        label: "A connection saved for this agent",
        done: state.connections.length > 0,
        detail: "Settings → Connections → Add the mail or calendar account you use",
      },
      {
        label: "The account's MCP server pinned",
        done: tools.length > 0 && state.servers.some((server) => tools.includes(server.key) && server.status === "pinned"),
        detail: state.servers.some((server) => tools.includes(server.key) && server.status === "changed")
          ? "The tool list changed — review and re-pin it in Settings → Connections"
          : "Settings → Connections → MCP servers → pin the server you use",
      },
      {
        label: "Its server key added under Tools",
        done: tools.length > 0,
        detail: "Agent settings → Tools: add the pinned server key. This template starts with no tool allowed.",
      },
    );
  }
  if (usesShell || usesBrowser) {
    rows.push(anyPublicWeb ? {
      label: "Websites allowed",
      done: true,
      detail: "Any public website. Narrow it in Agent settings → Advanced → Websites.",
    } : {
      label: usesShell && usesGithub ? "github.com in Websites" : "Websites allowed",
      done: domains.length > 0,
      detail: usesShell && usesGithub
        ? "Agent settings → Advanced → Websites"
        : "Agent settings → Advanced → Websites: choose Any public website, or add each site this role may read.",
    });
  }
  if (usesBrowser) {
    rows.push({
      label: "Desktop and browser actions allowed",
      done: true,
      detail: "Set by this template. Login, payment and CAPTCHA steps always stay with you.",
    });
  }
  return rows;
}
