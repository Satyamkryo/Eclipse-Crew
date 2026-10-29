# Tasks

The v1 build broken into small tasks, in order. Scope comes from the **[M]** features in `docs/PRD.md`; checks come from `docs/TEST_PLAN.md`; binding choices are in `docs/DECISIONS.md`.

## How to work

```
TASK-NNN → Implement → Test → Review → Mark complete → next task
```

1. **Implement** one task only. Don't touch the next one.
2. **Test** against the matching `docs/TEST_PLAN.md` section. Run it; don't assume.
3. **Review** the diff: follows `docs/DECISIONS.md` and `docs/SECURITY.md`, nothing outside the task changed.
4. **Mark complete** with `[x]` here, and update `Current Task` in `docs/MEMORY.md`.

<!--
Rules for AI agents:
- One task per prompt. If a task is too big for one prompt, stop and ask to split it.
- Never renumber. New tasks get the next free number, placed in the right phase.
- Don't add tasks for [S]/[L] features until the [M] list is done, unless the owner asks.
- One line per task. No notes or logs here; blockers go in docs/MEMORY.md → Known Issues.
-->

---

## Phase 1: Repo and stack skeleton (Thu Oct 29)

Test: `docs/TEST_PLAN.md` → Setup and deployment

- [x] TASK-001 Create `.gitignore` (`docs/PRD.md`, `prompts/`, `.env`, `data/`, backups, `node_modules/`)
- [ ] TASK-002 `git init`, first commit, create the public GitHub repo
- [ ] TASK-003 Scaffold the Next.js app (App Router, TypeScript, Tailwind CSS, shadcn/ui)
- [ ] TASK-004 Add Postgres + Drizzle with the first migration; `owner_id` convention on tables
- [ ] TASK-005 Write `docker-compose.yml`: `app`, `postgres`, `desktop`, `egress-proxy`, volumes, `127.0.0.1:3000`, `restart: unless-stopped`
- [ ] TASK-006 Create `.env.example` and Zod-validated config loading
- [ ] TASK-007 Day-1 spike: Meta computer-use action on a real screenshot
- [ ] TASK-008 Day-1 spike: SAM 3.1 check on a real screenshot
- [ ] TASK-009 Day-1 spike: per-agent permissions and volume performance on Windows

## Phase 2: Desktop sandbox (Fri Oct 30)

Test: `docs/TEST_PLAN.md` → Agents and isolation, Live desktop and takeover

- [ ] TASK-010 Desktop image: Ubuntu, Xvfb, window manager, Chromium, `playwright-core`, xdotool, ffmpeg, x11vnc, noVNC
- [ ] TASK-011 Per-agent Linux user and home layout (`inbox/`, `outbox/`, `work/`, `Downloads/` noexec, mode `700`)
- [ ] TASK-012 Per-agent Xvfb screen and Chromium profile; CDP bound inside the container only
- [ ] TASK-013 desktop-controller internal API (screenshots, input, Playwright), accepting only `app` with a shared secret
- [ ] TASK-014 Live view of an agent's screen in the web app via noVNC
- [ ] TASK-015 Take over / Hand back (agent pauses and resumes; no capture during takeover)

## Phase 3: Web shell and agent loop (Fri Oct 30)

Test: `docs/TEST_PLAN.md` → Owner account, Chat and files, Models and keys, Date and time

- [ ] TASK-016 Setup wizard and login (argon2id, server-side sessions, CSRF, rate limiting); `/setup` closes after the owner exists
- [ ] TASK-017 Account settings: change password/email, active sessions, sign out everywhere; `reset-password` CLI
- [ ] TASK-018 Three-pane workspace layout
- [ ] TASK-019 Agents: create/edit/pause/delete with persona (`SOUL.md`), permissions and budget
- [ ] TASK-020 Settings → Models: Main AI and SAM role cards, encrypted saved keys, "same key" checkbox, Test button
- [ ] TASK-021 Provider layer: connector interface, native Meta adapter, OpenAI-compatible adapter, capability detection
- [ ] TASK-022 Chat with Zod-validated cards (message, clarification, tool connection, routine) and history
- [ ] TASK-023 Chat attachments into `inbox/`; file result cards from `outbox/`
- [ ] TASK-024 Agent step loop: build context, plan, intent `{action, target, expect}`, execute via desktop-controller
- [ ] TASK-025 Grounding from page structure (Playwright/CDP element refs)
- [ ] TASK-026 Clock block in every model call and `get_time` tool
- [ ] TASK-027 Model routing (Spark default, Wonder for hard steps with fallback) and model label on every step

