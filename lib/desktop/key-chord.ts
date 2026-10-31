const namedKeys = new Set([
  "Enter", "Tab", "Escape", "Space", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

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
