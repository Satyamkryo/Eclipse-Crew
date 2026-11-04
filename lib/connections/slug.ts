// TASK-088. The GitHub App slug is public and only shapes the install link. Kept free of server-only imports so the
// settings page can render the link before a sign-in starts.
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const FALLBACK = "eclipse-crew";

export function githubAppSlug(value: string | undefined = process.env.GITHUB_APP_SLUG): string {
  const slug = (value ?? FALLBACK).trim();
  return APP_SLUG.test(slug) ? slug : FALLBACK;
}

export function githubInstallUrl(value?: string): string {
  return `https://github.com/apps/${githubAppSlug(value)}/installations/new`;
}
