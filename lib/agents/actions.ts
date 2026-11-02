// The action names an agent can be allowed to use. No "server-only" here: the agent form (a client component) shows them too.
// Default-deny still applies: an agent can only use an action that is listed in its own `actions`.
export const DESKTOP_ACTIONS = ["click", "type", "key", "scroll", "wait"] as const;
export const FILE_ACTIONS = ["read_document", "deliver_file"] as const;
// TASK-054. `remember` only asks the owner to save a memory; it never writes one.
export const MEMORY_ACTIONS = ["remember"] as const;
// TASK-072. Remote tool calls are opt-in and never part of the default create form.
export const TOOL_ACTIONS = ["tool_call"] as const;
// TASK-073. A shell is opt-in and never part of the default create form.
export const SHELL_ACTIONS = ["shell"] as const;
export const KNOWN_ACTIONS = [...DESKTOP_ACTIONS, ...FILE_ACTIONS, ...MEMORY_ACTIONS] as const;

// Owner-facing stop text when the model asks for an action the agent is not allowed to use.
export function notAllowedText(action: string): string {
  return `I am not allowed to use the "${action}" action, so I stopped and need you. Add "${action}" to this agent's Actions in its settings to allow it.`;
}
