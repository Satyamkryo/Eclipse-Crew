// Which outbox files the owner may open in the agent's own browser. Anything else is download-only.
// The desktop enforces the same table (docker/desktop/outbox-reader.mjs); a test keeps them equal.
export const OPENABLE_EXTENSIONS = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"],
  pdf: [".pdf"],
  audio: [".mp3", ".wav", ".ogg", ".flac", ".m4a"],
  video: [".webm", ".ogv"],
  text: [".txt", ".md", ".csv", ".json", ".log"],
} as const;

export function canOpenOnDesktop(name: string, kind: string): boolean {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return Object.hasOwn(OPENABLE_EXTENSIONS, kind) && (OPENABLE_EXTENSIONS as Record<string, readonly string[]>)[kind].includes(extension);
}