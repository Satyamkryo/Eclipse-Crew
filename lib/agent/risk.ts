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

// What a control's own name can say. Ordered by how much damage a mistake can do; the first matching class wins.
const KEYWORDS: ReadonlyArray<[ActionClass, readonly string[]]> = [
  ["purchase", ["buy", "purchase", "pay", "payment", "checkout", "check out", "place order", "place your order", "order now", "donate", "subscribe", "transfer"]],
  ["delete", ["delete", "remove", "erase", "discard", "unsubscribe"]],
  ["send", ["send", "share", "invite", "forward", "reply", "email"]],
  ["post", ["post", "publish", "comment"]],
  ["submit", ["submit", "confirm", "approve", "accept", "sign", "apply"]],
  ["download", ["download", "export", "save as", "save", "saved"]],
];

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// What an expected result can say. Only words for the finished act count here: an `expect` describes the page, so its nouns
// ("the email inbox opens", "the blog post is shown", "the payment page loads") are not an act, and treating them as one
// sent ordinary navigation to the owner for approval. A click's own name keeps the full list above.
const RESULT_KEYWORDS: ReadonlyArray<[ActionClass, readonly string[]]> = [
  ["purchase", ["purchased", "bought", "paid", "payment complete", "payment completed", "payment confirmed", "payment successful", "order placed", "order confirmed", "donated", "subscribed", "transferred"]],
  ["delete", ["deleted", "removed", "erased", "discarded", "unsubscribed"]],
  ["send", ["sent", "shared", "invited", "forwarded", "replied", "send", "reply"]],
  ["post", ["posted", "published", "commented", "publish"]],
  ["submit", ["submitted", "confirmed", "approved", "accepted", "signed", "applied", "submit", "submission"]],
  ["download", ["downloaded", "exported", "saved", "download"]],
];

function match(value: unknown, table: ReadonlyArray<[ActionClass, readonly string[]]>): ActionClass | null {
  if (typeof value !== "string") return null;
  const text = value.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  for (const [actionClass, words] of table) {
    // Whole words, with punctuation as a boundary: "Delete..." and "Send!" must classify like "Delete" and "Send".
    if (words.some((word) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, "u").test(text))) return actionClass;
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
  return match(input.controlName, KEYWORDS) ?? match(input.expect, RESULT_KEYWORDS) ?? "none";
}

// The classes a mistake cannot be taken back from: these need two agreeing methods (ADR-008). Submit and download still
// wait for the owner's approval, but cover everyday controls such as "Sign in" and "Apply filter".
export function isIrreversible(risk: RiskClass): boolean {
  return risk === "purchase" || risk === "delete" || risk === "send" || risk === "post";
}

export function classLabel(actionClass: RiskClass): string {
  return ACTION_CLASS_LABELS[actionClass];
}
