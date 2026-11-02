import { createHash } from "node:crypto";

// TASK-070. One canonical form shared by the app and the proxy (the proxy duplicates this function because it cannot
// import app code). The token is part of the hash but is never sent back; the version only tells the app whether the
// proxy already holds the current entry list.
export type CredentialScheme = "bearer" | "basic" | "header";

export type CredentialEntry = {
  host: string;
  scheme: CredentialScheme;
  header: string | null;
  username: string | null;
  token: string;
};

export function canonicalCredentials(entries: CredentialEntry[]): CredentialEntry[] {
  return [...entries]
    .map((entry) => ({
      host: entry.host.toLowerCase(),
      scheme: entry.scheme,
      header: entry.header ?? null,
      username: entry.username ?? null,
      token: entry.token,
    }))
    .sort((left, right) => left.host.localeCompare(right.host) || left.scheme.localeCompare(right.scheme));
}

export function credentialsVersion(entries: CredentialEntry[]): string {
  return createHash("sha256").update(JSON.stringify(canonicalCredentials(entries)), "utf8").digest("hex");
}
