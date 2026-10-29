# Eclipse Crew — Architecture

Eclipse Crew is an open-source, self-hosted platform for AI teammates. A crew of named agents shares one Linux desktop (real browser, terminal and files), each isolated under its own Linux user, and streamed live into a local web workspace where the owner can watch or take over at any time.

> **Status:** target architecture (design stage). Items are tagged **[M]** must-have for v1, **[S]** should-have, **[L]** later. Anything not tagged is part of the core design.

---

## Contents

1. [Design principles](#1-design-principles)
2. [System context](#2-system-context)
3. [Deployment topology](#3-deployment-topology)
4. [Services](#4-services)
5. [Technology stack](#5-technology-stack)
6. [Agent runtime](#6-agent-runtime)
7. [Perception layer](#7-perception-layer)
8. [Model provider layer](#8-model-provider-layer)
9. [Proof receipts](#9-proof-receipts)
10. [Checkpoints, rewind and branching](#10-checkpoints-rewind-and-branching)
11. [Skills and teach mode](#11-skills-and-teach-mode)
12. [Routines, jobs and scheduling](#12-routines-jobs-and-scheduling)
13. [Memory](#13-memory)
14. [Multi-agent work](#14-multi-agent-work)
15. [Security architecture](#15-security-architecture)
16. [Authentication](#16-authentication)
17. [Data and storage](#17-data-and-storage)
18. [Cost control](#18-cost-control)
19. [Date and time](#19-date-and-time)
20. [Voice](#20-voice)
21. [Web workspace](#21-web-workspace)
22. [CLI](#22-cli)
23. [Key flows](#23-key-flows)
24. [Non-functional requirements](#24-non-functional-requirements)
25. [Open questions](#25-open-questions)
26. [Glossary](#26-glossary)

---

## 1. Design principles

| Principle | Architectural consequence |
|---|---|
| **Proof over claims** | Every step is verified and leaves a signed, hash-chained receipt. |
| **Need-to-know** | Default-deny role policies; isolation enforced by the OS, not the prompt. |
| **Only the user gives orders** | All content carries a source tag; untrusted content is data, never instructions. |
| **Don't call the AI when code will do** | Deterministic replay, cheap probes before model calls, code-resolved dates. |
| **The user's machine, the user's data** | Everything stored locally; only model and tool calls leave, through one egress proxy. No telemetry. |
| **Honest limits** | CAPTCHAs, OTPs, payment verification and anti-automation sites are handed to the human. |
| **Model-agnostic** | A perception layer gives every model the same behaviour and safety; only precision varies. |

---

## 2. System context

```mermaid
flowchart LR
  Owner([Owner<br/>browser / PWA])
  subgraph Host["Host: PC (Docker Desktop) or Linux VPS"]
    EC[Eclipse Crew stack]
  end
  Models[(Model providers<br/>Meta Model API, Baseten,<br/>Anthropic, OpenAI, OpenRouter)]
  Local[(Local models<br/>Ollama, LM Studio,<br/>llama.cpp, vLLM)]
  Tools[(External tools<br/>MCP servers, Composio,<br/>n8n/Make webhooks)]
  Web[(Public websites)]

  Owner -- "localhost:3000 / Tailscale / Caddy HTTPS" --> EC
  EC -- "egress proxy" --> Models
  EC -- "egress proxy" --> Tools
  EC -- "egress proxy" --> Web
  EC -- "host.docker.internal / tailnet" --> Local
```

- One install equals one owner. The owner reaches the web app locally on `127.0.0.1:3000`, or remotely through Tailscale (recommended) or Caddy with automatic HTTPS.
- All outbound traffic from agents and tools goes through the **egress proxy**.

---

## 3. Deployment topology

One `docker compose up` starts the full stack. The same compose file runs on Windows (Docker Desktop / WSL 2), macOS and a Linux VPS. All services use `restart: unless-stopped`.

```
┌──────────────────────────── Host (PC or VPS) ─────────────────────────────┐
│                                                                           │
│  app (Next.js UI + API + agent runtime + pg-boss job workers)             │
│    ├─ talks to: postgres, desktop-controller, egress-proxy                │
│    └─ calls: Meta Model API / Baseten / user's providers (via proxy)      │
│                                                                           │
│  postgres (Docker-managed volume)                                         │
│    └─ pg-boss tables (job queue, schedules, archive)                      │
│                                                                           │
│  desktop (Linux sandbox, internal network only)                           │
│    ├─ Linux user per agent → Xvfb screen :N → Chromium profile            │
│    ├─ desktop-controller (internal API): screenshots, xdotool input,      │
│    │    Playwright/CDP, ffmpeg recording, file checkpoints                │
│    └─ x11vnc + noVNC per screen → streamed to the web app                 │
│                                                                           │
│  egress-proxy (all outbound traffic from desktop + tools)                 │
│    ├─ per-agent domain allowlist, threat feeds, ad/tracker blocking       │
│    ├─ credential injection (tokens never reach the model)                 │
│    └─ canary tripwire scanning                                            │
│                                                                           │
│  volumes: workspace, artifacts, postgres  ·  ./data/memory (mirror)       │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Network exposure

| Endpoint | Exposure |
|---|---|
| Web app (UI + API) | `127.0.0.1:3000` by default; port 443 via Caddy, or nothing with Tailscale |
| Postgres | Internal only |
| CDP (Chrome DevTools Protocol) | Inside the desktop container only |
| VNC / websockify | Internal; streamed through the app |
| desktop-controller API | Internal only |
| Jobs API / pg-boss | Internal only (no separate dashboard service) |
| Webhook triggers | `POST /api/hooks/<id>` on the app, secret token required **[S]** |

### 3.2 Optional compose profiles

| Profile | Adds | Notes |
|---|---|---|
| `local-ai` | Ollama container | Linux PC or GPU VPS **[S]** |
| `local-vision` | Local SAM 3.1 server | NVIDIA GPU, CUDA 12.6+; weights downloaded by the user, never shipped **[S]** |

---

## 4. Services

### 4.1 `app`

A single Next.js deployment plus TypeScript worker processes.

| Module | Responsibility |
|---|---|
| Web UI | Three-pane workspace, live desktop, Jobs dashboard, Security Center, Settings |
| API (route handlers) | REST endpoints, SSE streams, webhook triggers; Zod validation on every boundary |
| Agent runtime | Step loop, policy engine, perception layer, receipt writer, checkpoints |
| Provider layer | Model adapters (native Meta, OpenAI-compatible, Anthropic-compatible), routing, capability profiles |
| Job workers | pg-boss consumers: `routine.run`, Sundance/Moondance checks, consolidation, backup |
| Scheduler | One-minute tick over the `routines` table |
| Memory service | Single-writer queue, versioning, injection scanning, Markdown mirror |
| Auth | Owner login, sessions, CSRF, rate limiting, TOTP **[S]** |

### 4.2 `postgres`

Source of truth for all structured state: agents, policies, chats, memory, skills, routines, runs, steps, receipts metadata, approvals, security events, encrypted keys. It also holds the pg-boss queue tables. Full-text search covers past conversations **[S]**.

### 4.3 `desktop`

An Ubuntu sandbox on the internal network only. It contains Xvfb, a lightweight window manager, Chromium (Google Chrome optional, downloaded on the user's machine at build time), `playwright-core`, xdotool, ffmpeg, x11vnc and noVNC/websockify. It also has a text editor, PDF viewer and image viewer; LibreOffice is an optional layer **[S]**.

| Per agent | |
|---|---|
| Linux user | Unique, no sudo, home mode `700` |
| Screen | Xvfb display `:N` |
| Browser | Chromium profile at `/home/<agent>/.config/chromium` |
| Stream | x11vnc → noVNC → web app |

**desktop-controller** is the only programmatic entry point into the sandbox. It exposes an internal API for:

- screenshots (full screen and region crops)
- input via xdotool (click, type, scroll, drag)
- browser control via Playwright/CDP (element refs, accessibility snapshots)
- ffmpeg screen recording (teach mode)
- teach capture (input events plus before/after screenshots)
- content-addressed file checkpoints and restores
- secret entry from opaque handles (the value never passes through the model)

The desktop container mounts **only** the `workspace` volume. It never sees the database, `.env` or secrets.

### 4.4 `egress-proxy`

The single outbound path for the desktop and tools.

- per-agent default-deny domain allowlists
- blocking of internal and cloud-metadata addresses (`169.254.169.254`, RFC 1918 ranges)
- credential injection: API keys and tokens are added at the proxy and never placed in model context
- canary tripwire: kills the session when an agent's canary secret appears in outbound traffic
- threat feeds (URLhaus, OpenPhish/PhishTank, Hagezi) and look-alike domain detection **[S]**
- ad and tracker blocking **[S]**
- payment-provider redirect rules **[S]**

---

## 5. Technology stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router), React, TypeScript, Tailwind CSS, shadcn/ui, Lucide; PWA manifest + service worker |
| Backend | Next.js route handlers + TypeScript workers; Zod |
| Database | PostgreSQL + Drizzle ORM; Postgres full-text search |
| Jobs | pg-boss (MIT) inside Postgres; `cron-parser` with IANA timezones |
| Sandbox | Ubuntu, Xvfb, Chromium, `playwright-core` (library, not MCP), xdotool, ffmpeg, x11vnc, noVNC |
| Integrations | MCP servers (stdio/HTTP); Composio SDK (optional, user's key) **[S]** |
| Models | Native Meta adapter + OpenAI-compatible adapter + Anthropic-compatible adapter [S]; local endpoints through the OpenAI-compatible one |
| Auth | argon2id, HttpOnly SameSite session cookies, CSRF, TOTP (RFC 6238) **[S]** |
| Signing | Ed25519 key generated at install |
| Voice | Meta Voice Transcribe, any OpenAI-compatible STT, or `whisper.cpp` (MIT) locally **[S]** |
| License | Apache-2.0 (recommended, pending confirmation) |

**Why pg-boss, not Inngest:** pg-boss runs inside the existing Postgres with no extra container and is MIT-licensed. Inngest's self-hosted single-node mode is beta and SSPL-licensed. Run durability comes from Eclipse Crew's own per-step checkpoints, not the job engine.

---

## 6. Agent runtime

### 6.1 Step loop

Every step of every run follows the same loop:

```mermaid
flowchart TD
  A[1. Build context<br/>frozen snapshot + clock block<br/>+ task state + relevant skill] --> B[2. Plan next action<br/>routed model emits intent]
  B --> C[3. Ground target<br/>perception layer cascade]
  C --> D{4. Policy check<br/>permissions · taint · budget<br/>approvals / Astra Mode}
  D -- denied / needs approval --> H[Ask owner]
  H -- approved --> E
  D -- allowed --> E[5. Execute<br/>via desktop-controller]
  E --> F[6. Verify expect<br/>verification cascade]
  F --> G[Write receipt + checkpoint]
  G -- pass --> A
  F -- fail --> R{7. Recovery}
  R -- retry --> C
  R -- self-heal --> B
  R -- give up --> H2[Hand off to owner]
```

### 6.2 Run guards [M]

| Guard | Behaviour |
|---|---|
| Max steps / max tokens / wall-clock limit | Stop the run and report |
| Loop detection | The same action repeated 3× stops the run |
| Budgets | Warn at 80%, pause and ask at 100% (see §18) |
| Concurrency | One run per agent at a time (one screen); agents run in parallel |

Per-step checkpoints are also needed because stateless computer-use replay is reportedly capped at 29 screenshot/action pairs per request (to verify).

### 6.3 Takeover and hand-off

- The owner can take over any screen (mouse + keyboard). The agent pauses and resumes on **Hand back**.
- Agents pause at login walls, CAPTCHAs, OTPs and payment verification and hand off to the owner.
- Nothing is screenshotted or recorded during takeover, except when the owner explicitly presses **Record** in teach mode. Logins, CAPTCHAs and OTP entry are never recorded.

### 6.4 Structured replies [M]

Agent chat output is validated with Zod into one of four card types:

| Card | Purpose |
|---|---|
| `message` | Plain reply |
| `clarification` | Asks for missing parameters |
| `tool_connection` | Inline card to connect a tool |
| `routine` | Schedule blueprint for confirmation |

Files written to `outbox/` appear as **file result cards** (preview, Download, Show in Files, Open on the agent's desktop).

---

## 7. Perception layer

The perception layer sits between every brain model and the screen. Muse, Claude, GPT, Glimmer or any other model gets the same behaviour, receipts and safety rules; only precision differs.

### 7.1 Intent schema [M]

Models never emit raw coordinates. They emit:

```json
{ "action": "click", "target": "Submit button", "expect": "order confirmation appears" }
```

### 7.2 Grounding cascade [M]

The layer uses the best available method first and cross-checks when two methods agree:

1. **Page structure:** Playwright/CDP element refs and accessibility snapshots (any tool-calling model).
2. **Set-of-marks [S]:** numbered boxes drawn on the screenshot from page structure, the Linux accessibility tree or local OCR (any vision model).
3. **SAM 3.1 pixel masks:** only if enabled.
4. **The model's own computer-use coordinates:** only if the model supports computer use.
5. **Hand off to the owner.**

### 7.3 Verification cascade [M]

Each `expect` is checked with, in order:

1. page-structure postconditions
2. pixel diff of the target region **[S]**
3. local OCR **[S]**
4. SAM 3.1 before/after masks (if enabled)
5. model judgement (last resort)

The receipt records which methods ran and a confidence score.

### 7.4 Confidence gate [M]

Irreversible actions (purchase, send, delete, payment hand-off) need **high confidence, meaning two methods agree**. Otherwise the agent asks. Weaker setups ask more often; they don't misclick.

### 7.5 Capability profile [M]

When a provider is added, the layer detects tool calling, vision, video, audio (with known caveats, e.g. Muse Spark 1.3 audio degraded), computer use and context size. Methods are then chosen automatically, with no user configuration. Tool calling is the minimum for an agent.

### 7.6 Media adapter [S]

The media adapter converts inputs to what the active model accepts:

| Model accepts | Receives |
|---|---|
| Video + audio | Video + audio |
| Video, no reliable audio | Video + transcript |
| Images only | Teach-capture step list + before/after screenshots + transcript |
| Text only | Transcript + page snapshots |

Transcripts come from Voice Transcribe, or local `whisper.cpp` offline.

### 7.7 SAM 3.1 options

SAM 3.1 is optional, an enhancer and never a requirement.

| Option | Needs | Cost | Priority |
|---|---|---|---|
| Meta API (`sam-3-1`) | Meta key | $2.50 / 1k images | [M] |
| Local (`local-vision` profile) | NVIDIA GPU, CUDA 12.6+, Python 3.12+, PyTorch 2.7+; gated Hugging Face weights (3.50 GB FP32) | Free, offline | [S] |
| Off | — | Free | Default with no Meta key or GPU |

Only single images are used for verification. CPU-only SAM is not offered for per-step use (too slow).

### 7.8 Model check [S]

When a model is added, it runs about 10 standard tasks on the built-in mock vendor portal. The result is shown as a score and expected behaviour, e.g. "8/10, purchases will ask for approval".

---

## 8. Model provider layer

### 8.1 Adapters

- **OpenAI-compatible adapter:** OpenAI, OpenRouter, Baseten, other compatible providers, and local servers (Ollama, LM Studio, llama.cpp, vLLM). Base URL + key.
- **Anthropic-compatible adapter [S]:** Anthropic's Messages API and any endpoint that speaks the same format. Base URL + key. Handles tool calling, image input, prompt-cache markers, and Claude's computer-use tool (translated through the intent schema, §7.1). See ADR-023.
- **Native Meta adapter:** Muse models, including the Responses API computer tool (`tools: [{type: "computer"}]`) on `muse-wonder-1.0` / `muse-spark-1.3`, batched actions in screenshot pixel coordinates, and acknowledgement of `pending_safety_checks`.

### 8.2 Roles

Each job has its own provider, model and key:

| Role | Options | Required |
|---|---|---|
| **Main AI** | Meta, Anthropic, OpenAI, OpenRouter, Baseten, Custom/Local | Yes |
| **Vision precision (SAM 3.1)** | Off · Meta API · Local GPU | No |
| **Voice (STT)** [S] | Meta Voice Transcribe · OpenAI-compatible `/v1/audio/transcriptions` · audio-capable chat model · local Whisper · Off | No |
| **Images** [S] | Muse Image · Off (initials) | No |
| **Background jobs** [S] | Same as Main AI · any provider (e.g. local Glimmer) | No |

- **"Use the same key as Main AI"** appears on every other role when it uses the same provider, and is ticked by default.
- **Saved keys** are encrypted at rest, masked (`••••1a2b`), never shown again and never sent to the model. The egress proxy injects them.
- Each role has a **Test** button that makes a minimal call and reports the model list, latency and GPU detection.
- **Local auto-detection [S]** probes `host.docker.internal:11434` (Ollama), `ollama:11434` (compose profile), `host.docker.internal:1234` (LM Studio) and the NVIDIA GPU.
- **Per-agent overrides [S]** let one agent use a different setup, e.g. "local only": the agent never sends content to a cloud model.

### 8.3 Routing [M]

| Work | Default model |
|---|---|
| Chat, planning, routine compilation, extraction | Muse Spark |
| Hard computer-use steps, recovery after Spark fails | Muse Wonder (preview; falls back to Spark) |
| Grounding and verification | SAM 3.1 (if enabled) |
| Probes, quarantined reader, consolidation, research extraction | Background role (e.g. local Glimmer) **[S]** |
| Dev agent code changes | Muse Code in the agent's terminal **[S]** |

A model label ("Muse Spark", "SAM 3.1", …) is shown on every step in the UI.

---

## 9. Proof receipts

### 9.1 Receipt contents [M]

Each step produces a receipt with:

```
step_id, run_id, idx, timestamp, agent, model,
action, target (box/mask), method(s), confidence,
before_hash, after_hash, postcondition, result, cost,
prev_hash, receipt_hash
```

### 9.2 Chain and signature

```mermaid
flowchart LR
  G[Run header] --> S1[Step 1<br/>prev_hash = H header] --> S2[Step 2<br/>prev_hash = H S1] --> S3[Step N<br/>prev_hash = H S N-1] --> SIG[Run signature<br/>Ed25519]
```

- Receipts are hash-chained per run. The run is signed with an Ed25519 key generated at install.
- Thumbnails (WebP), masks and hashes are stored in the `artifacts` volume and kept permanently by default.
- `eclipse-crew verify <run.json>` checks the chain and signature offline.
- When SAM is off, receipts still state the method, e.g. *"Verified by: page structure + pixel diff (SAM off)."*

---

## 10. Checkpoints, rewind and branching

### 10.1 Checkpoints [M]

After every step the runtime stores:

- agent conversation and context state
- task state
- changed files in the agent's home, **content-addressed** (by hash, so unchanged files are not copied again) in `artifacts`

Excluded: browser cache. Files above the size limit (default 200 MB) are recorded by hash only and marked "not restorable". The browser profile is snapshotted daily.

### 10.2 Rewind and branch [M]

```mermaid
gitGraph
  commit id: "step 1"
  commit id: "step 2"
  commit id: "step 3 (wrong)"
  branch correction
  checkout correction
  commit id: "rewind to 2 + correction"
  commit id: "step 3'"
  commit id: "step 4'"
```

- Rewind to step N, add a correction and continue as a new branch (`runs.branch_of`). Earlier steps are not re-executed.
- Branches are visible in History.
- The UI states the limit: rewind restores agent state and files, **not external side effects** (sent emails, placed orders).
- **[S]** Automatic restore on security events (tripwire, malware hash hit, policy violation, tampered browser profile). After an event, every external action taken since the compromise point is listed.
- **[S]** A failed job can be replayed from the failing step.

---

## 11. Skills and teach mode

### 11.1 Teach capture [M]

The owner takes over an agent's screen and presses **Record**. Capture covers that screen only.

| Captured | Detail |
|---|---|
| Video | ffmpeg, optional mic narration |
| Input events | Clicks (x, y), keys, scrolls, drags, timestamped |
| Event targets | Page-structure element (role, name, selector), accessibility-tree element, or click point |
| Screenshots | Immediately before and after each action |
| Narration | Transcribed and aligned to event timestamps |
| Secrets | Passwords and OTPs masked as `••••`, never stored |

### 11.2 Skill generation [M]

```mermaid
flowchart LR
  Cap[Teach capture] --> MA[Media adapter]
  MA -->|video model| V[video + steps + transcript]
  MA -->|image-only model| I[steps + before/after shots + transcript]
  V --> Gen[Model drafts SKILL.md]
  I --> Gen
  Gen --> Rev[Owner reviews / approves]
  Rev --> Sk[(skills + skill_versions)]
```

- The output is a `SKILL.md` with agentskills.io / OpenClaw / Hermes-compatible frontmatter (`name`, `description`), steps, inputs, explicit postconditions and a reference screenshot per step.
- The UI records how the skill was learned, e.g. "Learned from video + steps".
- Approved skills become callable and schedulable. Secret inputs are never written into skills.
- After approval, recordings are deleted except one reference screenshot per step.
- **[S]** Long recordings are capped and downscaled to fit context, with a warning to split long tasks.
- **[S]** Post-run review improves skills, gated like memory writes.
- **[S]** Import/export uses the OpenClaw/Hermes format. Imported skills are scanned and can never grant permissions.

### 11.3 Deterministic replay [M]

A verified run compiles into a **replay script** (selectors, reference crops, coordinates, postconditions). Later runs replay with **no model calls**. The model is invoked only on a postcondition mismatch, so a second run with no drift costs $0 in model fees.

### 11.4 Self-healing [M]

When a postcondition fails because the site changed, the agent:

1. re-plans visually
2. completes the step
3. proposes a **skill diff** ("what changed") for approval

---

## 12. Routines, jobs and scheduling

### 12.1 Routine model

A routine has a goal, steps or a skill, a schedule (once, daily, weekly, monthly, custom weekdays, cron), an IANA timezone, tools, a budget, a catch-up policy and a mode (`cron | webhook | sundance | moondance`). Routines are created conversationally through a `routine` card and confirmed by the owner.

### 12.2 Scheduler [M]

```mermaid
sequenceDiagram
  participant Tick as pg-boss tick (every 1 min)
  participant DB as routines table
  participant Q as pg-boss queue
  participant W as routine.run worker
  Tick->>DB: SELECT due (next_run_at <= now) FOR UPDATE SKIP LOCKED
  Tick->>Q: enqueue routine.run (key = routine_id + scheduled_at)
  Tick->>DB: next_run_at = cron-parser(schedule, tz)
  Q->>W: deliver (singleton per agent)
  W->>W: step loop (§6) → receipts
  W-->>Q: retry with backoff on failure
```

- The `routines` table is the source of truth, so edits apply immediately.
- The idempotency key `routine_id + scheduled_at` means a duplicate tick never double-runs.
- Concurrency is 1 per agent; different agents run in parallel.
- Failure path: retries with exponential backoff → self-healing → hand off.
- On startup, overdue routines follow their catch-up policy: run once now, skip, or run all missed.
- Times are stored as UTC + IANA timezone (DST-safe).

### 12.3 Sundance / Moondance [S]

Periodic check-ins run as routines on the same tick and runner.

| | Sundance (day) | Moondance (night) |
|---|---|---|
| Default hours | 07:00–19:00 local | 19:00–07:00 local |
| Frequency | e.g. every 15 min | e.g. every 1–2 h |
| Alerts | Real-time push | Silent; urgent only |
| Heavy jobs | Avoided | Consolidation, backups, deep research, replay tests |

Check cycle: **cheap probe (no AI)** → compare fingerprint → unchanged: log "nothing new" → changed: wake the agent with only the diff → act or alert → schedule the next check.

- ±10% jitter on every interval
- adaptive back-off (15 → 30 → 60 min), speeding back up after activity
- webhooks first where supported, polling as fallback

### 12.4 Webhooks [S]

`POST /api/hooks/<id>` with a secret token starts a routine. Received payloads appear in the event log.

### 12.5 Jobs dashboard

A built-in page over pg-boss and the run tables, with no extra service or port.

- **[M]** Runs list (status, agent, trigger, start, duration, cost; filters and search), run detail (step timeline, receipts, I/O, errors, retry history), actions (Run now, Cancel, Retry, Pause/Resume) and upcoming runs in local time.
- **[S]** SSE live updates, a health strip (queue depth, failures in 24 h, "nothing new" rate), replay from the failing step and the webhook log.

---

## 13. Memory

### 13.1 Files [M]

Postgres is the source of truth. Markdown is mirrored to `./data/memory` on every change.

| File | Scope | Starting cap |
|---|---|---|
| `SOUL.md` | Per agent: persona, role, tone, boundaries | ~2,000 chars |
| `USER.md` | Shared across the crew: facts about the owner | 1,375 chars |
| `MEMORY.md` | Per agent: environment, conventions, lessons | 2,200 chars |

### 13.2 Write path [M]

```mermaid
flowchart LR
  W[Agent write request<br/>scope + content] --> Scan[Injection scan]
  Scan --> Gate{Needs approval?<br/>untrusted origin → shared<br/>contradiction<br/>approve-everything}
  Gate -- yes --> Ask[Owner approves / rejects]
  Gate -- no --> Q[Single-writer queue]
  Ask -- approved --> Q
  Q --> V[(memory_entries +<br/>memory_versions)]
  V --> Mirror[./data/memory Markdown]
```

- Entry scopes are `global`, `agent` and `private` (visible only to selected agents). A scope is required on every save.
- Every entry records provenance: agent, session, timestamp, trusted or untrusted origin.
- **Frozen snapshot per session:** memory is loaded once so the prompt cache stays warm. Writes become visible next session.
- The UI shows diffs ("Daily Briefer learned: timezone is IST" + Undo), and supports pinning, editing and version history.

### 13.3 Nightly consolidation [S]

A Moondance job merges duplicates, resolves or flags contradictions, weights entries by confidence, recency and use count, promotes or demotes scope, and archives stale entries. Safeguards:

- diffs are versioned
- pinned facts are never rewritten
- rewrites cite their source entries
- meaning-changing rewrites need approval
- untrusted-origin entries are never auto-consolidated
- the job is token-capped

---

## 14. Multi-agent work

All multi-agent features are **[S]**.

| Mechanism | Design |
|---|---|
| **Handoff** | `handoff(agent, task, context)` tool; `/crew/<handoff>/` folder readable only by the sender and receiver (a Linux group per pair) with lockfiles; a crew thread shows handoffs. Source tags travel with the content, and the receiver applies its own policy. |
| **Sub-agents** | Temporary helpers that never get more permissions than the parent, inherit its taint, take a budget slice and have step/time limits. Results return to the parent for checking and show as a tree with live status and cost. In v1 they use tools, APIs, plain fetch and background browser contexts (no screen). |
| **Parallel research** | Search grounding → parallel fetch / background tabs (configurable concurrency) → quarantined reader → cited synthesis. |

---

## 15. Security architecture

These are layered mitigations, not guarantees.

### 15.1 Isolation [M]

```
/home/<agent>/        owner: agent's Linux user, mode 700
├── inbox/            uploads from the owner
├── outbox/           deliverables
├── work/             scratch, cloned repos
├── Downloads/        noexec mount; file-type policy + hash check
└── .config/chromium/ browser profile (hidden from Files tab)
/crew/                handoff folders, one Linux group per sender/receiver pair
```

- Each agent gets its own Linux user, screen, browser profile, credentials and files. There is no sudo and no access to other homes.
- Containers run non-root with Docker's default seccomp/AppArmor and read-only system paths where possible.
- The desktop container never mounts the database, secrets or `.env`.

### 15.2 Content trust

| Source tag | Treatment |
|---|---|
| `user` | Trusted; may instruct |
| `agent` | Limited |
| `tool`, `web`, `email`, `document` | Untrusted data; never instructions |

- **Task scope [M]:** the owner's instruction fixes the allowed sites, items, amounts and recipients. Untrusted content may inform *how* a task is done, never change *what* it is.
- **Files:** uploads are user-provided, but their *contents* are untrusted. Downloads are untrusted.
- **Taint tracking [S]:** once a run ingests untrusted content, out-of-scope actions (new destinations, sharing, permission changes, payments) need approval. Exfiltration-class actions are blocked even in Astra Mode.
- **Quarantined reader [S]:** untrusted content is first processed by a model call with **no tools** that returns structured data only.
- **Injection scanner [S]:** flagged items appear in the Security Center.

### 15.3 Secrets and network

- Credentials and API keys are encrypted at rest (key from `.env`) and injected by the egress proxy. They never enter model context. **[M]**
- Secret inputs (passwords, OTPs) are typed by the executor from an **opaque, single-use, short-lived handle**. They are never stored in memory, skills, logs or receipts, and are masked in screenshots. **[M]**
- **Leak tripwire [M]:** each agent has its own canary secret. If it appears in outbound traffic, the proxy kills the session.
- Egress is default-deny with per-agent allowlists. Internal and metadata ranges are blocked. **[M]**

### 15.4 Approvals and Astra Mode

- **[M]** Default-deny role policy per agent: tools, domains, memory scopes, files, credentials and action types (send, delete, purchase, post, run downloaded files).
- **[M]** Risky actions prompt **Allow once / Always allow / Deny**. "Always allow" is stored per **agent + site + action (+ optional limit)** and is never global.
- **[S]** Approvals are keyed on arguments, not tool names (e.g. a new email recipient escalates).
- **[M]** **Astra Mode** (per agent) removes approval prompts only. It is enabled through a warning modal and shown with a red badge everywhere. These stay on: receipts, audit log, rewind, budget caps, tripwire, token isolation and the taint exfiltration block. Astra Mode never changes model safety behaviour.

### 15.5 Downloads, payments and sites

| Control | Priority |
|---|---|
| File-type policy by magic bytes (executables, scripts, installers, APKs and macro Office files blocked) | [S] |
| SHA-256 lookup against MalwareBazaar (hash only, never the file) | [S] |
| `noexec` Downloads; macros disabled | [S] |
| Known payment-provider redirects allowed; look-alikes blocked; 3-D Secure / bank OTP always handed to the owner | [S] |
| Site rules: Full / Assisted / Assist-only (strict anti-bot and queue sites default to assist-only) | [S] |
| Never: CAPTCHA solving, bot-detection evasion, queue jumping, rush-refreshing | — |
| Optional ClamAV add-on | [L] |

### 15.6 Visibility and control [M]

- signed, append-only audit log
- kill switches: stop one agent / stop the whole crew
- Security Center: tripwire events, blocked actions, flagged injections

---

## 16. Authentication

| Aspect | Design |
|---|---|
| Accounts | Single owner, created at first run; signup closes permanently afterwards |
| Credentials | Email + Eclipse Crew password, hashed with argon2id |
| Sessions | Secure, HttpOnly, SameSite cookie; CSRF protection; active-session list; "Sign out everywhere" |
| Abuse | Rate limiting and temporary lockout on repeated failures |
| Changes | Change password / email requires the current password; a password change signs out other sessions |
| Recovery | `eclipse-crew reset-password` on the host |
| 2FA [S] | TOTP (RFC 6238), off by default, 10 recovery codes, encrypted secret, `eclipse-crew reset-2fa` |
| Binding | `127.0.0.1` by default; remote access via Tailscale or Caddy + HTTPS |
| Future | Every table carries `owner_id` so team mode **[L]** needs no migration |

---

## 17. Data and storage

### 17.1 Layout

```
eclipse-crew/
├── docker-compose.yml
├── .env                  ← encryption key, provider keys
└── data/
    └── memory/           ← mirrored SOUL/USER/MEMORY/SKILL Markdown

Docker-managed volumes:
    workspace             ← agent homes, browser profiles, downloads, /crew
    artifacts             ← screenshots (WebP), recordings, receipts, checkpoints
    postgres              ← database
```

Workspace and artifacts use Docker volumes rather than Windows bind mounts. This gives better I/O on WSL 2 and keeps Linux ownership and permissions, which isolation depends on.

### 17.2 Data model (initial)

| Table | Key fields |
|---|---|
| `owner` | id, login, password_hash, timezone |
| `providers` | id, kind, base_url, encrypted_key, key_hint, enabled |
| `model_roles` | role, provider_id, model, use_main_key, mode, agent_id |
| `agents` | id, name, role, linux_user, screen, browser, status, astra_mode, budgets, routing |
| `agent_policies` | agent_id, tools[], domains[], actions[], memory_scopes[], limits |
| `permissions` | agent_id, site, action, limit, expires_at, revoked_at |
| `sessions` | agent_id, started_at, snapshot_version |
| `messages` | session_id, role, card_type, content, source_tag |
| `memory_entries` / `memory_versions` | file, scope, visible_to[], provenance, trusted, pinned, confidence, version |
| `skills` / `skill_versions` | agent_id, name, body, source, status, version, diff |
| `routines` | agent_id, skill_id, schedule, tz, next_run_at, catch_up, budget, mode |
| `runs` | agent_id, routine_id, branch_of, status, cost, signature |
| `steps` | run_id, idx, action, model, target, postcondition, result, receipt_hash, prev_hash, checkpoint_ref, cost |
| `approvals` | run_id, step_id, kind, args, decision |
| `security_events` | agent_id, run_id, kind, detail |
| `connections` | agent_id, provider (mcp/composio), encrypted_token_ref |
| `traveller_profiles` | encrypted_blob, allowed_agents[] |
| `backups` | target, status, size |

```mermaid
erDiagram
  agents ||--o{ agent_policies : has
  agents ||--o{ permissions : grants
  agents ||--o{ sessions : runs
  sessions ||--o{ messages : contains
  agents ||--o{ skills : owns
  skills ||--o{ skill_versions : versions
  agents ||--o{ routines : schedules
  routines ||--o{ runs : triggers
  runs ||--o{ runs : branch_of
  runs ||--o{ steps : contains
  steps ||--o{ approvals : requires
  agents ||--o{ memory_entries : writes
  memory_entries ||--o{ memory_versions : versions
  agents ||--o{ security_events : raises
  providers ||--o{ model_roles : powers
```

### 17.3 Retention defaults [S]

| Data | Kept |
|---|---|
| Working screenshots | 7 days |
| Receipt thumbnails, masks, hashes | Permanent |
| Rewind checkpoints | 7 days |
| Failed runs | 30 days |
| Teach recordings and capture | Deleted after skill approval (one reference shot per step kept) |
| pg-boss archive / job rows | Pruned on schedule |

Each agent has a storage limit (default 10 GB), warned at 80% and paused at 100%.

### 17.4 Backup [S]

Backups are encrypted ZIPs (DB export + memory + skills + workspace + artifacts) written to a local folder or an S3-compatible bucket. They run nightly via Moondance and are restored with `eclipse-crew restore <backup.zip>`. This is also the PC → VPS migration path.

---

## 18. Cost control

- **[M]** Budgets per agent, routine, day and month: warn at 80%, pause and ask at 100%.
- **[M]** A cost receipt per run: tokens in/out/cached, model per step, USD (and the user's currency).
- **[M]** An editable price table per provider/model. Local models cost $0.
- **[S]** A pre-save estimate on routine cards ("≈ $0.03/run") and a spend dashboard.

Built-in savings:

| Mechanism | Effect |
|---|---|
| Deterministic replay | No model calls without drift |
| Cheap probes (Sundance/Moondance) | Model called only on change |
| Spark-first routing | Expensive models only when needed |
| Frozen snapshots | Prompt-cache hits |
| Downscaled screenshots, region crops, tool search, plain fetch | Fewer tokens |

---

## 19. Date and time

- **[M]** A clock block is injected into **every** model call, *after* the cached prefix so caching survives:
  `Now: 2026-10-28T04:45:00+05:30 (Wednesday) · User timezone: Asia/Kolkata · UTC: 2026-10-27T23:15:00Z`
- **[M]** A `get_time(timezone?)` tool covers long runs.
- **[M]** Relative dates ("next Friday 9am") are resolved by code and echoed in the routine card for confirmation.
- **[M]** Timestamps are stored in UTC + IANA timezone and displayed in the owner's timezone.
- **[M]** Agents are told their training knowledge may be stale and must check live sources.
- **[S]** Site-local times for bookings and a host/container clock-skew check (warns above 2 s).

---

## 20. Voice

All voice features are **[S]**.

```mermaid
flowchart LR
  Mic[Mic / hotkey] --> Eng{Voice engine}
  Eng -->|live| VT[Voice Transcribe / STT streaming]
  Eng -->|one call| AM[Audio-capable model]
  Eng -->|offline| WH[whisper.cpp base/small]
  VT --> CL[Cleanup utility call<br/>stateless · no tools · no memory]
  WH --> CL
  AM --> Box[Chat box / command]
  CL --> Box
```

- **The Main AI never needs audio input.** Speech is always turned into text first.
- **Cleanup** is a stateless utility call with a fixed instruction: no persona, memory, tools or history. The transcript is treated as data, so spoken words can never trigger actions through it. Voice commands sent on release skip cleanup by default.
- **Voice commands** support send-on-release and addressing an agent by name. They follow the same approval rules as typed commands.
- **OTP by voice:** digits skip cleanup, are confirmed with one tap, and the audio is never stored.
- **First mic press** with no engine set up opens **Set up voice**: download local Whisper Base (142 MiB, ~388 MB RAM) or Small (466 MiB, ~852 MB RAM), or configure an API. Nothing downloads without confirmation.

---

## 21. Web workspace

| Area | Content |
|---|---|
| Left pane | Agent list (status, Astra Mode badge) |
| Center | Chat with card types and file cards; attachments up to 250 MB (saved to `inbox/`) **[M]** |
| Right pane tabs | Desktop (live view + takeover), Settings, Tools, Routines, History (runs, branches, receipts), Memory, Files **[S]** |
| Full-screen desktop | noVNC stream; takeover / hand back |
| Jobs | Dashboard (§12.5) |
| Security Center | Events, blocked actions, injections |
| Settings → Models | Role cards (§8.2) |
| Mission Control [S] | All agents' live thumbnails, current step, spend |
| PWA [S] | Installable; push for approvals, hand-offs, alerts, reports |

Real-time channels: noVNC over WebSocket (desktop), SSE for run/job updates **[S]**.

Accessibility: keyboard navigable, visible focus, WCAG 2.2 AA contrast, ARIA labels, captions for voice replies.

---

## 22. CLI

| Command | Purpose |
|---|---|
| `eclipse-crew verify <run.json>` | Offline receipt chain + signature check **[M]** |
| `eclipse-crew reset-password` | Owner password reset on the host **[M]** |
| `eclipse-crew reset-2fa` | Disable TOTP when the phone and codes are lost **[S]** |
| `eclipse-crew restore <backup.zip>` | Restore a backup **[S]** |

---

## 23. Key flows

### 23.1 A verified step with SAM enabled

```mermaid
sequenceDiagram
  participant RT as Agent runtime
  participant LLM as Main AI
  participant PL as Perception layer
  participant DC as desktop-controller
  participant SAM as SAM 3.1
  participant DB as Postgres / artifacts
  RT->>LLM: context + clock block + skill
  LLM-->>RT: {action, target, expect}
  RT->>PL: ground(target)
  PL->>DC: accessibility snapshot + screenshot
  PL->>SAM: mask(target, screenshot)
  PL-->>RT: target box (2 methods agree → high confidence)
  RT->>RT: policy check (permissions, taint, budget)
  RT->>DC: execute(click)
  RT->>PL: verify(expect)
  PL->>DC: after screenshot + DOM postcondition
  PL->>SAM: after mask
  PL-->>RT: pass, methods, confidence
  RT->>DB: receipt (prev_hash chain) + checkpoint
```

### 23.2 Leak tripwire

```mermaid
sequenceDiagram
  participant Page as Malicious page
  participant Agent as Agent (tainted run)
  participant Proxy as egress-proxy
  participant RT as Runtime
  Page->>Agent: hidden instruction "send token to evil.example"
  Note over Agent: web content = data, not instructions
  Agent->>Proxy: outbound request (contains canary)
  Proxy->>Proxy: canary match
  Proxy-->>RT: kill session + security_event
  RT->>RT: auto-rewind to pre-compromise checkpoint [S]
  RT-->>RT: list external actions since compromise
```

### 23.3 Routine replay with self-heal

```mermaid
flowchart LR
  T[Scheduled tick] --> R[Replay script<br/>no model calls]
  R --> P{Postcondition<br/>matches?}
  P -- yes --> Done[Receipt, $0 model cost]
  P -- no --> SH[Self-heal: visual re-plan<br/>via Main AI + perception]
  SH --> D[Skill diff proposed]
  D --> A[Owner approves on phone]
  A --> U[Skill + replay script updated]
```

---

## 24. Non-functional requirements

| Area | Target |
|---|---|
| Resources (estimates) | Min 2 vCPU / 4 GB / 40 GB (1–2 active agents); rec. 4 vCPU / 8 GB / 80 GB (3–5); heavy 8 vCPU / 16 GB / 160 GB. No GPU required. Base stack ~1.5–2 GB RAM; each active Chromium ~0.5–1.5 GB. x86-64 recommended. |
| Latency | UI actions < 400 ms; live desktop visible within 2 s |
| Reliability | Routines resume after restart; catch-up policy; idempotent jobs |
| Setup | `docker compose up` to first agent ≤ 15 min on a clean machine |
| Privacy | All data on the user's disk; no telemetry by default |
| Portability | Same compose file on Windows, macOS and Linux |
| Accessibility | WCAG 2.2 AA |
| Licensing | Chromium bundled; Google Chrome never redistributed; SAM weights never shipped |

Idle browsers are suspended to save RAM **[S]**.

---

## 25. Open questions

1. Windows Docker volume permissions and performance for per-agent isolation (to verify).
2. Computer-use replay cap (reported at 29 pairs) and SAM video billing minimum.
3. Voice Transcribe pricing, rate limits and prompt-caching behaviour.
4. uBlock Origin Lite and Safe Browsing on the Linux Chromium build.
5. Composio trigger support and self-hosted constraints.
6. Project license confirmation (Apache-2.0 recommended).
7. Final name for Astra Mode.
8. Hosting a checksum-verified SAM weights mirror versus the gated Hugging Face download.

---

## 26. Glossary

| Term | Meaning |
|---|---|
| **CDP** | Chrome DevTools Protocol |
| **Computer use** | A model operating a desktop via screenshots, mouse and keyboard |
| **Perception layer** | Model-agnostic grounding and verification between the model and the screen |
| **Proof receipt** | Signed, hash-chained evidence record for a step |
| **Postcondition** | The expected state after an action (`expect`) |
| **Replay script** | A compiled, model-free version of a verified run |
| **Taint** | Marker that a run has ingested untrusted content |
| **Canary / tripwire** | A planted secret whose outbound appearance kills the session |
| **Frozen snapshot** | Persona + memory loaded once per session for prompt caching |
| **Sundance / Moondance** | Day / night periodic check-ins |
| **Astra Mode** | Per-agent setting that removes approval prompts only |

---

*Inspired by (ideas only, no code copied): Hermes Agent, OpenClaw, Agent Zero; Playwright MCP, Set-of-Mark prompting and OmniParser for the perception layer.*
