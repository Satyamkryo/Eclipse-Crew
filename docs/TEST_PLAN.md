# Test Plan

What "working" means for the v1 hackathon build. Each item is an observable pass/fail check. Covers the **[M]** features in `docs/PRD.md`; **[S]** features get checks when they are built.

<!--
Rules for AI agents:
- Tick an item only after running it and seeing it pass (test output, screenshot or receipt). Never tick from reading code.
- When a feature is added or changed, add or edit its checks in the same change. One line per check.
- "Cannot" checks (denied paths) are as important as "can" checks. Don't drop them.
- Keep it a checklist: no test code, no logs, no explanations here.
-->

## Setup and deployment

- [ ] `docker compose up -d` on a clean machine starts `app`, `postgres`, `desktop` and `egress-proxy`
- [ ] Clean machine to first agent replying in ≤ 15 minutes
- [ ] All services come back after a host reboot (`restart: unless-stopped`)
- [ ] App answers on `127.0.0.1:3000` and is not reachable from another device on the LAN
- [ ] Postgres, VNC, CDP and desktop-controller ports are not published on the host
- [ ] Works on Windows (Docker Desktop, WSL 2), macOS and a Linux VPS with the same compose file
- [ ] Per-agent file permissions hold inside Docker volumes on Windows

## Owner account

- [ ] First visit opens setup; owner account is created with email + Eclipse Crew password
- [ ] After setup, `/setup` returns 404 and no second account can be created
- [ ] Owner can log in; wrong email or password shows an error
- [ ] Repeated failed logins are rate-limited and temporarily locked out
- [ ] Logged-out users cannot open any page, API route, SSE stream or the desktop stream
- [ ] Change password requires the current password and signs out other sessions
- [ ] Change email requires the current password
- [ ] "Sign out everywhere" ends all other sessions
- [ ] `eclipse-crew reset-password` on the host resets the password
- [ ] Password is stored as an argon2id hash; session cookie is HttpOnly and SameSite

## Agents and isolation

- [ ] Owner can create, edit, pause and delete an agent (name, role, persona, permissions, budget)
- [ ] Each agent gets its own Linux user, `700` home, screen and Chromium profile
- [ ] Agent A cannot read Agent B's files, browser profile, cookies or credentials
- [ ] Agents have no sudo and cannot read the database, `.env` or host folders
- [ ] Logins persist in an agent's browser profile across restarts
- [ ] Delete removes the agent's Linux user, profile, files and memory after a backup prompt
- [ ] Agent knows its persona, its permissions and the current date/time

## Chat and files

- [ ] Replies render as the four card types: message, clarification, tool connection, routine
- [ ] Invalid model output is rejected and never executed
- [ ] Chat history persists per agent; background run results appear in the timeline
- [ ] Files can be attached by button, drag-and-drop and paste; they land in that agent's `inbox/`
- [ ] Files over the size limit (default 250 MB) are rejected
- [ ] Files the agent writes to `outbox/` appear as file cards with Download and Open on the agent's desktop

## Live desktop and takeover

- [ ] Desktop tab shows the agent's live screen within 2 seconds
- [ ] Take over gives the owner mouse and keyboard; the agent pauses
- [ ] Hand back resumes the agent where it was
- [ ] Agent stops at login walls, CAPTCHAs, OTPs and payment checks and asks the owner
- [ ] Nothing is recorded during takeover unless the owner presses Record
- [ ] Every step shows the model that did it

## Perception and proof receipts

- [ ] Model output is an intent `{action, target, expect}`, never raw coordinates
- [ ] Targets are found from page structure on normal websites
- [ ] With SAM on, targets are located and verified with SAM masks; with SAM off, receipts say "SAM off"
- [ ] Irreversible actions (send, delete, purchase, payment hand-off) ask when two methods don't agree
- [ ] Adding a model detects its capabilities (tool calling, vision, computer use)
- [ ] Every step writes a receipt (before/after hashes, target, method, confidence, result, cost, `prev_hash`)
- [ ] `eclipse-crew verify run.json` passes on an untouched export
- [ ] `verify` fails if any step is altered, removed or reordered
- [ ] History shows before/after thumbnails and pass/fail per step
- [ ] ≥ 95% of steps on the demo routine are verified

## Teach from video

- [ ] Take over → Record → do a task → Stop captures video, events, targets, before/after shots and narration
- [ ] Passwords and OTPs are masked in the capture and never appear in the skill
- [ ] A draft `SKILL.md` is generated with steps, inputs and a check per step
- [ ] The skill shows how it was learned (e.g. "Learned from video + steps")
- [ ] After approval the skill is callable in chat and schedulable
- [ ] After approval the recording is deleted and one reference screenshot per step is kept

