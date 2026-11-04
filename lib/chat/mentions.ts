// TASK-085. A message that starts with `@Name ` addresses one teammate. Only the first word is checked; a mention
// later in a sentence is ordinary text. Pure so the route and tests share one rule.
const MENTION = /^@([^\s@]{1,80})[ \t]+([\s\S]+)$/;

export interface Mention { name: string; text: string }

export function parseMention(value: string): Mention | null {
  const match = MENTION.exec(value.trimStart());
  if (!match) return null;
  const text = match[2].trim();
  return text ? { name: match[1], text } : null;
}

// Agent names are compared case-insensitively but must match exactly otherwise.
export function namesAgent(agentName: string, mention: string): boolean {
  return agentName.trim().toLowerCase() === mention.trim().toLowerCase();
}
