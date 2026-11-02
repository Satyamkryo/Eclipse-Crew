const namedKeys = new Set([
  "Enter", "Tab", "Escape", "Space", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

const modifierNames = ["Control", "Alt", "Shift", "Meta"];

// Same rule the desktop controller applies to `input.key`: unique modifiers, then a named key,
// or a single letter/digit when at least one modifier is present.
export function isValidKeyChord(value: string): boolean {
  if (value.length < 1 || value.length > 64) return false;
  const parts = value.split("+");
  const key = parts.pop() as string;
  return new Set(parts).size === parts.length && parts.every((part) => modifierNames.includes(part)) &&
    (namedKeys.has(key) || (parts.length > 0 && /^[a-z0-9]$/i.test(key)));
}

type KeyModifiers = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altGraph: boolean;
};

export function getForwardedKeyChord({ key, ctrlKey, altKey, shiftKey, metaKey, altGraph }: KeyModifiers): string | null {
  if (altGraph) return null;

  const baseKey = key === " " ? "Space" : key;
  const named = namedKeys.has(baseKey);
  if (!named && !/^[a-z0-9]$/i.test(baseKey)) return null;
  if (!ctrlKey && !altKey && !metaKey && (!named || baseKey === "Space")) return null;

  return [
    ...(ctrlKey ? ["Control"] : []),
    ...(altKey ? ["Alt"] : []),
    ...(shiftKey ? ["Shift"] : []),
    ...(metaKey ? ["Meta"] : []),
    baseKey,
  ].join("+");
}
