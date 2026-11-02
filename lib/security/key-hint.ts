import "server-only";

// Masked hints are the only form of a saved secret that may leave the server.
export function keyHint(secret: string): string {
  const characters = Array.from(secret);
  return `••••${characters.length > 4 ? characters.slice(-4).join("") : ""}`;
}
