# Eclipse Crew

**Teammates you can trust.** Open-source, self-hosted AI agents that learn by watching you, prove every action, can be rewound, and only know what their job needs.

Eclipse Crew gives you a crew of named AI agents that share one Linux desktop with a real browser, terminal and files. It runs on your own PC or VPS with your own model API key. You watch every agent live in a web workspace and can take over the mouse and keyboard at any moment.

> **Status: pre-release, under active development.** Commands and screens below describe the intended v1 interface and may change as the code lands. Features marked *(coming)* are planned but not in the first release. See [Project status](#project-status).

---

## Contents

- [Why Eclipse Crew](#why-eclipse-crew)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quickstart (your own PC)](#quickstart-your-own-pc)
- [First-run setup](#first-run-setup)
- [Deploy on a VPS](#deploy-on-a-vps)
- [Models](#models)
- [Using Eclipse Crew](#using-eclipse-crew)
- [Running it safely](#running-it-safely)
- [Account and recovery](#account-and-recovery)
- [Backup, restore and migration](#backup-restore-and-migration)
- [Updating](#updating)
- [Your data](#your-data)
- [CLI reference](#cli-reference)
- [Troubleshooting](#troubleshooting)
- [Project status](#project-status)
- [Built during the hackathon](#built-during-the-hackathon)
- [Contributing, security and license](#contributing-security-and-license)

---

## Why Eclipse Crew

Hosted agent products run your bots on someone else's computer. Every bot often shares the same cookies, logins and files, and you can't easily see what they did or undo it. Eclipse Crew takes a different approach:

| | Eclipse Crew |
|---|---|
| **Where it runs** | Your PC or your VPS, with one `docker compose up` |
| **Which model** | Any provider. Meta Muse models are the default and best supported, but not required. Local models work too. |
| **Isolation** | Each agent has its own Linux user, screen, browser profile, credentials and files, enforced by the operating system |
| **Evidence** | Every step is verified and recorded in a signed receipt you can check offline |
| **Undo** | Rewind any run to any step, correct it, and continue on a new branch |
| **Your data** | Stays on your disk. Only calls to the model API and the tools you connect leave the machine. No telemetry. |

---

## Features

### The five standouts

1. **Learn a skill from video.** Record yourself doing a task on an agent's screen, optionally narrating as you go. The agent writes a reusable `SKILL.md` with steps and checks. This works on websites, canvas apps and desktop apps.
2. **Proof receipts.** Every action is located and then verified using page structure, pixel diff and OCR, plus optional SAM 3.1 pixel masks. Each step's evidence is hash-chained and signed, and `eclipse-crew verify` checks a run offline.
3. **Rewind and branch.** Roll a run back to step N, add a correction and continue without redoing earlier steps.
4. **Self-healing routines.** When a website changes and a check fails, the agent finds the new way through and proposes a skill update for you to approve.
5. **Isolation and leak tripwire.** Agents can't read each other's files, logins or keys. A planted canary secret kills the session if it ever tries to leave the machine.

### Everything else

- **Live desktop with takeover.** Watch any agent's screen and take control, then hand it back.
- **Routines** run once or on a daily, weekly, monthly or cron schedule, timezone- and DST-safe, with Run Now and catch-up for missed runs.
- **Deterministic replay.** A verified routine replays without calling the model, so a repeat run with no changes costs $0 in model fees.
- **Sundance / Moondance** *(coming)*: daytime and night-time check-ins that only wake the AI when something changed.
- **Memory you can read:** a persona (`SOUL.md`), shared facts about you (`USER.md`) and per-agent notes (`MEMORY.md`). Every change is shown as a diff you can undo.
- **Approvals and permissions:** Allow once / Always allow / Deny, scoped per agent, site and action.
- **Astra Mode:** a per-agent switch that removes approval prompts while keeping every other safety layer on.
- **Budgets:** per agent, routine, day and month, with a cost receipt for every run.
- **Jobs dashboard** for every run, retry and schedule.
- **Security Center** with kill switches.
- **Chat attachments and file cards**, plus a Files tab *(coming)*.
- **Tools:** MCP servers, and Composio with your own key *(coming)*.
- **Voice dictation and voice commands** *(coming)*, including fully offline with local Whisper.
- **Multi-agent handoffs, sub-agents and parallel research** *(coming)*.
- **Booking assistant** with per-site rules *(coming)*.
- **Installable phone app (PWA)** with push notifications *(coming)*.

---

## How it works

```
Your browser ──► app (web UI + API + agent runtime + job workers)
                  │
                  ├── postgres          all structured data + job queue
                  ├── desktop           Linux sandbox: one user, screen and Chromium per agent
                  │                     streamed to you live (noVNC)
                  └── egress-proxy      every outbound request: allowlists, key injection,
                                        leak tripwire, threat blocking
```

Each agent step goes through the same loop:

1. Plan the next action.
2. Locate the target on screen.
3. Check permissions and budget.
4. Act.
5. Verify the result.
6. Write a signed receipt and a checkpoint.

The model never handles your API keys or passwords; the proxy and executor inject them.

Full design: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

---

## Requirements

### Software

| OS | Install |
|---|---|
| Windows 10/11 | [Docker Desktop](https://docs.docker.com/desktop/) with the **WSL 2** backend, and [Git](https://git-scm.com/) |
| macOS | Docker Desktop and Git |
| Linux / VPS | Docker Engine with the Compose plugin, and Git |

### Hardware

These figures are estimates, to be confirmed by measurement.

| Tier | CPU / RAM / Disk | Active agents |
|---|---|---|
| Minimum | 2 vCPU / 4 GB / 40 GB | 1–2 |
| Recommended | 4 vCPU / 8 GB / 80 GB | 3–5 |
| Heavy | 8 vCPU / 16 GB / 160 GB | More |

- No GPU is needed. The base stack uses about 1.5–2 GB RAM, and each active browser about 0.5–1.5 GB.
- x86-64 is recommended. Apple Silicon support is community-tested.
- A GPU is only useful for optional local models or local SAM. See [Local models](#local-models).

### A model

You need an API key for one model provider (e.g. the Meta Model API), or a local model server such as Ollama. The model must support **tool calling**; **vision** is strongly recommended. See [Models](#models).

---

## Quickstart (your own PC)

> **Current development status:** Owner setup/login, account settings, agent management and the authenticated three-pane workspace shell are implemented. The desktop has isolated persistent graphical sessions, live noVNC viewing and takeover. Agents are created, edited, paused, resumed and deleted in the workspace with default-deny permissions, a `SOUL.md` persona and daily/monthly budgets. The agent runtime and model settings remain upcoming. The egress proxy is inert.

To run the local app, use Node.js 24, run `npm ci` and `npm run dev` from the project root, and open `http://127.0.0.1:3000`. Authentication requires the configured private PostgreSQL service; the complete isolated setup below is provided by Compose. `dev` and `start` use the application's Node/Next WebSocket entry point and bind to localhost; do not replace them with `next start` if desktop streaming is required.

The configuration tests run with `npm run test:config` and require Node.js 22.6 or newer for built-in TypeScript stripping.

PostgreSQL stays on Docker's private network. Provisioning creates separate application and migration roles; the application cannot change the schema or access migration metadata. Owner-scoped session and agent queries are implemented; later product tables remain future work.

**Run the current Compose skeleton on Windows:** Start Docker Desktop and create `.env` only if it doesn't already exist:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
```

In the private `.env` file, set `POSTGRES_BOOTSTRAP_PASSWORD`, `POSTGRES_APP_PASSWORD`, and `POSTGRES_MIGRATOR_PASSWORD` to three different, randomly generated values of at least 32 ASCII letters or digits. Use the app password in `DATABASE_URL` and the migration password in `MIGRATION_DATABASE_URL`; preserve the role names, `postgres` host and `eclipse` database shown in the example. Keep all three values safe. Generate the two server-only secrets without printing them, then run:

```powershell
npm run encryption-key
npm run desktop:secret
docker compose up -d --build
docker compose ps
npm run db:provision
npm run db:migrate
```

Preserve `ENCRYPTION_KEY` with backups: changing or losing it makes existing encrypted credentials unreadable. Keep `DESKTOP_CONTROL_SECRET` private too. `APP_ORIGIN` must exactly match the URL used in the browser, including scheme and port; the default is `http://127.0.0.1:3000`. Use this address consistently instead of switching to `localhost`. Configure the exact HTTPS origin for a TLS deployment.

Open `http://127.0.0.1:3000` and complete owner setup. To stop the containers while retaining their volumes, run `docker compose down`. The provisioning command checks the existing database and can be repeated; it supports the original owner schema and sessions schema plus the singleton-owner migration, preserving rows and existing LF/CRLF history. It refuses unknown state, multiple legacy owners or mismatched credentials and never deletes an account to repair a conflict. It does not rotate passwords. For an existing project volume, retain the original bootstrap password, back up the volume first, and supply the same role credentials on every run. If preflight refuses the volume, investigate the conflict instead of resetting it. Compose and the commands use shell settings in preference to `.env`; restart Compose after changing settings so its mounted secrets match. `.env` is ignored by Git and excluded from the build context.

New artifacts volumes are writable by the app's non-root user. If an older installation reports permission denied under `/var/eclipse/artifacts`, back up its artifacts volume and run the following from the same Compose project:

```powershell
docker compose stop app
npm run artifacts:repair
docker compose start app
```

The repair command refuses a running app, bind mounts, custom volume-driver options or mismatched project labels. Its temporary maintenance container has only the artifacts volume, no network or credentials, and preserves file contents and permission modes. It does not follow symlinks outside the volume. Do not substitute a host directory or reset a volume to fix permissions.

Pages render on each request so Next.js scripts receive fresh CSP nonces. Production responses, redirects and errors include security headers. Localhost remains HTTP; production HSTS follows the configured HTTPS `APP_ORIGIN`, never a caller-supplied forwarding header. Keep ingress's forwarding-header overwrite in place and configure the exact origin for a TLS deployment. Provisioning accepts supported LF/CRLF migration variants without rewriting stored history; `.gitattributes` enforces LF for future migration checkouts.

Regression checks: `npm run test:db-client` tests retry recovery; `npm run test:db-roles` checks database privileges and LF/CRLF upgrades; `npm run test:http-security` checks the five-service stack, CSP and artifacts repair using disposable resources. These checks do not require access to personal browsers.

The pinned noVNC 1.6.0 npm artifact has a CommonJS/top-level-await packaging incompatibility. `npm run dev` and `npm run build` automatically run `scripts/prepare-novnc.mjs`, which checks the package version and exact upstream file hash before normalizing only its browser utility module to ESM. It preserves the awaited feature probe and refuses unexpected bytes. `npm run test:novnc-compat` verifies that compatibility step; `npm run test:rfb-bridge` verifies the private view-only protocol.

**TASK-010 desktop image:** `docker compose build desktop` builds the pinned Ubuntu toolchain. The approved lock contains 379 exact Ubuntu archives, verified by byte count/SHA256 before offline installation with networking disabled. Node 24.22.2, upstream Chromium 159.0.8134.0 (snapshot 1731633) and playwright-core 1.64.1 are separately pinned. The upstream browser is a development snapshot; updates require deliberate pinning and revalidation. No Chrome-for-Testing installer is used. The desktop now uses the owner-approved ADR-026 trusted setup role described below, with read-only root, bounded temporary storage and no published ports. Per-agent sessions are available through local administration; the agent runtime remains under development.

`npm run test:desktop-image` runs offline guards and the disposable build/smoke, saving bounded evidence under ignored `data/spikes/task-010/<uuid>/`. Tool inventory, Compose health, Xauthority/Openbox, accepted/rejected VNC authentication, noVNC WebSocket and PNG/video checks pass. TASK-010 is complete: run c66f0dda-e890-428b-8f58-a1df20c978fa verifies genuine Playwright/xdotool clicks in graphical Chromium and confirms its namespace/PID/network and Seccomp-BPF sandboxes active. The desktop-only ADR-025 profile is pinned to the upstream Playwright policy plus Chromium’s required namespace-local chroot; the ordinary container process is still denied chroot. Run Compose from the project checkout so it can load docker/desktop/seccomp_profile.json. Keep this checked-in profile, cap-drop ALL and no-new-privileges; do not use seccomp=unconfined or --no-sandbox. The five-service `test:http-security` regression passes. No model calls or personal-browser data are used.

**TASK-011 agent identities:** Build and start the desktop with your configured Compose environment: `docker compose build desktop`, then `docker compose up -d desktop`. The owner CLI works from this checkout and accepts canonical lowercase UUIDs. Use the actual Compose project name when it differs from the directory name:

```bash
npm run desktop:agent -- create --owner 11111111-1111-4111-8111-111111111111 --agent aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --project main
npm run desktop:agent -- inspect --owner 11111111-1111-4111-8111-111111111111 --agent aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --project main
npm run desktop:agent -- exec --owner 11111111-1111-4111-8111-111111111111 --agent aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --project main -- id
```

These are trusted local owner operations using Docker authority for infrastructure administration; product agents are created and managed in the workspace. Creation is idempotent and keeps UID/GID and files. Homes at `/workspace/homes/<agent-uuid>`, their inbox/outbox/work/profile directories and canonical Downloads are agent-owned mode 700 on the workspace volume. The home Downloads alias points to `/downloads/<agent-uuid>`; a changed alias is refused. Future browser sessions must use the canonical path. Downloads has kernel `noexec,nosuid,nodev`; the executable backing store is hidden behind root-only infrastructure. This stops direct execution, not interpreters or copying files elsewhere. Stale provisioning locks, conflicting paths/ownership and corrupt state stop safely; inspect those before recovery rather than deleting data or changing permissions broadly.

ADR-026 grants trusted setup only CHOWN/DAC_OVERRIDE/SETUID/SETGID/SETPCAP/SYS_ADMIN. The reduced PID 1 and administration entry points permanently remove SYS_ADMIN and apply an inherited syscall filter before normal operation. The trusted supervisor retains the other five capabilities and can access agent data; every agent command has zero capability sets, no supplementary groups and no-new-privileges. Keep the checked-in seccomp profile. Unsupported mount/capability behavior fails closed. `npm run test:agent-users` verifies real two-agent denials, concurrency, Downloads execution denial and recreation persistence in a disposable project; bounded private evidence is under ignored `data/spikes/task-011/<uuid>/`. No model calls or personal profiles are used.

**TASK-012 sessions:** after creating an identity, use these trusted local commands with the same owner/agent UUIDs:

```bash
npm run desktop:agent -- session-start --owner 11111111-1111-4111-8111-111111111111 --agent aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --project main
npm run desktop:agent -- session-status --owner 11111111-1111-4111-8111-111111111111 --agent aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --project main
npm run desktop:agent -- session-stop --owner 11111111-1111-4111-8111-111111111111 --agent aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --project main
```

Each running session has its own authenticated Xvfb screen, Openbox window manager and sandboxed graphical Chromium profile. Repeat start/stop safely; stopping keeps the profile. Following container recreation, explicitly start the agent to reopen its saved profile. Browser control stays on private pipes inside the container; there is no CDP TCP endpoint to publish. Stale/conflicting locks fail safely unless ownership and staleness are verified. After logging in, open `/?agent=AGENT_UUID` to view an existing running agent owned by that account. UUIDs provisioned for a different/stub owner are not silently adopted. **Take over** enables clicks and keyboard text; **Hand back**, closing the view or disconnecting releases control. Agent input/capture is blocked during takeover. An uncertain operation stops the session; explicitly stop/start it before retrying. `npm run test:agent-sessions` and `npm run test:auth-desktop-e2e` use synthetic pages/accounts and disposable containers, with no model calls or personal browser profiles.

**TASK-009 volume feasibility spike:** Start Docker Desktop in Linux-container mode, then run `npm run test:volume-isolation` for offline guard tests and `npm run spike:volume-isolation` for the real disposable Docker fixture. The CLI recognizes the existing E-drive Docker installation on Windows, otherwise it uses Docker from PATH. No model calls, project `.env`, personal browser data or production volumes are used. The fixture uses the same pinned Ubuntu base as the desktop skeleton, two real Linux users and one fresh named volume; it tests own-file operations, cross-user denials, container-recreation persistence and three I/O rounds per user. Every workload has a 60-second deadline; the run budget is five minutes including reserved cleanup time.

Results are written exclusively to ignored `data/spikes/task-009/<uuid>/result.json`. Cleanup removes only exact run-labeled test resources after identity verification; it never prunes Docker resources. A refused cleanup reports the test resource names for review. Real run 68cb4301-90ea-4b9d-b191-3d91327f7447 passed 40 cross-user denials and six I/O rounds, then removed its fixture resources. Small-file cycles took 2.8–2.9 seconds; sequential writes including fdatasync measured 416–592 MiB/s. Cached read rates and shell-command overhead are reported separately; there is no production SLA or bind-mount comparison. This verifies the filesystem feasibility spike; the production desktop and full agent isolation are still being built.

**TASK-007 developer screenshot probe:** The CLI implements a bounded read-only native observation exchange using an owner-selected static PNG. Offline tests cover both turns; the latest live invocation stopped at stateless replay validation before image submission or a second request, so TASK-007 remains open. Earlier correct-click proof had a pending review flag. No browser capture, input execution or acknowledgement occurred. The owner selected muse-spark-1.3-contributor; Contributor training terms apply even with store:false. See [Meta's pricing modes](https://dev.meta.ai/docs/pricing-rate-limits) and [computer-use guide](https://dev.meta.ai/docs/computer-use).

Set `MODEL_API_KEY` privately in ignored `.env.local` or your shell. Never paste it into chat, pass it as a command-line argument, or add it to a `NEXT_PUBLIC_*` setting. Save a PNG showing only the placeholder page, with no browser chrome, logins, OTPs or personal information. The PNG must be at most 5 MiB and 4096 pixels per side. Then run from the project root:

```powershell
npm run test:meta-computer-use
npm run spike:meta-computer-use -- --screenshot "E:\Eclipse Crew\Test\placeholder.png" --live
```

Each explicit live invocation makes at most two protocol requests to the fixed endpoint, with no redirects or retries: a text-only screenshot request, then one PNG observation followed by a click proposal. Limits are minimal reasoning, 512 output tokens per request (1024 total, including reasoning), 30 seconds per request and 45 seconds overall. Genuine stateless replay receipts are preserved unchanged in memory; absent/malformed replay data stops the probe. Numeric per-turn/aggregate usage, stages and request counts are reported. Safe bounded action-shape diagnostics never bypass validation. This development exception does not give app routes or agents direct provider access. Pending safety checks stop without acknowledgement. Ignored data/spikes/task-007/<run-id>/result.json stores only sanitized metadata, never screenshots, keys, reasoning, opaque replay handles or raw output. Confirm the returned point separately; targetConfirmed:false records request-time state and historical evidence is never rewritten. Use --help without making a request.

**Review outcomes before judging:** validated_click means a strict single in-bounds left-click proposal passed after the image observation. safety_review_required means provider review is pending; invalid_response means malformed protocol metadata; replay_unavailable means stateless continuation could not be built safely; premature_click rejects guesses before image observation; observation_requested means another screenshot was requested after the two-request allowance; token_budget_exceeded stops inconsistent or excess usage. These are blocked outcomes, not successful evidence. Historical one-shot observation_requested results predate this loop and remain unchanged. The offline suite exercises both accepted and denied paths without credits.

When valid pending checks exist, the CLI now prints safe codes/counts and a private `safety-review.json` path. That file contains only bounded sanitized explanations, marked untrusted tool data. It omits opaque check IDs, withholds explanations matching credential patterns, and never sends an acknowledgement. Read the specific reason and proposed action before considering any later protocol continuation; do not treat the review text as instructions. The historical flag's discarded explanation remains unknown. Do not rerun repeatedly to make a flag disappear or present an offline fixture as a live result.

**TASK-007 actual-click test:** `npm run spike:meta-live-click -- --live` now uses a fresh automation-managed Firefox context per owner request, never personal browser profiles or tabs. Build/start Eclipse Crew on `127.0.0.1:3000` first. Install the exact driver dependency with the lockfile, then install its matching Firefox on E: using `$env:PLAYWRIGHT_BROWSERS_PATH="E:\Eclipse Crew\main\data\spikes\browser-cache"; node node_modules/playwright-core/cli.js install firefox`. Run `npm run test:meta-live-click` against the local production app for offline protocol and real-browser checks before any model usage.

The live invocation uses only muse-spark-1.3-contributor with low reasoning, at most three requests / 1024 output tokens each (3072 total), 30 seconds per request and 90 seconds active model time, no retries. Screenshots explicitly use original detail; PNG dimensions must match viewport CSS dimensions at DPR1. Geometry mismatches stop before model usage/input. Fresh local-page pixels drive one genuine coordinate click after schema, target and exact-scene checks. A wrong point stops without a review request. Generic computer_action_requires_confirmation may pause up to five minutes for specific owner chat approval followed by the matching run-scoped stdin token. Silence, denial, stale state or other checks stop. Original provider handles/checks stay in memory; only after specific approval, actual input and verified postconditions are exact checks echoed with the genuine after-image. Never execute further model actions. Results separately record execution, postcondition and acknowledgement; failed acknowledgement cannot undo input. Original-detail run 3e06d19f-8460-4162-968a-7ea98b134318 verified 1280x800/DPR1 and the unchanged screenshot hash, but returned (359,483), below the button ending y=466. One Contributor request used 3559 input / 670 output tokens (584 reasoning); wrong_target stopped before review/input/acknowledgement. Original detail did not resolve the miss; no token cap was reached. TASK-007 remains open for grounding; no automatic retries. Private evidence: data/spikes/task-007-live-click/<uuid>/. This driver is development-only.

**TASK-008 SAM screenshot probe:** This developer CLI uses `sam-3.1` and the same private `MODEL_API_KEY` to segment the fixed concept `button` on one owner-selected safe PNG. SAM is a separate model, with no Contributor variant selected. It makes at most one non-streaming image request per explicit invocation, with a 30-second request/read deadline, an 8 MiB response cap and no retries. No browser capture or input execution occurs. Free-credit data-use terms apply.

```powershell
npm run test:sam-screenshot
npm run spike:sam-screenshot -- --screenshot "E:\Eclipse Crew\Test\placeholder.png" --live
```

Results go under ignored `data/spikes/task-008/<run-id>/`: sanitized `result.json` and source-aligned monochrome mask PNGs, without source-image copies, credentials or raw provider text. `validated_masks` means geometry and real mask decoding passed; inspect those masks against the source before confirming the target. `no_matches` is a normal empty result; malformed, oversized and timeout results fail closed. The CLI prints safe stage/reason/schema/parser codes rather than arbitrary provider errors. SAM remains optional/off by default in the planned product; this spike does not implement its settings or perception adapter. Live TASK-008 verification passed on the approved placeholder PNG: one image request returned a valid mask covering View project status, confirmed by visual comparison. Evidence: `data/spikes/task-008/b91a98d6-8c75-408b-9b01-bfbba38c92b0/`. Token usage was reported as zero, which does not imply zero charge: SAM is billed per image. See [SAM documentation](https://dev.meta.ai/docs/sam/overview).

**Full-product quickstart (not yet available):** Current setup requires explicit database provisioning and migration, and the workspace uses **http://127.0.0.1:3000**. The previous one-command quickstart instructions are omitted until the full-product setup is available.

---

## First-run setup

The first visit to `http://127.0.0.1:3000` opens owner setup. It runs once. Current setup creates the owner and timezone; model setup, live agent replies, chat attachments and file cards remain upcoming.

1. **Create the owner account.** Enter your email and a new **Eclipse Crew password**, not your Gmail or other password. There's only one account per install, and signup closes after this step.
2. **Confirm your timezone.** It's detected from your browser and used for schedules and the clock every agent sees.
3. **Planned, not yet available:** Configure a model provider and save its key. See [Models](#models) for the planned settings.
4. **Create an agent.** Use **Create agent** in the Agents pane and give it a name, role, persona, default-deny permissions and daily/monthly budgets. Starter templates remain planned.
5. **Planned, not yet available:** Receive live agent replies in chat while the agent works.

The signed-in workspace uses three panes: Agents, Chat and a tabbed panel. At tablet width the agent rail collapses and the panel opens as a sheet; on a phone, use the Agents, Chat and Panel buttons at the bottom. Create an agent to provision its isolated desktop, then select it to open the live screen or edit it under **Settings**. The Desktop tab shows the real live screen.

---

## Deploy on a VPS

The same compose file runs on a Linux VPS, so your crew keeps working while your laptop is closed.

### 1. Prepare the server

- Ubuntu 22.04/24.04 or similar, sized from [Requirements](#hardware).
- Attach a block-storage volume for data if your provider offers it, since screenshots and checkpoints grow over time.
- Install Docker Engine, the Compose plugin and Git, then follow [Quickstart](#quickstart-your-own-pc) steps 1–3 on the server.

The app listens on `127.0.0.1:3000` **only**. Nothing is reachable from the internet until you choose one of the options below.

### 2a. Remote access with Tailscale (recommended)

Tailscale puts your devices on a private network, so the app is never exposed to the public internet.

1. Install Tailscale on the VPS and sign in:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**.
3. Publish the app to your tailnet only:
   ```bash
   sudo tailscale serve --bg 3000
   ```
4. Install Tailscale on your laptop and phone with the same account, then open `https://<vps-name>.<your-tailnet>.ts.net`.

> Use `tailscale serve`, **not** `tailscale funnel`. Funnel makes the app public on the internet.

### 2b. Public HTTPS with Caddy (alternative)

Use this if you need a public URL, e.g. for webhooks from outside services.

1. Point a DNS record (e.g. `crew.example.com`) at the VPS.
2. Install Caddy on the host and set `/etc/caddy/Caddyfile`:
   ```caddyfile
   crew.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. Reload Caddy (`sudo systemctl reload caddy`). It obtains the HTTPS certificate automatically.
4. Allow only SSH and web traffic through the firewall:
   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 80/tcp     # HTTP → HTTPS redirect and certificate checks
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```
5. Turn on [two-factor login](#account-and-recovery) *(coming)*. A public URL means anyone can reach your login page.

> **Do not change the app's port binding from `127.0.0.1` to `0.0.0.0`.** Ports that Docker publishes bypass `ufw`, so the app would be exposed even with the firewall on. Never publish Postgres, VNC or CDP ports.

### 3. Move an existing install from PC to VPS

Back up on the PC, copy the backup and your `.env` to the VPS, then restore. See [Backup, restore and migration](#backup-restore-and-migration).

---

## Models

Eclipse Crew works with **any provider**. Meta Muse models are the default and best supported, **not mandatory**.

### What your model needs

| Capability | Needed? | Why |
|---|---|---|
| Tool calling | **Required** | Agents act through tools |
| Image input (vision) | Strongly recommended | Seeing the screen, verifying results |
| Built-in computer use | Nice to have | Better precision on hard screens |
| Video / audio / PDF input | Not required | Eclipse Crew converts these for your model |

Models without computer use still work. Eclipse Crew's perception layer locates targets from the page structure and numbered screenshot marks, so weaker setups ask you more often instead of misclicking. When you add a model, Eclipse Crew detects its capabilities and picks methods automatically.

### Model roles (Settings → Models)

Each job gets its own card, so you can mix providers:

| Role | Options | Required |
|---|---|---|
| **Main AI** (the brain) | Meta Model API, Anthropic *(coming)*, OpenAI, OpenRouter, Baseten, Custom/Local (Ollama, LM Studio, llama.cpp, vLLM), or any OpenAI-compatible or Anthropic-compatible *(coming)* endpoint | Yes |
| **Vision precision (SAM 3.1)** | Off · Meta API · Local NVIDIA GPU | No (Off by default) |
| **Voice** *(coming)* | Meta Voice Transcribe · any OpenAI-compatible transcription endpoint · an audio-capable model · local Whisper · Off | No |
| **Images** *(coming)* | Meta Muse Image · Off (initials) | No |
| **Background jobs** *(coming)* | Same as Main AI, or any provider (e.g. a local model) | No |

- **"Use the same key as Main AI"** is ticked by default whenever a role uses the same provider, so one Meta key can power Spark, SAM, Voice and Image.
- Keys are **saved once**, encrypted, and shown only as `••••1a2b` afterwards. They're never sent to the model.
- The **Test** button checks saved configuration and, once secure credential injection is connected, shows available models and latency. Until then it reports that live testing is unavailable rather than sending a saved key directly from the app.

### Typical setups

| Setup | Main AI | SAM | Keys needed |
|---|---|---|---|
| All Meta (default) | Muse Spark 1.3 | Meta API, "same key" ticked | 1 Meta key |
| Claude + Meta precision *(coming)* | Claude | Meta API | Anthropic + Meta |
| Claude + local precision *(coming)* | Claude | Local GPU | Anthropic |
| Fully local | Muse Glimmer via Ollama | Local GPU | None |
| Local brain + cloud precision | Muse Glimmer via Ollama | Meta API | Meta |
| Any model, no SAM | Any | Off | That provider's key |

### Meta models used

| Use | Model |
|---|---|
| Chat, planning, most steps | Muse Spark (`muse-spark-1.3`) |
| Hard computer-use steps | Muse Wonder (`muse-wonder-1.0`, preview; falls back to Spark) |
| Pixel-precise grounding and verification | SAM 3.1 (`sam-3.1`) |
| Speech to text | Muse Voice Transcribe (`muse-voice-transcribe-1.0`) |
| Agent avatars | Muse Image |
| Open weights / second provider | Muse Spark Open (e.g. on Baseten), Muse Glimmer (local) |
| Code changes for the Dev agent | Muse Code |

Prices are in Meta's [model docs](https://dev.meta.ai/docs/models). You can edit the price table under **Settings → Models** so cost receipts match your provider.

> **Contributor mode** (`muse-spark-1.3-contributor`) is much cheaper, but Meta may use the data to improve its products. It's an explicit opt-in setting and never on by default.

### Vision precision (SAM 3.1)

SAM is **optional**. Everyday websites work well without it. Turn it on for design tools, canvas apps, maps, games and desktop apps.

- **Meta API:** tick "same key" on the SAM card if your Main AI is Meta.
- **Local GPU** *(coming)*: needs an NVIDIA GPU with CUDA 12.6+. Start with the `local-vision` profile:
  ```bash
  docker compose --profile local-vision up -d
  ```
  On first use you'll accept Meta's SAM License on Hugging Face. The weights (3.50 GB) are downloaded to your machine and never shipped by us. Minimum VRAM hasn't been measured yet.

When SAM is off, receipts say so, e.g. *"Verified by: page structure + pixel diff (SAM off)"*.

### Local models

*(coming)* Any OpenAI-compatible server works as **Custom / Local**, with no API key needed.

| Server | Address to enter |
|---|---|
| Ollama on the same PC (outside Docker) | `http://host.docker.internal:11434/v1` |
| Ollama via the bundled container | `docker compose --profile local-ai up -d`, then `http://ollama:11434/v1` |
| LM Studio on the same PC | `http://host.docker.internal:1234/v1` |

Eclipse Crew auto-detects these when you open **Settings → Models**.

**Recommended local model: Muse Glimmer** (30B, Apache-2.0, text + image input, 128K context; official 4-bit build about 17 GB).
- It needs about 16 GB+ of GPU memory, or an Apple Silicon Mac with 32 GB+. CPU-only is very slow, and a typical VPS has no GPU.
- Glimmer has no built-in computer use, so it drives screens through the perception layer.
- Its quality on Eclipse Crew tasks hasn't been tested yet.

**Muse Spark Open** has open weights for multi-GPU servers, or you can use it through a hosted provider (Baseten, Fireworks, Together, OpenRouter, Modal, …).

Set an agent to **Local only** *(coming)* and it never sends content to a cloud model.

### Connect a model on another computer

| Setup | Tailscale needed? |
|---|---|
| Eclipse Crew and the model on the same PC | No, it's auto-detected |
| Eclipse Crew on a VPS, cloud model (Meta, Claude, …) | No |
| Eclipse Crew on a VPS, model on your home PC/Mac | **Yes** |

For the last case:

1. Install Tailscale on both machines with the same account.
2. On the model machine, make Ollama listen beyond localhost by setting `OLLAMA_HOST=0.0.0.0`, then restart Ollama. For LM Studio, enable **Serve on local network**.
3. In **Main AI → Custom/Local**, enter `http://<machine>.<your-tailnet>.ts.net:11434/v1`.

> Never open the model's port on your router or expose it publicly. Ollama has no password.

---

## Using Eclipse Crew

The workspace has three panes. The **left** pane lists your agents. The **center** pane is chat. The **right** pane has tabs: **Desktop**, **Settings**, **Tools**, **Routines**, **History**, **Memory** and **Files** *(coming)*. Every step shows which model did it.

### 1. Create an agent

1. Click **Create agent** in the left pane.
2. Pick a template or start blank. Templates *(coming)*: Daily Briefer, Inbox Triage, PR Reviewer, Research Analyst, Dev Agent, Travel & Booking Assistant.
3. Set the **name**, **role** and **persona** (`SOUL.md`, up to 2,000 characters: identity, tone, boundaries). Leaving it blank uses an editable role-based default.
4. Set **permissions**: allowed tools, websites, memory scopes and action types. Everything not listed is denied.
5. Set the required **daily and monthly USD budgets**. Enforcement and warnings arrive with the run/budget tasks.

Each agent gets its own Linux user, screen, browser profile and home folder. Select the agent and open **Settings** to edit it, **Pause agent** / **Resume agent**, or **Delete agent**. Deletion warns you to back up first and requires the exact agent name; it removes the user, browser profile, files, persona and permissions.

### 2. Chat with an agent

- Type a task in plain language: *"Find last month's invoices on the vendor portal and save them as PDFs."* Messages are stored per agent, and per-agent history remains available after a reload. The live agent runtime is not connected yet.
- When the runtime is connected, replies arrive as cards:
  - **message:** a normal reply.
  - **clarification:** the agent needs a missing detail.
  - **tool connection:** connect a tool inline.
  - **routine:** a schedule to confirm.
- **Attach files** *(coming)* by button, drag-and-drop or paste (images, PDF, Office, CSV/JSON, code, audio, video; up to 250 MB by default). They'll be saved to the agent's `inbox/`.
- Files the agent produces will appear as **file cards** *(coming)* with **Download**, **Show in Files** and **Open on the agent's desktop**.

### 3. Watch and take over

1. Open the **Desktop** tab, or click **Full screen**.
2. Click **Take over** to use the mouse and keyboard yourself. The agent pauses.
3. Click **Hand back**, and the agent resumes from where it was.

**Planned login handoff:** the agent runtime will stop at login walls, CAPTCHAs, one-time codes and payment checks and ask the owner. Current desktop primitives reject password/OTP text and fill targets; protected credential entry and the runtime handoff remain later work. Existing profile state persists across explicit session restarts. Agents never solve CAPTCHAs.

Nothing is recorded while you're in control, unless you press **Record** in teach mode.

### 4. Teach a skill from video

1. Open the agent's **Desktop**, click **Take over**, then **Record**.
2. Do the task once at a normal pace. Narrate if you like ("I'm filtering by last month because…").
3. Click **Stop**. Eclipse Crew captures the video, each click and keypress with its target, before/after screenshots and your narration. Passwords and codes are masked.
4. The agent drafts a `SKILL.md` with steps, inputs and the check for each step. Review it, edit if needed, and click **Approve**.
5. The skill is now callable in chat (*"Run the invoice skill"*) and schedulable.

The skill shows how it was learned, e.g. *"Learned from video + steps"*. After approval, the recording is deleted and one reference screenshot per step is kept.

> Tip: keep skills short and focused. Split long tasks into several skills.

### 5. Create a routine

1. In chat, describe the schedule: *"Every weekday at 9am, download new invoices and email me a summary."*
2. A **routine card** appears with the goal, skill, schedule, timezone, tools and budget. Relative dates are resolved and shown, so check them.
3. Choose the **catch-up policy** for missed runs: run once now, skip, or run all missed.
4. Click **Confirm**. Manage it later in the **Routines** tab.

- **Run Now** runs it immediately with live step status.
- After the first verified run, later runs **replay without the model**. The AI is only called if something on the page doesn't match.
- If the site changed, the agent **self-heals**: it finds the new path, finishes the step and shows a **skill diff**. Approve it to update the skill.

### 6. Sundance and Moondance *(coming)*

These are periodic check-ins with a cheap check first:

| | Sundance (day) | Moondance (night) |
|---|---|---|
| Hours (default) | 07:00–19:00 | 19:00–07:00 |
| Frequency | e.g. every 15 min | e.g. every 1–2 h |
| Alerts | Push right away | Morning report; urgent items still alert |

Each check compares a fingerprint (page hash, unread count, API status) without calling the AI. The agent wakes only when something changed. Intervals back off when things stay quiet. Configure hours, frequency and what counts as "urgent" in the agent's **Routines** tab.

### 7. Trigger routines from other apps *(coming)*

Each routine can get a webhook URL `POST /api/hooks/<id>` with a secret token. Call it from n8n, Make, GitHub or any service to start the routine. The URL has to be reachable by the caller, which usually means the Caddy setup on a VPS. Treat the token like a password.

### 8. Check proof receipts

1. Open **History** and pick a run.
2. Each step shows before/after thumbnails, the target (with the SAM highlight if enabled), the verification method, confidence, cost and pass/fail.
3. **Planned (TASK-030; not yet available):** Once the verifier is implemented, click **Export** to download `run.json` and verify it offline:
   ```bash
   docker compose exec app eclipse-crew verify /path/to/run.json
   ```
   A passing verification will mean no step was altered, removed or reordered since it was signed.

### 9. Rewind and branch

1. In **History**, open a run and click the step you want to return to.
2. Click **Rewind here**, add a correction ("use the March invoice, not February"), and **Continue**.
3. The run continues as a **new branch**. The original stays visible.

Rewind restores the agent's state and files. It **can't** undo things that already happened outside the machine, such as sent emails or placed orders.

### 10. Approvals and permissions

When an agent tries something risky (send, delete, purchase, post, a new site), you get a prompt:

- **Allow once:** just this time.
- **Always allow:** saved for this agent + site + action, optionally with a limit (e.g. purchases ≤ ₹4,000). It's never global.
- **Deny.**

Review, edit, set expiry or revoke saved permissions on the **Permissions** page *(coming)*.

### 11. Astra Mode

Astra Mode lets one agent act **without approval prompts**.

1. Open the agent's **Settings** and toggle **Astra Mode**.
2. Read the warning and click **Enable Astra Mode**. A red **ASTRA MODE** badge then appears on that agent everywhere.

These stay on even in Astra Mode: receipts, audit log, rewind, budget caps, leak tripwire and key isolation. A run that has read untrusted content still can't send data to destinations outside the task. Astra Mode never changes the model's own safety behaviour.

**When to use it:** for well-tested routines on sites you trust, with tight domain limits and a budget cap.
**When not to:** with payments, email to new recipients, trading, or any agent that reads untrusted content and also has access to sensitive accounts.

### 12. Memory

| File | What it holds | Scope |
|---|---|---|
| `SOUL.md` | The agent's persona | That agent |
| `USER.md` | Facts about you (name, timezone, preferences) | Whole crew |
| `MEMORY.md` | The agent's notes: environment, conventions, lessons | That agent |

- Every save has a scope: **global**, **agent** or **private** (only chosen agents).
- New memories show as diffs, e.g. *"Daily Briefer learned: timezone is IST"*, with **Undo**.
- **Pin** facts so they're never rewritten. Edit entries and view version history in the **Memory** tab.
- Anything learned from websites, emails or documents needs your approval before it enters shared memory.
- A Markdown copy is kept in `./data/memory` on the host, so you can read it with any editor.

### 13. Files

Each agent has its own home folder:

```
inbox/      files you give the agent
outbox/     what the agent produces for you
work/       its scratch space
Downloads/  alias to canonical noexec downloads (direct execution denied)
```

Use the **Files** tab *(coming)* to browse, preview, download, upload to `inbox/`, or **Open on the agent's desktop**. Risky download types (executables, installers, macro Office files) are blocked by default.

### 14. Tools and integrations

- **MCP servers:** add allowlisted MCP servers (e.g. GitHub, Slack, filesystem) in the **Tools** tab, then grant them per agent.
- **Composio** *(coming)*: paste your own Composio key to connect its app catalogue, with connected accounts per agent.
- Tool credentials are injected by the proxy and never shown to the model.

### 15. Budgets and costs

- Set budgets per agent, routine, day and month. You're warned at 80%, and the agent **pauses and asks** at 100%.
- Each run has a **cost receipt**: tokens in/out/cached, the model per step, and cost in USD.
- Routine cards show an estimate before saving *(coming)*, e.g. *"≈ $0.03/run, ≈ $0.90/month"*.
- Local models count as $0.

To keep costs down, let routines replay, use Spark for most steps, and use Sundance cheap checks instead of frequent full runs.

### 16. Jobs dashboard

**Workspace → Jobs** lists every routine run, check, webhook and background job with its status, agent, trigger, duration and cost.
- Open a run for its step timeline, receipts, errors and retry history.
- Actions: **Run now**, **Cancel**, **Retry**, **Pause/Resume** a routine.
- **Upcoming** shows the next scheduled runs in your local time.

### 17. Security Center and kill switches

- **Security Center** lists tripwire events, blocked actions and flagged prompt-injection attempts.
- **Stop agent** halts one agent immediately. **Stop crew** halts every agent.
- After a security event, the run can be rewound automatically *(coming)*, and you'll see every external action taken since the problem started.

### 18. Voice *(coming)*

- **Dictation:** hold the mic button (or the hotkey), speak, and release. Cleaned-up text lands in the chat box for review.
- **Voice commands:** turn on **Send on release**. Say the agent's name first ("Daily Briefer, summarise my inbox") to address a specific agent.
- **First use:** if no voice engine is set up, you'll be offered **local Whisper**, which is free, offline and runs on the CPU:
  - **Base:** 142 MiB download, about 388 MB RAM.
  - **Small:** 466 MiB download, about 852 MB RAM, more accurate.

  You can also pick a voice API in **Settings → Voice**. Nothing downloads without your confirmation.
- **Codes by voice:** spoken one-time codes are shown for one-tap confirmation, and the audio is never stored.

### 19. Multiple agents working together *(coming)*

- **Handoffs:** an agent passes a task and files to another through a private `/crew/` folder. The receiver applies its own permissions.
- **Sub-agents:** an agent spawns temporary helpers with a slice of its budget and never more permissions than itself.
- **Parallel research:** many sources are fetched at once and summarised with citations.

### 20. Booking assistant *(coming)*

Each site has a rule:

| Mode | The agent… |
|---|---|
| **Full** | Does everything up to payment verification |
| **Assisted** | Researches and fills forms, then stops at Book/Pay for you |
| **Assist-only** | Researches and prepares; you fill and book |

Sites with strict anti-bot rules or virtual queues default to **assist-only**. For flights, the agent re-confirms price and fare rules and runs a passport-name check before handing over payment. It never rush-refreshes, jumps queues or bypasses bot detection.

---

## Running it safely

Eclipse Crew includes layered protections, but **they are mitigations, not guarantees**. Prompt injection, where a webpage or email tries to trick an agent, is an unsolved problem across the industry. Use this checklist:

**Access**
- [ ] Keep the app bound to `127.0.0.1` (the default). Reach it remotely through Tailscale, or Caddy with HTTPS.
- [ ] Don't change the port binding to `0.0.0.0`, and never publish Postgres, VNC or CDP ports.
- [ ] Use a unique, strong Eclipse Crew password, and turn on two-factor login *(coming)* if the app is reachable from the internet.
- [ ] Sign out of sessions you don't recognise (**Settings → Account → Sign out everywhere**).

**Secrets**
- [ ] Keep `.env` private and backed up offline. Never commit it or paste it into chat.
- [ ] Give agents scoped tokens, e.g. a GitHub token limited to chosen repos, not your personal all-access token.
- [ ] Set a spend limit on your model provider's billing page as well as in Eclipse Crew.

**Agents**
- [ ] Start every agent with the fewest tools, sites and actions it needs, and add more as needed.
- [ ] Prefer **Allow once** until a pattern is proven, then use **Always allow** with a limit and an expiry.
- [ ] Keep sensitive accounts (bank, primary email) on a separate agent that doesn't browse arbitrary websites.
- [ ] Use **Astra Mode** only for tested routines on trusted sites, with domain limits and a budget cap.
- [ ] Set budgets on every agent and routine.

**Ongoing**
- [ ] Check the **Security Center** and review new memory diffs regularly.
- [ ] Keep backups (encrypted) and test a restore at least once.
- [ ] Keep Eclipse Crew updated.

Found a vulnerability? See [SECURITY.md](../docs/SECURITY.md). Please don't open a public issue.

---

## Account and recovery

| Task | How |
|---|---|
| Change password | **Settings → Account**. Needs your current password; signs out other sessions and keeps this one signed in. |
| Change email | **Settings → Account**. Needs your current password; no verification email is sent. |
| See / end sessions | **Settings → Account → Active sessions**, then **Sign out everywhere** to end every other session while keeping this one. |
| Turn on 2FA *(coming)* | **Settings → Account → Two-factor**: scan the QR code with an authenticator app (Google/Microsoft Authenticator, Authy, 2FAS, Aegis…) and save the 10 recovery codes |
| Forgot password | On the host: `npm run reset-password`, supplying the new password through private stdin as shown below. This revokes all owner sessions. |
| Lost phone and recovery codes *(coming)* | On the host: `docker compose exec app eclipse-crew reset-2fa` |

Password recovery verifies the current Compose app image and private database network and runs with the least-privilege application role. It refuses password command-line arguments. On PowerShell, use a hidden prompt without putting the password in command history:

```powershell
$resetSecret = Read-Host 'New Eclipse Crew password (8-128 characters)' -AsSecureString
$resetPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($resetSecret)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($resetPointer) | npm run reset-password
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($resetPointer)
  Remove-Variable resetPointer, resetSecret
}
```

Run from the project root with the existing private `.env` and Docker Desktop running. Recovery changes the password and invalidates the owner's sessions atomically. Two-factor recovery remains upcoming.

---

## Backup, restore and migration

*(coming)*

- **Backup:** **Settings → Backup** creates an encrypted ZIP containing the database, memory, skills, agent files and artifacts. Save it to a local folder or an S3-compatible bucket. Nightly backups can run automatically via Moondance. The UI shows when the last backup ran.
- **Restore:**
  ```bash
  docker compose exec app eclipse-crew restore /path/to/backup.zip
  ```
- **PC → VPS:**
  1. Make a backup on the PC.
  2. Install Eclipse Crew on the VPS, using the **same `.env`** (the encryption key must match).
  3. Copy the backup over and restore.
- **Export** run history and routines as JSON or Markdown from **History**.

---

## Updating

```bash
git pull
docker compose up -d --build
```

Database migrations are currently explicit: after starting the stack, run `npm run db:provision` and `npm run db:migrate`. Make a backup before major updates.

---

## Your data

Everything stays on your machine:

```
eclipse-crew/
├── .env                 encryption key and settings (keep private)
└── data/memory/         readable Markdown copy of memory and skills

Docker volumes:
    workspace            agent home folders, browser profiles, downloads
    artifacts            screenshots, recordings, receipts, checkpoints
    postgres             the database
```

**What leaves your machine:** only requests to the model provider(s) you configured, the tools you connected, and the websites your agents visit. All of it goes through the egress proxy. There's no telemetry.

**Default retention** (configurable):

| Data | Kept |
|---|---|
| Working screenshots | 7 days |
| Receipt thumbnails and hashes | Permanently |
| Rewind checkpoints | 7 days |
| Failed runs | 30 days |
| Teaching recordings | Deleted after skill approval; one reference shot per step kept |

You can delete any run or agent's data immediately from the UI. Each agent has a storage limit *(coming, default 10 GB)*.

---

## CLI reference

The implemented host commands run from the project root:

```bash
npm run reset-password       # new password through private stdin only
npm run desktop:agent -- --help
```

| Command | Purpose |
|---|---|
| `verify <run.json>` *(coming)* | Verify a run's receipt chain and signature offline |
| `npm run reset-password` | Reset the owner password and revoke owner sessions |
| `reset-2fa` | Turn off two-factor login *(coming)* |
| `restore <backup.zip>` | Restore a backup *(coming)* |

---

## Troubleshooting

| Problem | Try |
|---|---|
| `localhost:3000` doesn't load | `docker compose ps` to check all services are up; `docker compose logs -f app` for errors |
| Port 3000 already in use | Stop the other program, or change the host port in `docker-compose.yml` (keep the `127.0.0.1:` prefix) |
| Windows: slow or permission errors | Make sure Docker Desktop uses the **WSL 2** backend. Agent files live in Docker volumes by design; don't replace them with Windows folders. |
| **Test** fails for Ollama / LM Studio | Check the server is running and the address from [Local models](#local-models). On Linux, `host.docker.internal` needs the host-gateway mapping included in the compose file. |
| Model test says "no tool calling" | Pick a model that supports tool calling; it's the minimum for agents |
| Agent keeps asking for approval | That's the confidence gate working. Enable SAM, or use a model with vision or computer use, for better precision. Or grant **Always allow** with a limit. |
| Clicks land in the wrong place on canvas or desktop apps | Turn on **Vision precision (SAM 3.1)** |
| Routine didn't run while the PC was off | It runs according to its catch-up policy when the stack starts again. Use a VPS for always-on. |
| Agent paused: budget reached | Raise the budget in agent or routine settings, or wait for the next period |
| Wrong times in schedules | Check your timezone in **Settings → Account**. Schedules store the timezone, so DST changes are handled. |
| Forgot password | `docker compose exec app eclipse-crew reset-password` |

---

## Project status

| Area | v1 (hackathon build) | Coming next |
|---|---|---|
| Core | Docker setup, owner login, agents and personas, chat cards, live desktop + takeover | Templates, Mission Control, PWA, Files tab |
| Standouts | Teach from video, proof receipts + verifier, rewind and branch, self-healing, isolation + tripwire | Auto-rewind on security events |
| Routines | Schedules, Run Now, catch-up, deterministic replay, Jobs dashboard | Sundance/Moondance, webhooks, live dashboard updates |
| Models | Meta Model API, SAM 3.1 via API, role cards, saved keys, capability detection | Anthropic-compatible connector (Claude), local models, local SAM, model check, per-agent overrides |
| Safety | Permissions, approvals, Astra Mode, budgets, egress allowlist, key injection, audit log, kill switches | Taint tracking, quarantined reader, threat feeds, download scanning, 2FA |
| Other | Memory files with scopes and approval | Voice, multi-agent, booking assistant, backups, Composio |

---

## Built during the hackathon

Eclipse Crew was built from scratch during the **Meta Global AI Developer Hackathon** (Oct 27 – Nov 4, 2026), track **Push the Frontier**. It uses Meta models throughout: Muse Spark and Muse Wonder for reasoning and computer use, SAM 3.1 for screen grounding and verification, Muse Voice Transcribe for voice, Muse Image for avatars, Muse Spark Open via Baseten as a second provider, and Muse Code for the Dev agent.

---

## Contributing, security and license

- **Architecture:** [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- **Security policy and development security requirements:** [`docs/SECURITY.md`](../docs/SECURITY.md)
- **Contributing:** issues and pull requests are welcome. Read the contributor checklist in `docs/SECURITY.md` before submitting code.
- **License:** Apache-2.0 (planned; final confirmation pending). Chromium is bundled under its own license. Google Chrome is never redistributed. SAM weights are never shipped; they're downloaded on your machine under Meta's SAM License.
