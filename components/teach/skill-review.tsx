"use client";

import { useState } from "react";
import { BookOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/workspace/modal-dialog";

type Skill = { id: string; name: string; description: string; body: string; status: "draft" | "cleanup_pending" | "approved"; source: "video" | "steps_screenshots" };
type State = { status: "idle" | "running" | "draft" | "approved" | "error"; text?: string; skill?: Skill; failed?: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseSkill(value: unknown): Skill | null {
  if (!value || typeof value !== "object") return null;
  const skill = value as Record<string, unknown>;
  if (typeof skill.id !== "string" || !UUID.test(skill.id) || typeof skill.name !== "string" || typeof skill.description !== "string" ||
      typeof skill.body !== "string" || !["draft", "cleanup_pending", "approved"].includes(String(skill.status)) ||
      !["video", "steps_screenshots"].includes(String(skill.source))) return null;
  return skill as Skill;
}

async function csrfToken() {
  const response = await fetch("/api/auth/csrf", { cache: "no-store" });
  if (!response.ok) throw new Error();
  const body = await response.json() as { csrfToken?: unknown };
  if (typeof body.csrfToken !== "string" || !/^[0-9a-f]{64}$/.test(body.csrfToken)) throw new Error();
  return body.csrfToken;
}

export function SkillReview({ captureId }: { captureId: string }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [confirmApprove, setConfirmApprove] = useState(false);

  async function generate() {
    if (state.status === "running") return;
    setState({ status: "running", text: "Drafting the skill from steps, screenshots and narration…" });
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/teach/${captureId}/skill`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-csrf-token": token }, body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => null) as { skill?: unknown; error?: unknown } | null;
      const skill = parseSkill(body?.skill);
      if (!response.ok || !skill) throw new Error(typeof body?.error === "string" ? body.error : "");
      setState({ status: skill.status === "approved" ? "approved" : "draft", skill });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setState({ status: "error", text: code === "no_model" ? "Save a Main AI model and key before generating a skill."
        : code === "price_required" ? "Add a price for this model in Settings → Models before generating a skill."
          : code === "budget_paused" ? "This agent's budget is paused. Raise it or wait for the next period."
            : code === "generation_busy" ? "A skill is already being generated. Wait a moment and try again."
              : "Couldn't generate a skill from this recording. The recording is retained." });
    }
  }

  async function approve() {
    if (state.status !== "draft" || !state.skill) return;
    setState({ ...state, text: "Approving and deleting the recording…" });
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/skills/${state.skill.id}/approve`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-csrf-token": token }, body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => null) as { skill?: unknown; error?: unknown } | null;
      const skill = parseSkill(body?.skill);
      if (!response.ok || !skill || skill.status !== "approved") throw new Error();
      setState({ status: "approved", skill });
    } catch {
      setState({ status: "draft", skill: state.skill, failed: true, text: "Approval could not finish. The draft is not callable; try again." });
    }
  }

  return (
    <section aria-label="Skill draft" className="border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <BookOpen aria-hidden="true" className="size-4 text-muted-foreground" />
        <h3 className="font-semibold tracking-tight">Reusable skill</h3>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Generate a reviewed SKILL.md from this recording. Approval deletes the recording and keeps one reference screenshot per step.</p>
      {state.skill && (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">
            {state.skill.source === "video" ? "Learned from video + steps" : "Learned from steps + screenshots"}
          </p>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 font-mono text-xs">{state.skill.body}</pre>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {state.status !== "approved" && (
          <Button size="sm" variant={state.status === "draft" ? "secondary" : "primary"} disabled={state.status === "running"}
            onClick={() => state.status === "draft" ? setConfirmApprove(true) : void generate()}>
            {state.status === "running" && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            {state.status === "draft" ? "Approve skill" : state.skill ? "Regenerate skill" : "Generate skill"}
          </Button>
        )}
        {state.status === "approved" && <p role="status" className="text-sm text-success">Skill approved. It is available to this agent and routines.</p>}
      </div>
      {state.text && <p role={state.status === "error" || state.failed ? "alert" : "status"} className={`mt-2 text-xs ${state.status === "error" || state.failed ? "text-danger" : "text-muted-foreground"}`}>{state.text}</p>}
      {confirmApprove && state.skill && (
        <ModalDialog title="Approve this skill" description="Approving makes it available to this agent and routines. The recording, events, video and extra screenshots will be deleted, keeping one reference screenshot per step. This cannot be undone." onClose={() => setConfirmApprove(false)}>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirmApprove(false)}>Keep draft</Button>
            <Button autoFocus size="sm" onClick={() => { setConfirmApprove(false); void approve(); }}>Approve and delete recording</Button>
          </div>
        </ModalDialog>
      )}
    </section>
  );
}
