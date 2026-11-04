"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, LoaderCircle, MessageSquare, Paperclip, RefreshCw, SendHorizontal, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChatCard } from "@/components/chat/chat-card";
import { LiveRunCard } from "@/components/chat/live-run-card";
import { AgentAvatar, BoldPopAvatar } from "@/components/workspace/agent-avatar";
import { AstraBadge } from "@/components/ui/astra-badge";
import {
  chatHistoryResponseSchema,
  chatMessageResponseSchema,
  outboxRefreshResponseSchema,
  type ChatMessage,
} from "@/lib/chat/schema";
import { ATTACHMENT_ACCEPT, formatBytes, precheckFile, uploadErrorMessage, uploadFile, UploadError } from "@/lib/chat/upload";

type Upload = { key: string; file: File; loaded: number; state: "queued" | "uploading" | "error"; error?: string };
const MAX_FILES_AT_ONCE = 10;
type ChatAgent = { id: string; name: string; status: "active" | "paused"; astraMode: boolean; avatarVariant: number; ownerEmail?: string };
type LoadState = "idle" | "loading" | "ready" | "error";

export function ChatPane({ agent, csrfToken, maxUploadBytes, ownerEmail }: { agent?: ChatAgent; csrfToken: string; maxUploadBytes?: number; ownerEmail?: string }) {
  const router = useRouter();
  const timeline = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const loadingEarlier = useRef(false);
  const previousLength = useRef(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadState, setLoadState] = useState<LoadState>(agent ? "loading" : "idle");
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = useRef<{ key: string; cancel: () => void } | null>(null);
  const active = agent?.status === "active";
  const agentId = agent?.id;
  const lastId = messages.at(-1)?.id;

  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/agents/${agentId}/messages`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.status === 401) {
          router.push("/login");
          router.refresh();
          return;
        }
        const body = await response.json().catch(() => null);
        const parsed = chatHistoryResponseSchema.safeParse(body);
        if (!response.ok) throw new Error("Couldn't load this conversation.");
        if (!parsed.success) throw new Error("Chat returned an invalid response.");
        setMessages(parsed.data.messages);
        setHasMore(parsed.data.hasMore);
        setLoadState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error && error.message.length < 120
          ? error.message : "Couldn't load this conversation.");
        setLoadState("error");
      }
    })();
    return () => controller.abort();
  }, [agentId, reloadKey, router]);

  useEffect(() => {
    if (!agentId || loadState !== "ready") return;
    const controller = new AbortController();
    let polling = false;
    // Files the agent wrote to outbox/ get a card. Failures here stay quiet: the message poll below reports its own.
    const refreshOutbox = async () => {
      try {
        const response = await fetch(`/api/agents/${agentId}/outbox/refresh`, {
          method: "POST", headers: { "x-csrf-token": csrfToken }, signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) return;
        const parsed = outboxRefreshResponseSchema.safeParse(await response.json().catch(() => null));
        if (parsed.success && parsed.data.messages.length > 0) setMessages((current) => mergeMessages(current, parsed.data.messages));
      } catch { /* retried on the next poll */ }
    };
    void refreshOutbox();
    const poll = async () => {
      if (polling || document.visibilityState !== "visible") return;
      polling = true;
      void refreshOutbox();
      try {
        const query = lastId ? `?after=${encodeURIComponent(lastId)}` : "";
        const response = await fetch(`/api/agents/${agentId}/messages${query}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.status === 401) {
          router.push("/login");
          router.refresh();
          return;
        }
        const body = await response.json().catch(() => null);
        const parsed = chatHistoryResponseSchema.safeParse(body);
        if (!response.ok || !parsed.success) {
          setRefreshError("Couldn't refresh this conversation. Retrying.");
          return;
        }
        setRefreshError(null);
        if (parsed.data.messages.length > 0) {
          setMessages((current) => mergeMessages(current, parsed.data.messages));
        }
      } catch {
        if (!controller.signal.aborted) setRefreshError("Couldn't refresh this conversation. Retrying.");
      } finally {
        polling = false;
      }
    };
    const interval = window.setInterval(() => { void poll(); }, 5000);
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [agentId, csrfToken, lastId, loadState, router]);

  useEffect(() => {
    if (messages.length === 0) {
      previousLength.current = 0;
      return;
    }
    if (loadingEarlier.current) {
      loadingEarlier.current = false;
      previousLength.current = messages.length;
      return;
    }
    const nextLength = messages.length;
    if (nextLength > previousLength.current) {
      requestAnimationFrame(() => {
        const element = timeline.current;
        if (element) element.scrollTop = element.scrollHeight;
      });
    }
    previousLength.current = nextLength;
  }, [messages]);

  useEffect(() => {
    if (sendError) errorRef.current?.focus();
  }, [sendError]);

  useEffect(() => () => { running.current?.cancel(); }, []);

  // Files go up one at a time; each is a raw request so the progress bar is real.
  useEffect(() => {
    if (!agentId || running.current) return;
    const next = uploads.find((upload) => upload.state === "queued");
    if (!next) return;
    const update = (patch: Partial<Upload>) => setUploads((list) => list.map((upload) => upload.key === next.key ? { ...upload, ...patch } : upload));
    const handle = uploadFile(agentId, csrfToken, next.file, (loaded) => update({ loaded }));
    running.current = { key: next.key, cancel: handle.cancel };
    update({ state: "uploading" });
    handle.promise.then((message) => {
      setMessages((current) => mergeMessages(current, [message]));
      setUploads((list) => list.filter((upload) => upload.key !== next.key));
    }, (error: unknown) => {
      const code = error instanceof UploadError ? error.code : "failed";
      if (error instanceof UploadError && error.status === 401) { router.push("/login"); router.refresh(); return; }
      if (code === "cancelled") { setUploads((list) => list.filter((upload) => upload.key !== next.key)); return; }
      update({ state: "error", error: uploadErrorMessage(code, maxUploadBytes) });
    }).finally(() => { running.current = null; setUploads((list) => [...list]); });
  }, [uploads, agentId, csrfToken, maxUploadBytes, router]);

  function addFiles(list: FileList | File[] | null, skippedFolders = 0) {
    const files = Array.from(list ?? []);
    if (files.length === 0 && skippedFolders === 0) return;
    if (!agent || !active) { setSendError("Resume this agent to attach files."); return; }
    setSendError(null);
    setNotice(skippedFolders > 0 ? "Folders can't be attached. Attach the files inside instead." : null);
    const added: Upload[] = [];
    const rejected: string[] = [];
    for (const file of files.slice(0, MAX_FILES_AT_ONCE)) {
      const problem = precheckFile(file, maxUploadBytes);
      if (problem) rejected.push(`${file.name}: ${uploadErrorMessage(problem.code, maxUploadBytes)}`);
      else added.push({ key: crypto.randomUUID(), file, loaded: 0, state: "queued" });
    }
    // Oversized or unsupported files never start uploading; the owner gets one clear warning instead.
    if (rejected.length > 0) setSendError(rejected.length === 1 ? `Not attached. ${rejected[0]}` : `${rejected.length} files not attached. ${rejected.join(" ")}`);
    if (files.length > MAX_FILES_AT_ONCE) setNotice(`Only the first ${MAX_FILES_AT_ONCE} files were added.`);
    if (added.length > 0) setUploads((current) => [...current, ...added]);
  }

  function cancelUpload(key: string) {
    if (running.current?.key === key) running.current.cancel();
    else setUploads((list) => list.filter((upload) => upload.key !== key));
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    const items = Array.from(event.dataTransfer.items ?? []).filter((item) => item.kind === "file");
    const folders = items.filter((item) => item.webkitGetAsEntry?.()?.isDirectory).length;
    const files = folders > 0 ? Array.from(event.dataTransfer.files).filter((_, index) => !items[index]?.webkitGetAsEntry?.()?.isDirectory) : event.dataTransfer.files;
    addFiles(files, folders);
  }

  async function loadEarlier() {
    if (!agent || !messages[0] || loadingEarlier.current) return;
    loadingEarlier.current = true;
    setRefreshError(null);
    try {
      const response = await fetch(`/api/agents/${agent.id}/messages?before=${encodeURIComponent(messages[0].id)}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => null);
      const parsed = chatHistoryResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error();
      setMessages((current) => mergeMessages(parsed.data.messages, current));
      setHasMore(parsed.data.hasMore);
    } catch {
      loadingEarlier.current = false;
      setRefreshError("Couldn't load earlier messages. Try again.");
    }
  }

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!agent || !active || !value || sending) return;
    setSending(true);
    setSendError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/agents/${agent.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ text: value }),
      });
      if (response.status === 401) {
        router.push("/login");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => null);
      const parsed = chatMessageResponseSchema.safeParse(body);
      if (!response.ok) throw new Error(sendErrorMessage(body));
      if (!parsed.success) throw new Error("Chat returned an invalid response.");
      setMessages((current) => mergeMessages(current, [parsed.data.message]));
      setText("");
      setNotice(parsed.data.message.sourceTag === "system" && parsed.data.message.card.type === "message"
        ? parsed.data.message.card.text : "Message saved.");
    } catch (error) {
      setSendError(error instanceof Error && error.message.length < 160
        ? error.message : "Couldn't save your message. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col"
      onDragEnter={(event) => { if (agent && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragOver={(event) => { if (agent && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={onDrop}>
      {dragging && agent && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 border border-border-strong bg-background/80 text-sm font-medium">
          <Paperclip className="size-4" />
          {active ? `Drop files to attach to ${agent.name}` : "Resume this agent to attach files"}
        </div>
      )}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-6 md:hidden">
        {agent && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{agent.name}</span>
            {agent.astraMode && <AstraBadge />}
          </span>
        )}
      </div>

      {!agent ? (
        <EmptyState message="Select an active agent to open its conversation." />
      ) : loadState === "loading" ? (
        <LoadingState />
      ) : loadState === "error" ? (
        <div role="alert" className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
          <div className="flex max-w-[720px] flex-col items-center gap-3 text-center">
            <RefreshCw aria-hidden="true" className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">{loadError}</p>
            <Button type="button" variant="secondary" onClick={() => {
              setLoadError(null);
              setLoadState("loading");
              setReloadKey((value) => value + 1);
            }}>Try again</Button>
          </div>
        </div>
      ) : (
        <div ref={timeline} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6" aria-live="polite">
          <div className="flex flex-col gap-6">
            {hasMore && (
              <Button type="button" variant="secondary" size="sm" className="self-center" onClick={loadEarlier}>
                Load earlier messages
              </Button>
            )}
            {messages.length === 0 ? (
              <EmptyState message={active
                ? "No conversation yet. Send a message to this agent."
                : "No conversation yet."} inset />
            ) : messages.map((message) => (
              <MessageRow key={message.id} message={message} agentName={agent.name} agentId={agent.id} agentAvatarVariant={agent.avatarVariant} ownerEmail={ownerEmail}>
                <ChatCard message={message} agentId={agent?.id} csrfToken={csrfToken} />
              </MessageRow>
            ))}
            {agent ? <LiveRunCard agentId={agent.id} csrfToken={csrfToken} active={active} /> : null}
            <div aria-hidden="true" />
          </div>
        </div>
      )}

      {refreshError && <p role="status" className="shrink-0 border-t border-border px-6 py-2 text-xs text-muted-foreground">{refreshError}</p>}

      {agent && (
        <form onSubmit={send} className="shrink-0 border-t border-border p-4">
          <div className="mx-auto flex max-w-[720px] flex-col gap-2">
            {uploads.length > 0 && (
              <ul aria-label="Attachments" className="flex flex-col gap-2">
                {uploads.map((upload) => <UploadRow key={upload.key} upload={upload} onCancel={() => cancelUpload(upload.key)} />)}
              </ul>
            )}
            <input ref={fileInput} id="chat-attachments" type="file" multiple hidden aria-label="Attach files" accept={ATTACHMENT_ACCEPT}
              onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
            <div className="flex items-end gap-1 rounded-xl border border-border bg-surface px-1.5 py-1.5">
              <Button type="button" variant="ghost" aria-label="Attach files" disabled={!active}
                title={`Attach documents, images, audio, video or text${maxUploadBytes ? ` (up to ${formatBytes(maxUploadBytes)} each)` : ""}`}
                className="shrink-0" onClick={() => fileInput.current?.click()}>
                <Paperclip aria-hidden="true" className="size-4" />
              </Button>
              <label htmlFor="chat-message" className="sr-only">Message</label>
              <textarea id="chat-message" value={text} disabled={!active || sending} rows={1}
                maxLength={20_000} placeholder={active ? `Message ${agent.name}…` : undefined}
                aria-describedby={!active || sendError || notice ? "chat-message-hint" : undefined}
                onChange={(event) => { setText(event.target.value); if (sendError) setSendError(null); }}
                onPaste={(event) => {
                  if ((event.clipboardData?.files.length ?? 0) > 0) { event.preventDefault(); addFiles(event.clipboardData.files); }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                className="max-h-40 min-h-8 min-w-0 flex-1 resize-none self-center bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-text-subtle disabled:opacity-50" />
              <Button type="submit" variant="ghost" size="sm" aria-label="Send message" title="Send message"
                disabled={!active || sending || text.trim().length === 0} className="shrink-0">
                {sending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <SendHorizontal aria-hidden="true" className="size-4" />}
              </Button>
            </div>
            {!active && <p id="chat-message-hint" className="text-xs text-muted-foreground">Resume this agent to send a message.</p>}
            {sendError && <p ref={errorRef} id="chat-message-hint" role="alert" tabIndex={-1} className="text-sm text-danger">{sendError}</p>}
            {notice && <p id="chat-message-hint" role="status" className="text-xs text-muted-foreground">{notice}</p>}
          </div>
        </form>
      )}
    </div>
  );
}

// Reference sheet 36 "Chat message": ordinary messages are unboxed rows — avatar, name and
// time on one line, then the content. Action content (file, routine, approval, …) stays a card.
function MessageRow({ message, agentName, agentId, agentAvatarVariant, ownerEmail, children }: { message: ChatMessage; agentName: string; agentId?: string; agentAvatarVariant?: number; ownerEmail?: string; children: React.ReactNode }) {
  const isOwner = message.sourceTag === "user";
  const forwarded = message.card.type === "message" && message.card.fromAgent ? message.card.fromAgent : null;
  const name = isOwner ? "You" : forwarded ? `${forwarded} (agent)` : agentName;
  // Orbit/Atlas layout: agent on the left (avatar + unboxed row), owner on the right (bubble).
  if (isOwner) {
    return (
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
        <div className="flex justify-end gap-2">
          <div className="min-w-0 max-w-[75ch] text-right">
            <p className="flex min-h-8 flex-wrap items-center justify-end gap-x-2">
              <time dateTime={message.createdAt} className="text-xs text-text-subtle">{formatTime(message.createdAt)}</time>
              <span className="text-sm font-semibold">{name}</span>
            </p>
            <div>{children}</div>
          </div>
          <span className="shrink-0"><BoldPopAvatar seed={ownerEmail ?? "owner"} size={32} label="You" /></span>
        </div>
      </div>
    );
  }
  return (
    <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
      <div className="flex gap-2">
        <span className="shrink-0"><AgentAvatar seed={agentId ?? agentName} variant={agentAvatarVariant} size={32} /></span>
        <div className="min-w-0 max-w-[75ch] flex-1">
          <p className="flex min-h-8 flex-wrap items-center gap-x-2">
            <span className="text-sm font-semibold">{name}</span>
            <time dateTime={message.createdAt} className="text-xs text-text-subtle">{formatTime(message.createdAt)}</time>
            {message.runId && <span className="text-xs text-muted-foreground">Background result</span>}
          </p>
          <div>{children}</div>
        </div>
      </div>
    </div>
  );
}

function UploadRow({ upload, onCancel }: { upload: Upload; onCancel: () => void }) {
  const percent = Math.min(100, Math.floor((upload.loaded / upload.file.size) * 100));
  const saving = upload.state === "uploading" && upload.loaded >= upload.file.size;
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{upload.file.name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(upload.file.size)}</span>
        <Button type="button" variant="ghost" size="sm" className="shrink-0 px-2" onClick={onCancel}
          aria-label={upload.state === "error" ? `Dismiss ${upload.file.name}` : `Cancel upload of ${upload.file.name}`}
          title={upload.state === "error" ? "Dismiss" : "Cancel upload"}>
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      {upload.state === "queued" && <p className="text-muted-foreground">Waiting</p>}
      {upload.state === "uploading" && (
        <div className="flex items-center gap-2">
          <div role="progressbar" aria-label={`Uploading ${upload.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <span className="shrink-0 tabular-nums text-muted-foreground">{saving ? "Saving" : `${percent}%`}</span>
        </div>
      )}
      {upload.state === "error" && <p role="alert" className="text-danger">{upload.error}</p>}
    </li>
  );
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    const time = left.createdAt.localeCompare(right.createdAt);
    return time === 0 ? left.id.localeCompare(right.id) : time;
  });
}

