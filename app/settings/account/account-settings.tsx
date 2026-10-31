"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SessionSummary = { id: string; created: string; expires: string; current: boolean };
type Props = { login: string; sessions: SessionSummary[]; csrfToken: string };
const inputClass = "h-8 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function errorMessage(data: { error?: string; retryAfter?: number }, fallback: string) {
  if (data.error === "current_password_incorrect") return "Current password is incorrect.";
  if (data.retryAfter) return `Too many attempts. Try again in ${data.retryAfter}s.`;
  return fallback;
}

export function AccountSettings({ login, sessions, csrfToken }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState(login);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signOutStatus, setSignOutStatus] = useState<string | null>(null);
  const [signOutLoading, setSignOutLoading] = useState(false);
  const otherSessions = sessions.filter((session) => !session.current).length;

  async function changeEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setEmailLoading(true);
    setEmailError(null);
    setEmailStatus(null);
    const data = new FormData(form);
    try {
      const response = await fetch("/api/auth/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ login: data.get("login"), currentPassword: data.get("currentPassword") }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setEmailError(errorMessage(result, "Couldn't change your email. Try again."));
        if (result.error === "current_password_incorrect") document.getElementById("email-current-password")?.focus();
        return;
      }
      form.reset();
      setEmail(result.login ?? String(data.get("login") ?? login).toLowerCase());
      setEmailStatus("Email updated.");
      router.refresh();
    } catch {
      setEmailError("Unable to connect. Try again.");
    } finally {
      setEmailLoading(false);
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setPasswordLoading(true);
    setPasswordError(null);
    setPasswordStatus(null);
    const data = new FormData(form);
    try {
      const response = await fetch("/api/auth/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPasswordError(errorMessage(result, "Couldn't change your password. Try again."));
        if (result.error === "current_password_incorrect") document.getElementById("password-current-password")?.focus();
        return;
      }
      form.reset();
      setPasswordStatus("Password updated. Other sessions were signed out.");
      router.refresh();
    } catch {
      setPasswordError("Unable to connect. Try again.");
    } finally {
      setPasswordLoading(false);
    }
  }

  async function signOutEverywhere() {
    const label = otherSessions === 1 ? "other browser session" : `other browser sessions (${otherSessions})`;
    if (!window.confirm(`Sign out ${label}? This cannot be undone.`)) return;
    setSignOutLoading(true);
    setSignOutError(null);
    setSignOutStatus(null);
    try {
      const response = await fetch("/api/auth/sessions/revoke-others", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: "{}",
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSignOutError(errorMessage(result, "Couldn't sign out other sessions. Try again."));
        return;
      }
      setSignOutStatus("Other sessions signed out.");
      router.refresh();
    } catch {
      setSignOutError("Unable to connect. Try again.");
    } finally {
      setSignOutLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">Change email</h2>
        <p className="mt-1 text-sm text-muted-foreground">Your email is only your login identifier. No verification email is sent.</p>
        <form onSubmit={changeEmail} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="email-login" className="text-sm font-medium">New email</label>
            <input id="email-login" name="login" type="email" required maxLength={255} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)}
              aria-describedby={emailError ? "email-error" : undefined} aria-invalid={emailError ? true : undefined}
              className={cn(inputClass, emailError && "border-danger")} />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="email-current-password" className="text-sm font-medium">Current password</label>
            <input id="email-current-password" name="currentPassword" type="password" required maxLength={128} autoComplete="current-password"
              aria-describedby={emailError ? "email-error" : undefined} aria-invalid={emailError ? true : undefined}
              className={cn(inputClass, emailError && "border-danger")} />
          </div>
          {emailError && <p id="email-error" role="alert" className="text-sm text-danger">{emailError}</p>}
          {emailStatus && <p role="status" className="text-sm text-success">{emailStatus}</p>}
          <div><Button type="submit" disabled={emailLoading}>{emailLoading && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}Change email</Button></div>
        </form>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">Change password</h2>
        <p className="mt-1 text-sm text-muted-foreground">Changing your password signs out every other session.</p>
        <form onSubmit={changePassword} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="password-current-password" className="text-sm font-medium">Current password</label>
            <input id="password-current-password" name="currentPassword" type="password" required maxLength={128} autoComplete="current-password"
              aria-describedby={passwordError ? "password-error" : undefined} aria-invalid={passwordError ? true : undefined}
              className={cn(inputClass, passwordError && "border-danger")} />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="password-new-password" className="text-sm font-medium">New password</label>
            <input id="password-new-password" name="newPassword" type="password" required minLength={8} maxLength={128} autoComplete="new-password"
              aria-describedby={passwordError ? "password-hint password-error" : "password-hint"} aria-invalid={passwordError ? true : undefined}
              className={cn(inputClass, passwordError && "border-danger")} />
            <p id="password-hint" className="text-xs text-muted-foreground">Use 8–128 characters.</p>
          </div>
          {passwordError && <p id="password-error" role="alert" className="text-sm text-danger">{passwordError}</p>}
          {passwordStatus && <p role="status" className="text-sm text-success">{passwordStatus}</p>}
          <div><Button type="submit" disabled={passwordLoading}>{passwordLoading && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}Change password</Button></div>
        </form>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">Active sessions</h2>
        <p className="mt-1 text-sm text-muted-foreground">Sessions are stored on this Eclipse Crew install and can be revoked here.</p>
        {sessions.length ? (
          <ul aria-label="Active sessions" className="mt-4 divide-y divide-border border-y border-border">
            {sessions.map((session) => (
              <li key={session.id} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="flex items-center gap-2">
                  <span>Created {session.created}</span>
                  {session.current && <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium">Current session</span>}
                </span>
                <span className="text-muted-foreground">Expires {session.expires}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-4 text-sm text-muted-foreground">No active sessions.</p>}
        {signOutError && <p role="alert" className="mt-4 text-sm text-danger">{signOutError}</p>}
        {signOutStatus && <p role="status" className="mt-4 text-sm text-success">{signOutStatus}</p>}
        <div className="mt-4">
          <Button type="button" variant="destructive" disabled={signOutLoading || otherSessions === 0} onClick={signOutEverywhere}>
            {signOutLoading && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}Sign out everywhere
          </Button>
          {otherSessions === 0 && <p className="mt-2 text-xs text-muted-foreground">No other sessions are active.</p>}
        </div>
      </section>
    </div>
  );
}
