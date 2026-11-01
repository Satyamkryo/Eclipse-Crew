import { CalendarClock, CircleHelp, MessageSquare, Plug } from "lucide-react";
import type { ChatMessage } from "@/lib/chat/schema";

export function ChatCard({ message }: { message: ChatMessage }) {
  const card = message.card;
  const label = message.sourceTag === "user" ? "Your message" : "Agent message";
  return (
    <article aria-label={label} data-card-type={card.type}
      className="rounded-lg border border-border bg-card p-4 text-sm text-card-foreground">
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
        </>
      )}

      {card.type === "routine" && (
        <>
          <CardTitle icon={CalendarClock} title={card.schedule} />
          <p className="mt-3 whitespace-pre-wrap break-words leading-6">{card.goal}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-muted-foreground">
            {card.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
          </ol>
          <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
            <div className="flex gap-2"><dt className="font-medium text-foreground">Timezone</dt><dd>{card.timezone}</dd></div>
            <div className="flex gap-2"><dt className="font-medium text-foreground">Budget</dt><dd className="tabular-nums">${(card.budgetCents / 100).toFixed(2)}</dd></div>
            <div className="flex gap-2"><dt className="font-medium text-foreground">Catch-up</dt><dd>{card.catchUp === "run_once" ? "Run once" : "Skip"}</dd></div>
          </dl>
          {card.tools.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2" aria-label="Routine tools">
              {card.tools.map((tool) => (
                <li key={tool} className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">{tool}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
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