function sendErrorMessage(body: unknown) {
  const code = typeof body === "object" && body !== null && "error" in body ? String(body.error) : "";
  if (code === "agent_paused") return "This agent is paused. Resume it from Settings, then try again.";
  if (code === "agent_not_found") return "This agent is unavailable or does not belong to your account.";
  if (code === "mention_not_found") return "No agent has that name. Check the spelling and try again.";
  if (code === "teammate_unavailable") return "That teammate is paused or busy, so nothing was sent.";
  if (code === "invalid_input") return "Enter a message and try again.";
  return "Couldn't save your message. Try again.";
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function LoadingState() {
  return (
    <div role="status" className="min-h-0 flex-1 overflow-y-auto p-6">
      <span className="sr-only">Loading chat history</span>
      <div className="mx-auto flex max-w-[720px] animate-pulse flex-col gap-3">
        <div className="h-20 rounded-lg border border-border bg-surface" />
        <div className="h-28 rounded-lg border border-border bg-surface" />
      </div>
    </div>
  );
}

function EmptyState({ message, inset = false }: { message: string; inset?: boolean }) {
  return (
    <div className={`flex items-center justify-center overflow-y-auto p-6 ${inset ? "py-10" : "min-h-0 flex-1"}`}>
      <div className="flex max-w-[720px] flex-col items-center gap-2 text-center">
        <MessageSquare aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">{message}</p>
      </div>
    </div>
  );
}
