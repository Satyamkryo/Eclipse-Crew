"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: fd.get("login"), password: fd.get("password") }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || "Login failed");
      if (data.retryAfter) setError(`Too many attempts. Try again in ${data.retryAfter}s`);
      setLoading(false);
      return;
    }
    router.push("/");
    router.refresh();
    } catch { setError("Unable to connect. Try again."); }
    finally { setLoading(false); }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="login" className="text-sm font-medium">Email</label>
        <input id="login" name="login" type="email" required autoComplete="email" className="h-8 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-sm font-medium">Password</label>
        <input id="password" name="password" type="password" required autoComplete="current-password" className="h-8 rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</Button>
    </form>
  );
}
