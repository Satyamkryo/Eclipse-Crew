"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = { title: string; description?: string; onClose: () => void; children: ReactNode };

export function ModalDialog({ title, description, onClose, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    const first = element?.querySelector<HTMLElement>(
      "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], button:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
    );
    first?.focus();
    return () => {
      if (element?.open) element.close();
      opener?.focus();
    };
  }, []);

  const trapFocus = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
    )).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={trapFocus}
      className="m-auto max-h-[90dvh] w-[min(92vw,680px)] overflow-y-auto rounded-xl border border-border bg-card p-0 text-foreground backdrop:bg-black/70">
      <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-card px-5 py-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
          {description && <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        <Button type="button" variant="ghost" size="sm" aria-label={`Close ${title}`} onClick={onClose}>
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}