## Phase 4: Proof, checkpoints and cost (Sat Oct 31)

Test: `docs/TEST_PLAN.md` → Perception and proof receipts, Budgets and cost

- [ ] TASK-028 Verification cascade (page-structure postconditions, SAM 3.1 if enabled, model judgement) and confidence gate
- [ ] TASK-029 Per-step receipts with hash chain; Ed25519 key generated at install
- [ ] TASK-030 `eclipse-crew verify` CLI
- [ ] TASK-031 History timeline UI (before/after thumbnails, SAM highlight, pass/fail)
- [ ] TASK-032 Per-step checkpoints (state + content-addressed files)
- [ ] TASK-033 Run guards (max steps, tokens, wall clock; loop detection)
- [ ] TASK-034 Budgets (warn 80%, pause 100%), cost receipts, editable price table
- [ ] TASK-035 Mock vendor portal with a switchable layout

## Phase 5: Teach, routines and replay (Sun Nov 1)

Test: `docs/TEST_PLAN.md` → Teach from video, Routines and jobs

- [ ] TASK-036 Teach capture: Record with video, events, targets, before/after shots, narration; secrets masked
- [ ] TASK-037 Video → `SKILL.md` generation, review and approve; recording cleanup after approval
- [ ] TASK-038 Routines table and routine card: schedules, IANA timezone, relative dates resolved by code
- [ ] TASK-039 pg-boss scheduler tick: idempotency key, one job per agent, retries, catch-up on startup
- [ ] TASK-040 Run Now with live step status
- [ ] TASK-041 Deterministic replay: compile a verified run and replay without model calls
- [ ] TASK-042 Jobs dashboard: runs list, run detail, actions, upcoming runs

## Phase 6: Rewind, self-healing, security and memory (Mon Nov 2)

Test: `docs/TEST_PLAN.md` → Rewind and branch, Routines and jobs, Security, Approvals, Memory

- [ ] TASK-043 Rewind to step N with a correction, continuing as a new branch
- [ ] TASK-044 Self-healing on postcondition mismatch with skill diff approval
- [ ] TASK-045 Egress proxy: per-agent allowlist; block internal and metadata ranges
- [ ] TASK-046 Credential injection at the egress proxy
- [ ] TASK-047 Canary tripwire: kill the session and log a security event
- [ ] TASK-048 Isolation hardening (non-root, no sudo, desktop mounts only `workspace`) and cross-agent access test
- [ ] TASK-049 Source tags on all content and task-scope enforcement
- [ ] TASK-050 Approvals: Allow once / Always allow / Deny with scoped grants and limits
- [ ] TASK-051 Astra Mode: warning modal and red badge; safety layers stay on
- [ ] TASK-052 Signed append-only audit log, kill switches, basic Security Center
- [ ] TASK-053 Memory storage: `SOUL.md` / `USER.md` / `MEMORY.md` with scopes, provenance, versions, frozen snapshot, Markdown mirror
- [ ] TASK-054 Memory writes: approval for untrusted origin, injection scan, diffs with Undo, pinning
- [ ] TASK-055 Record final demo footage

## Phase 7: Feature freeze (Tue Nov 3)

Test: full `docs/TEST_PLAN.md`

- [ ] TASK-056 Run the full test plan and fix failures
- [ ] TASK-057 Update `.github/README.md` and `docs/ARCHITECTURE.md` to match what was built
- [ ] TASK-058 Should-have demo extras, only if everything above is stable
- [ ] TASK-063 [S] Anthropic-compatible connector: Messages API, tool calling, images, prompt-cache markers, computer use via intents (ADR-023)
- [ ] TASK-059 Demo narration

## Phase 8: Submit (Wed Nov 4)

Test: `docs/TEST_PLAN.md` → Demo acceptance

- [ ] TASK-060 Confirm the license (ADR-022) and add `LICENSE`
- [ ] TASK-061 Compose and render the 3-minute demo video
- [ ] TASK-062 Final checks and submission before Thu Nov 5, 06:30 IST
