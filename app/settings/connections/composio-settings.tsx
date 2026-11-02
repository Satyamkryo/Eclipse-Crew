"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";
import { COMPOSIO_TOOLKITS } from "@/lib/composio/schema";
import type { ComposioAccountView, ComposioDiscovery, ComposioKeyView } from "@/lib/composio/view";
import { cn } from "@/lib/utils";

type AgentOption = { id: string; name: string; status: "active" | "paused" };

const inputClass = "h-8 w-full rounded-md border border-input bg-surface px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

function errorMessage(code: string | undefined): string {
  if (code === "key_required") return "Paste a Composio API key first.";
  if (code === "key_rejected") return "Composio rejected the key or its permissions.";
  if (code === "composio_not_configured") return "Save a Composio key first.";
  if (code === "managed_auth_unavailable") return "This app isn't available through Composio's managed sign-in. It needs its own OAuth credentials, which v1 doesn't support.";
  if (code === "link_unsupported") return "This app's sign-in method doesn't work with link sign-in.";
  if (code === "link_timeout") return "Composio couldn't start the sign-in. Try again.";
  if (code === "composio_unreachable") return "Composio is unreachable. Try again shortly.";
  if (code === "composio_rate_limited" || code === "rate_limited") return "Composio is rate-limiting requests. Try again shortly.";
  if (code === "tools_changed") return "The tool list changed. Review and pin it again.";
  if (code === "already_connected") return "This agent already has an account for that app.";
  if (code === "composio_not_connected") return "This Composio account is disconnected. Connect the app again.";
  if (code === "invalid_input") return "Review the values and try again.";
  return "Composio couldn't complete the request. Try again.";
}

function statusLabel(status: ComposioAccountView["status"]) {
  switch (status) {
    case "active": return "Active";
    case "pending": return "Waiting for sign-in";
    case "failed": return "Link expired — connect again";
    case "changed": return "Tools changed — review";
    case "revoked": return "Disconnected";
  }
}

