"use client";
import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

const tabs = [
  { id: "desktop", label: "Desktop" },
  { id: "settings", label: "Settings" },
  { id: "tools", label: "Tools" },
  { id: "routines", label: "Routines" },
  { id: "history", label: "History" },
  { id: "memory", label: "Memory" },
] as const;
type TabId = (typeof tabs)[number]["id"];
const emptyCopy: Record<Exclude<TabId, "desktop" | "settings">, string> = {
  tools: "No tools are connected yet.",
  routines: "No routines yet.",
  history: "No run history yet.",
  memory: "No memory entries yet.",
};

export function WorkspacePanel({ initialTab, desktop, settings, history, memory }: { initialTab?: TabId; desktop?: ReactNode; settings?: ReactNode; history?: ReactNode; memory?: ReactNode }) {
  const [active, setActive] = useState<TabId>(initialTab ?? "desktop");
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number, focus: boolean) => {
    setActive(tabs[index].id);
    if (focus) buttons.current[index]?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Workspace panel" className="grid h-12 shrink-0 grid-cols-6 items-center border-b border-border px-2">
        {tabs.map((tab, index) => (
          <button key={tab.id} ref={(element) => { buttons.current[index] = element; }} type="button"
            role="tab" id={`workspace-tab-${tab.id}`} aria-controls="workspace-panel-content"
            aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1}
            onClick={() => select(index, false)} onKeyDown={(event) => onKeyDown(event, index)}
            className={cn("h-12 min-w-0 border-b px-1 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
              active === tab.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="workspace-panel-content" aria-labelledby={`workspace-tab-${active}`} tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring">
        {active === "desktop" && (desktop ? <div className="p-4">{desktop}</div> :
          <Empty title="No desktop open" body="Select an active agent to use its desktop. A stopped desktop can be started from Settings; a paused agent must be resumed first." />)}
        {active === "settings" && (settings ? <div className="p-6">{settings}</div> : (
          <div className="flex flex-col gap-4 p-6">
            <div>
              <h3 className="text-lg font-semibold tracking-tight">Settings</h3>
              <p className="mt-1 text-sm text-muted-foreground">Select an agent to edit its persona, permissions and budget, or manage models and your owner account.</p>
            </div>
            <div className="flex flex-wrap gap-4">
              <Link href="/settings/models" className="text-sm underline underline-offset-4">Model settings</Link>
              <Link href="/settings/connections" className="text-sm underline underline-offset-4">Connections</Link>
              <Link href="/profile" className="text-sm underline underline-offset-4">Profile</Link>
            </div>
          </div>
        ))}
        {active === "history" && (history ?? <Empty title="History" body={emptyCopy.history} />)}
        {active === "memory" && (memory ?? <Empty title="Memory" body={emptyCopy.memory} />)}
        {active !== "desktop" && active !== "settings" && active !== "history" && active !== "memory" && <Empty title={tabs.find((tab) => tab.id === active)?.label ?? ""} body={emptyCopy[active]} />}
      </div>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
