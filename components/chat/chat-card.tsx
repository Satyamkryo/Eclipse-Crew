import Link from "next/link";
import { Archive, CalendarClock, CircleHelp, FileText, Gauge, Image as ImageIcon, Music, MessageSquare, Plug, ShieldQuestion, Sparkles, Video } from "lucide-react";
import type { ChatMessage } from "@/lib/chat/schema";
import { formatBytes } from "@/lib/chat/upload";
import { FileCardActions } from "@/components/chat/file-card-actions";
import { RoutineCardActions } from "@/components/chat/routine-card-actions";
import { SkillUpdateReview } from "@/components/heal/skill-update-review";
import { ApprovalActions } from "@/components/approvals/approval-actions";
import { ChangeActions } from "@/components/memory/change-actions";

const FILE_ICONS = { image: ImageIcon, pdf: FileText, document: FileText, text: FileText, audio: Music, video: Video, archive: Archive } as const;
const FILE_KIND_LABELS = { image: "Image", pdf: "PDF", document: "Document", text: "Text", audio: "Audio", video: "Video", archive: "Archive" } as const;

export function ChatCard({ message, agentId, csrfToken }: { message: ChatMessage; agentId?: string; csrfToken?: string }) {
  const card = message.card;
  const label = card.type === "file" ? (card.direction === "inbox" ? "Your file" : "Agent file")
    : card.type === "teach_paused" ? "Recording needs you"
    : card.type === "skill_update" ? "Skill update proposed"
    : card.type === "approval" ? "Approval needed"
    : card.type === "memory_change" ? "Memory change proposed"
    : card.type === "budget_warning" || card.type === "budget_paused" ? "Budget alert"
      : message.sourceTag === "user" ? "Your message" : "Agent message";
  const needsYou = card.type === "budget_warning" || card.type === "budget_paused" || card.type === "teach_paused" || card.type === "skill_update" || card.type === "approval" || card.type === "memory_change";
  return (
    <article aria-label={label} data-card-type={card.type}
      className={`rounded-lg border bg-card p-4 text-sm text-card-foreground ${needsYou ? "border-corona" : "border-border"}`}>
      {card.type === "message" && (
        <div className="flex gap-3">
          <MessageSquare aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 whitespace-pre-wrap break-words leading-6">{card.text}</p>
        </div>
      )}

      {card.type === "clarification" && (
        <>
          <CardTitle icon={CircleHelp} title="More information needed" />
          <p className="mt-3 whitespace-pre-wrap break-words leading-6">{card.question}</p>
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="Missing parameters">
            {card.missingParameters.map((parameter) => (
              <li key={parameter} className="rounded-md border border-border-strong px-2 py-1 text-xs text-muted-foreground">
                {parameter}
              </li>
            ))}
          </ul>
        </>
      )}

      {card.type === "tool_connection" && (
        <>
          <CardTitle icon={Plug} title={`Connect ${card.name}`} />
          <p className="mt-3 break-words leading-6 text-muted-foreground">{card.description}</p>
          <p className="mt-3 text-xs font-medium text-muted-foreground">Connection required</p>
          <p className="mt-2 text-sm">
            <Link href="/settings/connections" className="underline underline-offset-4">Open Connections</Link>
          </p>
        </>
      )}

      {card.type === "file" && (
        <>
          <CardTitle icon={FILE_ICONS[card.kind]} title={card.name} />
          <p className="mt-2 text-xs text-muted-foreground">
            {card.direction === "inbox" ? "Saved to the agent's inbox" : "From the agent's outbox"} · {FILE_KIND_LABELS[card.kind]} · <span className="tabular-nums">{formatBytes(card.size)}</span>
          </p>
          {card.direction === "outbox" && agentId && csrfToken && (
            <FileCardActions agentId={agentId} messageId={message.id} csrfToken={csrfToken} name={card.name} kind={card.kind} />
          )}
        </>
      )}

      {(card.type === "budget_warning" || card.type === "budget_paused") && (
        <BudgetAlert card={card} />
      )}

      {card.type === "teach_paused" && <>
        <CardTitle icon={Video} title="Recording paused for privacy" />
        <p className="mt-3 leading-6 text-muted-foreground">Needs you: check the managed browser. Recording and microphone intake are paused. Resume explicitly from the desktop controls after checking the page, or stop recording.</p>
      </>}

      {card.type === "routine" && (
        <>
          <CardTitle icon={CalendarClock} title={card.schedule} />
          <p className="mt-3 whitespace-pre-wrap break-words leading-6">{card.goal}</p>
          {card.steps.length > 0 ? (
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted-foreground">
              {card.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
            </ol>
          ) : <p className="mt-3 text-muted-foreground">Uses an approved skill.</p>}
          <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
            <div className="flex gap-2"><dt className="font-medium text-foreground">Timezone</dt><dd>{card.timezone}</dd></div>
            {card.resolvedNextRunAt && (
              <div className="flex gap-2"><dt className="font-medium text-foreground">Next run</dt><dd>{nextRunText(card.resolvedNextRunAt, card.timezone)}</dd></div>
            )}
            <div className="flex gap-2"><dt className="font-medium text-foreground">Budget</dt><dd className="tabular-nums">${(card.budgetCents / 100).toFixed(2)}</dd></div>
            <div className="flex gap-2"><dt className="font-medium text-foreground">Catch-up</dt><dd>{card.catchUp === "run_all" ? "Run all missed" : card.catchUp === "run_once" ? "Run once" : "Skip"}</dd></div>
          </dl>
          {card.tools.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2" aria-label="Routine tools">
              {card.tools.map((tool) => (
                <li key={tool} className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">{tool}</li>
              ))}
            </ul>
          )}
          {agentId && csrfToken && <RoutineCardActions agentId={agentId} messageId={message.id} csrfToken={csrfToken} />}
        </>
      )}

      {card.type === "approval" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle icon={ShieldQuestion} title="Approval needed" />
            <span className="rounded-md bg-corona/12 px-2 py-0.5 text-xs text-corona">Needs you</span>
          </div>
          {csrfToken
            ? <ApprovalActions approvalId={card.approvalId} csrfToken={csrfToken} />
            : <p className="mt-3 text-sm text-muted-foreground">Open this chat to allow or deny the action.</p>}
        </>
      )}

      {card.type === "memory_change" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle icon={Sparkles} title="Memory change proposed" />
            <span className="rounded-md bg-corona/12 px-2 py-0.5 text-xs text-corona">Needs you</span>
          </div>
          <p className="mt-3 break-words leading-6">{card.title}</p>
          {csrfToken
            ? <ChangeActions changeId={card.changeId} csrfToken={csrfToken} />
            : <p className="mt-3 text-sm text-muted-foreground">Open the Memory tab to review this request.</p>}
        </>
      )}

      {card.type === "skill_update" && (
        <>
          <CardTitle icon={Sparkles} title="Skill update proposed" />
          <p className="mt-3 leading-6">
            The page changed at step {card.failedStep}. I found a new path and verified it. Review the updated steps before they replace v{card.fromVersion}.
          </p>
          {csrfToken
            ? <SkillUpdateReview proposalId={card.proposalId} csrfToken={csrfToken} />
            : <p className="mt-3 text-sm text-muted-foreground">Open the saved replay in History to review this update.</p>}
        </>
      )}
    </article>
  );
}