export function ComposioSettings({ initialKey, initialAccounts, agents, csrfToken }: {
  initialKey: ComposioKeyView;
  initialAccounts: ComposioAccountView[];
  agents: AgentOption[];
  csrfToken: string;
}) {
  const router = useRouter();
  const [keyView, setKeyView] = useState(initialKey);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [redirect, setRedirect] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<{ account: ComposioAccountView; data: ComposioDiscovery } | null>(null);
  const [removing, setRemoving] = useState<ComposioAccountView | null>(null);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [toolkit, setToolkit] = useState<string>(COMPOSIO_TOOLKITS[0].slug);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const grouped = useMemo(() => agents
    .map((agent) => ({ agent, rows: accounts.filter((account) => account.agentId === agent.id) }))
    .filter((group) => group.rows.length > 0), [agents, accounts]);

  function fail(message: string) {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  }

  async function handle(response: Response) {
    if (response.status === 401) { router.push("/login"); router.refresh(); return null; }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { fail(errorMessage(body.error)); return null; }
    return body;
  }

  async function saveKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const apiKey = String(new FormData(form).get("apiKey") ?? "");
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/composio/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(apiKey ? { apiKey } : {}),
      });
      const body = await handle(response);
      if (!body) return;
      setKeyView(body as ComposioKeyView);
      const input = form.querySelector("input[name=apiKey]");
      if (input instanceof HTMLInputElement) input.value = "";
      setStatus("Composio key saved.");
      router.refresh();
    } catch { fail("Unable to connect. Try again."); }
    finally { setBusy(false); }
  }

  async function toggleInjection() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/composio/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ injectionCheck: !keyView.injectionCheck }),
      });
      const body = await handle(response);
      if (!body) return;
      setKeyView(body as ComposioKeyView);
      setStatus((body as ComposioKeyView).injectionCheck ? "Composio prompt-injection check is on (billed by Composio)." : "Composio prompt-injection check is off.");
      router.refresh();
    } catch { fail("Unable to connect. Try again."); }
    finally { setBusy(false); }
  }

  async function removeKey() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/composio/key", { method: "DELETE", headers: { "x-csrf-token": csrfToken } });
      const body = await handle(response);
      if (!body) return;
      setKeyView(body as ComposioKeyView);
      setAccounts((current) => current.map((account) => ({ ...account, status: "revoked" })));
      setStatus("Composio key removed. Connected accounts are revoked here.");
      router.refresh();
    } catch { fail("Unable to connect. Try again."); }
    finally { setBusy(false); }
  }

  async function connect() {
    setBusy(true); setError(null); setRedirect(null);
    try {
      const response = await fetch("/api/composio/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ agentId, toolkit }),
      });
      const body = await handle(response);
      if (!body) return;
      setAccounts((current) => [...current.filter((row) => row.agentId !== agentId || row.toolkit !== toolkit), body.account as ComposioAccountView]);
      setRedirect(body.redirectUrl as string);
      setStatus("Open the Composio link, sign in with the account you want this agent to use, then press Check status.");
      router.refresh();
    } catch { fail("Unable to connect. Try again."); }
    finally { setBusy(false); }
  }

  async function refresh(account: ComposioAccountView) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/composio/accounts/${account.id}/refresh`, {
        method: "POST", headers: { "x-csrf-token": csrfToken },
      });
      const body = await handle(response);
      if (!body) return;
      const next = body.account as ComposioAccountView;
      setAccounts((current) => current.map((row) => row.id === next.id ? next : row));
      setStatus(`Status: ${statusLabel(next.status)}.`);
    } catch { fail("Unable to connect. Try again."); }
    finally { setBusy(false); }
  }

  async function review(account: ComposioAccountView) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/composio/accounts/${account.id}`, { headers: {} });
      const body = await handle(response);
      if (!body) return;
      setDiscovery({ account, data: body.discovery as ComposioDiscovery });
    } catch { fail("Unable to connect. Try again."); }
    finally { setBusy(false); }
  }

  async function pin() {
    if (!discovery) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/composio/accounts/${discovery.account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ expectedToolsHash: discovery.data.toolsHash }),
      });
      const body = await handle(response);
      if (!body) return;
      const next = body.account as ComposioAccountView;
      setAccounts((current) => current.map((row) => row.id === next.id ? next : row));
      setStatus(`Pinned ${next.toolCount} tools for ${next.toolkit}.`);
      setDiscovery(null);
      router.refresh();
    } catch { fail("Unable to connect. Try again."); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!removing) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/composio/accounts/${removing.id}`, {
        method: "DELETE", headers: { "x-csrf-token": csrfToken },
      });
      const body = await handle(response);
      if (!body) return;
      const next = body.account as ComposioAccountView;
      setAccounts((current) => current.map((row) => row.id === next.id ? next : row));
      if (body.revoked === false) {
        fail("Disconnected here, but Composio did not confirm remote revocation. Check Composio before relying on this account being disabled.");
      } else {
        setStatus("Disconnected. The agent can no longer use this app.");
      }
      setRemoving(null);
      router.refresh();
    } catch { fail("Unable to connect. Try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Composio (optional)</h2>
        <p className="mt-2 max-w-[70ch] text-sm text-muted-foreground">
          Apps you connect through Composio are stored by Composio, not on this computer. Eclipse Crew only keeps your
          Composio API key, encrypted. Arguments and results of these tools pass through Composio&apos;s servers. To keep
          tokens on your machine, use an MCP server instead.
        </p>
      </div>

      {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-sm text-danger">{error}</p>}
      {status && <p role="status" aria-live="polite" className="text-sm text-success">{status}</p>}

      <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="composio-key-heading">
        <h3 id="composio-key-heading" className="text-sm font-semibold">API key</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a Composio project key with only Session management and Session tool execution. The app cannot check the key&apos;s scope.
        </p>
        <form onSubmit={saveKey} className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <label htmlFor="composio-api-key" className="text-sm font-medium">Key</label>
            <input id="composio-api-key" name="apiKey" type="password" maxLength={4096} autoComplete="new-password"
              placeholder={keyView.keyHint ?? "Paste the Composio key"} className={cn(inputClass, "font-mono")} />
            <p className="text-xs text-muted-foreground">
              {keyView.keyHint ? `Saved key ${keyView.keyHint}. Leave blank to keep it.` : "Stored encrypted on this machine. There is no reveal button."}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={keyView.injectionCheck} disabled={!keyView.hasKey || busy} onChange={toggleInjection}
                className="mt-0.5 size-4 rounded border-input" />
              <span>
                Composio prompt-injection check
                <span className="mt-1 block text-xs text-muted-foreground">
                  Composio screens tool results before your agent reads them. Needs a paid Composio plan and is billed by Composio.
                </span>
              </span>
            </label>
            <div className="flex gap-2">
              {keyView.hasKey && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={removeKey}>Remove key</Button>}
              <Button type="submit" disabled={busy}>
                {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                Save key
              </Button>
            </div>
          </div>
        </form>
      </section>

      {keyView.hasKey && (
        <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="composio-accounts-heading">
          <h3 id="composio-accounts-heading" className="text-sm font-semibold">Connected apps</h3>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-2">
              <label htmlFor="composio-agent" className="text-xs font-medium">Agent</label>
              <select id="composio-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} className={inputClass}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="composio-toolkit" className="text-xs font-medium">App</label>
              <select id="composio-toolkit" value={toolkit} onChange={(event) => setToolkit(event.target.value)} className={inputClass}>
                {COMPOSIO_TOOLKITS.map((item) => <option key={item.slug} value={item.slug}>{item.label}</option>)}
              </select>
            </div>
            <Button type="button" size="sm" onClick={connect} disabled={busy || agents.length === 0}>
              {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Connect
            </Button>
          </div>
          {redirect && (
            <p className="mt-3 text-sm">
              <a href={redirect} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">Open Composio to sign in</a>
              <span className="ml-2 text-muted-foreground">Then press Check status.</span>
            </p>
          )}

          {grouped.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No connected apps yet.</p>
          ) : (
            <div className="mt-4 flex flex-col gap-6">
              {grouped.map(({ agent, rows }) => (
                <div key={agent.id}>
                  <p className="text-sm font-medium">{agent.name}</p>
                  <ul className="mt-2 divide-y divide-border border-t border-border">
                    {rows.map((account) => (
                      <li key={account.id} className="flex flex-col gap-2 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium">{COMPOSIO_TOOLKITS.find((item) => item.slug === account.toolkit)?.label ?? account.toolkit}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {statusLabel(account.status)}{account.status === "active" ? ` · ${account.toolCount} tools pinned` : ""}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => refresh(account)}>Check status</Button>
                            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => review(account)}>Review tools</Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => { setRemoving(account); setError(null); }}>Disconnect</Button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {discovery && (
        <ModalDialog title={`Review ${discovery.data.toolkit} tools`}
          description="Destructive tools are excluded. Pinning records this exact list; a change blocks calls until you review it."
          onClose={() => setDiscovery(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{discovery.data.tools.length} tools · <span className="font-mono text-xs">{discovery.data.toolsHash.slice(0, 12)}…</span></p>
            <ul className="max-h-72 overflow-y-auto border-y border-border" aria-label="Composio tools">
              {discovery.data.tools.map((tool) => (
                <li key={tool.slug} className="border-b border-border px-1 py-2 last:border-b-0">
                  <p className="break-all font-mono text-xs">{tool.slug}</p>
                  {tool.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setDiscovery(null)} disabled={busy}>Cancel</Button>
              <Button type="button" onClick={pin} disabled={busy}>
                {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
                Pin {discovery.data.tools.length} tools
              </Button>
            </div>
          </div>
        </ModalDialog>
      )}

      {removing && (
        <ModalDialog title={`Disconnect ${removing.toolkit}?`} description="The agent can no longer use this app. Composio is asked to revoke the account." onClose={() => setRemoving(null)}>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setRemoving(null)} disabled={busy}>Keep it</Button>
            <Button type="button" variant="destructive" onClick={disconnect} disabled={busy}>
              {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Disconnect
            </Button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}
