"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Menu, MessageSquare, Monitor, UsersRound, X } from "lucide-react";
import { AppNavList } from "@/components/workspace/app-navigation";
import { cn } from "@/lib/utils";

export type MobileDockView = "agents" | "chat" | "panel";

const CELLS = [
  { id: "agents", label: "Agents", Icon: UsersRound },
  { id: "chat", label: "Chat", Icon: MessageSquare },
  { id: "panel", label: "Panel", Icon: Monitor },
] as const;

function cellClass(active: boolean) {
  return cn(
    "flex flex-col items-center justify-center gap-1 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
  );
}

// Shared phone bottom dock (docs/DESIGN.md "< 768 px"): Agents, Chat, Panel plus a
// burger Menu that opens side-panel pages in a bottom sheet (Agents lives on the
// dock and Profile on the header chip, so the sheet excludes both). The workspace
// wires the three cells to its view state; every other page renders the identical
// dock as links back into the workspace (`/?view=…`) so the menu is reachable
// from anywhere.
export function MobileDock({ active, onSelect, links }: {
  active: MobileDockView | null;
  onSelect?: (view: MobileDockView) => void;
  links?: Record<MobileDockView, string>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuWasOpen = useRef(false);

  useEffect(() => {
    if (menuWasOpen.current && !menuOpen) menuButtonRef.current?.focus();
    menuWasOpen.current = menuOpen;
  }, [menuOpen]);

  return (
    <>
      <nav aria-label="Workspace panes" className="grid h-14 shrink-0 grid-cols-4 border-t border-border bg-card">
        {CELLS.map(({ id, label, Icon }) => (
          onSelect ? (
            <button key={id} type="button" aria-pressed={active === id} onClick={() => onSelect(id)} className={cellClass(active === id)}>
              <Icon aria-hidden="true" className="size-4" />
              <span>{label}</span>
            </button>
          ) : (
            <Link key={id} href={links?.[id] ?? "/"} aria-current={active === id ? "page" : undefined} className={cellClass(active === id)}>
              <Icon aria-hidden="true" className="size-4" />
              <span>{label}</span>
            </Link>
          )
        ))}
        <button ref={menuButtonRef} type="button" aria-haspopup="dialog" aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)} className={cellClass(false)}>
          <Menu aria-hidden="true" className="size-4" />
          <span>Menu</span>
        </button>
      </nav>
      {menuOpen && <MobileMenuSheet onClose={() => setMenuOpen(false)} />}
    </>
  );
}

function MobileMenuSheet({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  const trapFocus = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
    )).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (!dialog.current.contains(current)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog ref={dialog} aria-label="Menu" aria-modal="true" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={trapFocus}
      className="m-0 mt-auto max-h-[70dvh] w-full max-w-none animate-in border-0 border-t border-solid border-border bg-surface-raised p-0 text-foreground backdrop:bg-black/70 fade-in slide-in-from-bottom-5 duration-200">
      <div className="flex min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 className="text-sm font-semibold">Menu</h2>
          <button type="button" onClick={onClose} aria-label="Close menu"
            className="rounded-md p-1 text-muted-foreground transition-colors duration-150 hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto py-3">
          <AppNavList onNavigate={onClose} exclude={["Agents"]} />
        </div>
      </div>
    </dialog>
  );
}
