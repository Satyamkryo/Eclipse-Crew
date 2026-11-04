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
// TASK-079. Agent hearing is opt-in and never part of the default create form.
export const AUDIO_ACTIONS = ["hear_audio"] as const;
// Starting the agent's own graphics/browser is a lifecycle action, not a screen action. It is still default-deny.
export const LIFECYCLE_ACTIONS = ["start_desktop", "start_browser"] as const;
// TASK-085. New agents start with handoff on; existing agents are unchanged until the owner enables it.
export const HANDOFF_ACTIONS = ["handoff"] as const;
// TASK-076. Background helpers are off by default and never part of the create form's default list.
export const SUBAGENT_ACTIONS = ["spawn_subagent"] as const;
export const KNOWN_ACTIONS = [...DESKTOP_ACTIONS, ...LIFECYCLE_ACTIONS, ...FILE_ACTIONS, ...MEMORY_ACTIONS, ...HANDOFF_ACTIONS] as const;

// Owner-facing stop text when the model asks for an action the agent is not allowed to use.
export function notAllowedText(action: string): string {
  return `I am not allowed to use the "${action}" action, so I stopped and need you. Add "${action}" to this agent's Actions in its settings to allow it.`;
}

// TASK-076. The agent form shows the hint next to Actions; it is not in KNOWN_ACTIONS, so it stays off by default.
export const SUBAGENT_HINT = "Add spawn_subagent to let this agent start up to 3 background helpers for work that doesn't need the screen.";
