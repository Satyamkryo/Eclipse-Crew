import Link from "next/link";
import { redirect } from "next/navigation";

import { getDatabase } from "@/db/client";
import { validateSession } from "@/lib/auth/session";
import { createModelSettingsStore } from "@/lib/models/data";
import { readModelSettings } from "@/lib/models/service";
import { ModelSettings } from "./model-settings";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const session = await validateSession();
  if (!session) redirect("/login");
  let settings;
  try {
    const store = createModelSettingsStore(await getDatabase());
    settings = await readModelSettings(store, session.ownerId);
  } catch {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-16">
        <Link href="/" className="text-sm underline underline-offset-4">Back to workspace</Link>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p role="alert" className="text-sm text-danger">
          Model settings are temporarily unavailable. <Link href="/settings/models" className="underline underline-offset-4">Try again</Link>.
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6 sm:py-16">
      <Link href="/" className="text-sm underline underline-offset-4">Back to workspace</Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          Choose the model Eclipse Crew uses for thinking and optional vision precision. Keys are encrypted on this machine and never sent to a model.
        </p>
      </header>
      <ModelSettings initial={settings} csrfToken={session.csrfToken} />
    </main>
  );
}