## Rewind and branch

- [ ] Rewinding to step N restores the agent's state and files at that step
- [ ] A correction continues the run as a new branch without re-running earlier steps
- [ ] The original branch stays visible in History
- [ ] The UI states that external side effects (sent emails, orders) are not undone

## Routines and jobs

- [ ] A routine created in chat shows a routine card; confirming saves it
- [ ] Once, daily, weekly, monthly, custom weekdays and cron schedules fire at the right local time
- [ ] Run Now starts it immediately with live step status
- [ ] A duplicate scheduler tick does not run a routine twice
- [ ] One agent runs one job at a time; different agents run in parallel
- [ ] After the stack was down, missed runs follow the catch-up policy (run once / skip / run all)
- [ ] Second run of a verified routine with no site change makes no model calls ($0.00 model cost)
- [ ] When the mock portal layout changes, the check fails, the agent self-heals and proposes a skill diff
- [ ] Approving the skill diff updates the skill; the next run uses it
- [ ] Jobs dashboard lists runs with status, agent, trigger, duration and cost
- [ ] Run detail shows the step timeline, receipts, errors and retry history
- [ ] Run now, Cancel, Retry and Pause/Resume work from the dashboard

## Models and keys

- [ ] Main AI accepts a Meta Model API key; Test shows models and latency
- [ ] SAM card with "Use the same key as Main AI" works with one Meta key
- [ ] Saved keys show only as `••••1a2b` and are never returned by the API
- [ ] Keys never appear in model prompts, logs or receipts
- [ ] Muse Wonder is used for hard computer-use steps and falls back to Spark when unavailable
- [ ] A model without tool calling is rejected with a clear message

## Approvals, permissions and Astra Mode

- [ ] Anything not in an agent's permissions is denied
- [ ] Risky actions prompt Allow once / Always allow / Deny
- [ ] Always allow is stored per agent + site + action (+ limit) and doesn't apply to other agents or sites
- [ ] An action over a saved limit asks again
- [ ] Enabling Astra Mode needs the warning modal; the red ASTRA MODE badge shows everywhere
- [ ] In Astra Mode, receipts, audit log, budgets, tripwire and key isolation still work

## Security

- [ ] Agents can only reach domains on their allowlist
- [ ] Requests to `169.254.169.254` and private network ranges are blocked
- [ ] Credentials are injected by the egress proxy; the model never sees them
- [ ] An agent's canary secret leaving the machine kills the session and logs a security event
- [ ] A malicious page instructing the agent to send data elsewhere does not change the task
- [ ] Stop agent halts one agent immediately; Stop crew halts all of them
- [ ] Security Center lists tripwire events and blocked actions
- [ ] Audit log is append-only and signed

## Memory

- [ ] `SOUL.md`, `USER.md` and `MEMORY.md` are readable and editable in the Memory tab
- [ ] Every new entry has a scope (global / agent / private) and provenance
- [ ] A `private` entry is not visible to agents outside its list
- [ ] Facts learned from web, email or documents need approval before entering shared memory
- [ ] New memories show as diffs with Undo; pinned facts are never rewritten
- [ ] Writes during a session take effect in the next session (frozen snapshot)
- [ ] Changes are mirrored to `./data/memory` as Markdown

## Budgets and cost

- [ ] Budgets per agent, routine, day and month warn at 80% and pause the agent at 100%
- [ ] Run guards stop runs at max steps, max tokens and the wall-clock limit
- [ ] The same action repeated 3 times stops the run
- [ ] Each run has a cost receipt: tokens in/out/cached, model per step, cost in USD
- [ ] Editing the price table changes later cost receipts

## Date and time

- [ ] "What's today's date and time?" is answered correctly in the owner's timezone
- [ ] "Next Friday 9am" resolves to the correct date and is shown in the routine card
- [ ] A weekday 09:00 routine fires at 09:00 local time across a DST change
- [ ] Timestamps are stored in UTC and shown in the owner's timezone

## Non-functional

- [ ] UI actions respond in under 400 ms
- [ ] Layout works at 375, 768, 1280 and 1440 px; approvals, skill diffs and Jobs are usable on a phone
- [ ] Web app is keyboard-navigable with visible focus states
- [ ] WCAG 2.2 AA contrast; controls have ARIA labels
- [ ] No telemetry: only model, tool and agent-browsing traffic leaves the machine

## Demo acceptance

- [ ] The demo story runs end to end without manual fixes in 5 consecutive takes
- [ ] At least 4 Meta models are visibly used (Spark/Wonder, SAM 3.1, Voice Transcribe, Image)