function nextRunText(value: string, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function usd(microUsd: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 })
    .format(microUsd / 1_000_000);
}

function BudgetAlert({ card }: { card: Extract<ChatMessage["card"], { type: "budget_warning" | "budget_paused" }> }) {
  const period = card.period === "daily" ? "Daily" : "Monthly";
  const limitMicroUsd = card.limitCents * 10_000;
  const percent = limitMicroUsd > 0 ? Math.min(999, Math.round((card.spentMicroUsd / limitMicroUsd) * 100)) : 100;
  const paused = card.type === "budget_paused";
  return (
    <>
      <CardTitle icon={Gauge} title={paused ? "Budget paused" : "Budget warning"} />
      <p className="mt-3 leading-6">
        {period} spend is {usd(card.spentMicroUsd)} of {usd(limitMicroUsd)} ({percent}%).
      </p>
      <p className="mt-2 leading-6 text-muted-foreground">
        {paused
          ? "The agent is paused. Raise this budget in Agent settings or wait for the next period, then resume it."
          : "I will continue until the budget reaches 100%, then pause before another model call."}
      </p>
    </>
  );
}

function CardTitle({ icon: Icon, title }: { icon: typeof MessageSquare; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <h3 className="min-w-0 break-words font-semibold tracking-tight">{title}</h3>
    </div>
  );
}
