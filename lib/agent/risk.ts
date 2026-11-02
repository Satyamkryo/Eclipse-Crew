// TASK-050. Risky actions are decided by code from the grounded control name and the model's `expect` text. The model
// never labels its own action; `expect` may only raise `none` to a class, never lower a class the control name implies.

export const ACTION_CLASSES = ["download", "send", "post", "delete", "purchase", "submit"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];
export type RiskClass = ActionClass | "none";

export const ACTION_CLASS_LABELS: Record<RiskClass, string> = {
  download: "Download",
  send: "Send",
  post: "Post",
  delete: "Delete",
  purchase: "Purchase",
  submit: "Submit",
  none: "None",
};

// Ordered by how much damage a mistake can do. The first matching class wins.
const KEYWORDS: ReadonlyArray<[ActionClass, readonly string[]]> = [
  ["purchase", ["buy", "purchase", "pay", "checkout", "place order", "donate"]],
  ["delete", ["delete", "remove", "erase", "discard", "unsubscribe"]],
  ["send", ["send", "share", "invite", "forward", "reply", "email"]],
  ["post", ["post", "publish", "comment"]],
  ["submit", ["submit", "confirm", "approve", "accept", "sign", "apply"]],
  ["download", ["download", "export", "save as", "save", "saved"]],
];

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classOf(value: unknown): ActionClass | null {
  if (typeof value !== "string") return null;
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  for (const [actionClass, words] of KEYWORDS) {
    if (words.some((word) => new RegExp(`(?:^|\\s)${escape(word)}(?:\\s|$)`).test(text))) return actionClass;
  }
  return null;
}

export function classifyAction(input: {
  intentKind: string;
  controlName?: string | null;
  expect?: string | null;
}): RiskClass {
  // Only a click can be classified: type, key, scroll, wait, read_document and deliver_file have no destination the
  // code can read. An Enter key that submits a form is an honest limit, not a class.
  if (input.intentKind !== "click") return "none";
  return classOf(input.controlName) ?? classOf(input.expect) ?? "none";
}

export function classLabel(actionClass: RiskClass): string {
  return ACTION_CLASS_LABELS[actionClass];
}
