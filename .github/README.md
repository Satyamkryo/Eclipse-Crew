# Eclipse Crew

**Teammates you can trust.** Open-source, self-hosted AI agents that learn by watching you, prove every action, can be rewound, and only know what their job needs.

Eclipse Crew gives you a crew of named AI agents that share one Linux desktop with a real browser, terminal and files. It runs on your own PC or VPS with your own model API key. You watch every agent live in a web workspace and can take over the mouse and keyboard at any moment.

> **Status:** v1 hackathon build, pre-release. See [Project status](#project-status).
>
> **Hackathon judges:** the live URL and login are in the submission form. Start with [Try it live](#try-it-live).

---

## Why Eclipse Crew

| | |
|---|---|
| **Runs on your machine** | Your PC or VPS, one `docker compose up`. No telemetry. |
| **Any model** | Meta Muse models by default; any OpenAI-compatible or local model works too. |
| **Real isolation** | Each agent has its own Linux user, screen, browser profile, credentials and files, enforced by the OS. |
| **Proof** | Every step is verified and recorded in a signed receipt you can check offline. |
| **Undo** | Rewind any run to any step, correct it, and continue on a new branch. |

## The five standouts

1. **Learn a skill from video.** Record yourself doing a task in the agent's browser; it drafts a `SKILL.md` for you to approve.
2. **Proof receipts.** Each step is checked (page structure, pixel diff, OCR, optional SAM 3.1), hash-chained and signed. `verify` checks a run offline.
3. **Rewind and branch.** Roll a run back to step N, add a correction, continue without redoing earlier steps.
4. **Self-healing routines.** When a site changes, the agent finds the new path and proposes an update for you to approve.
5. **Isolation and leak tripwire.** Agents can't read each other's files or keys. A planted canary secret stops the agent if it ever tries to leave.

**Also included:** live desktop with takeover · routines with schedules and catch-up · Sundance/Moondance check-ins that only wake the agent when a page changes · model-free replay of verified runs · readable memory with undo · approvals (Allow once / Always allow / Deny) · Astra Mode · budgets and cost receipts · crew handoff · Mission Control · Security Center with kill switches · chat attachments · MCP, GitHub and Composio connections.

---

## How it works

```
Your browser ──► app        web UI, API, agent runtime, job workers
                  ├── postgres      all data + job queue
                  ├── desktop       one Linux user, screen and Chrome per agent, streamed live
                  └── egress-proxy  every outbound request: allowlists, key injection, tripwire
```

Every agent step runs the same loop: **plan → locate → check permissions and budget → act → verify → signed receipt + checkpoint.** The model never sees your API keys or passwords; the proxy injects them.

Full design: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

---

## Requirements

- **Docker** (Docker Desktop with WSL 2 on Windows; Docker Engine + Compose on Linux) and **Git**. Node.js 24 for the setup commands.
- **Hardware:** 2 vCPU / 4 GB RAM / 40 GB disk minimum; 4 vCPU / 8 GB recommended for 3–5 agents. No GPU needed. x86-64 and arm64.
- **A model** that supports **tool calling** (vision strongly recommended): a Meta Model API key, any OpenAI-compatible provider, or a local server such as Ollama.

---

## Quickstart

```bash
git clone <this repo> eclipse-crew && cd eclipse-crew
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

In `.env`, set `POSTGRES_BOOTSTRAP_PASSWORD`, `POSTGRES_APP_PASSWORD` and `POSTGRES_MIGRATOR_PASSWORD` to three different random values (32+ letters/digits), and use the app and migrator passwords in `DATABASE_URL` and `MIGRATION_DATABASE_URL`. Then:

```bash
npm ci
npm run encryption-key        # each of these fills in a secret in .env, never prints it
npm run desktop:secret
npm run egress:secret
npm run receipt-key
docker compose up -d --build
npm run db:provision
npm run db:migrate
```

Open **<http://127.0.0.1:3000>** (always this address, not `localhost`).

> **Back up `.env`.** Losing `ENCRYPTION_KEY` makes saved credentials unreadable; `RECEIPT_SIGNING_KEY` signs your receipts.

### First run

1. Create the owner account (signup closes afterwards; there is never a signup page).
2. Confirm your timezone. It's used for schedules and the clock every agent sees.
3. **Settings → Models:** add your Main AI provider and key.
4. **Create agent:** name, role, persona, allowed sites/actions and a daily/monthly budget.

**Extra accounts** (one isolated workspace each, e.g. for judges) come only from the host CLI — never from the web. Run these on the host, in the repo folder, with the stack up (they reach the app container themselves):

```sh
npm run account:create -- --login judge1@example.com < pw.txt
npm run account:list
npm run reset-password -- --login judge1@example.com < new-pw.txt
```

Each account signs in separately and starts empty; add its model key in Settings → Models. Passwords travel through private stdin only and are never logged.

---

## Deploy on a VPS

The same compose file runs on any Linux VPS so your crew works while your laptop is closed. The app only listens on `127.0.0.1:3000`; pick one way in:

- **Tailscale (recommended, private):** install Tailscale, enable MagicDNS + HTTPS, run `sudo tailscale serve --bg 3000`, open `https://<vps>.<tailnet>.ts.net`. Use `serve`, never `funnel`.
- **Caddy (public HTTPS):** point a domain at the VPS, `reverse_proxy 127.0.0.1:3000`, allow only 22/80/443 in `ufw`.
- **Quick check:** `ssh -L 3000:127.0.0.1:3000 user@server`.

> Never change the binding to `0.0.0.0` or publish Postgres, VNC or CDP ports. Docker-published ports bypass `ufw`.

---

## Try it live

The judges' instance is a throwaway install. **Don't enter real credentials or personal data.**

1. **Log in** with the details from the submission form.
2. **Pick an agent.** Its desktop streams live; press **Take over** to drive it yourself.
3. **Send a task**, e.g. "Download the October invoice." Steps appear live; risky ones ask for approval.
4. **History:** open the run for before/after screenshots and receipts. **Export** and verify it offline.
5. **Mission Control**, **Memory** and **Security Center** show runs, sourced facts, the audit log and kill switches.

Limits: one login per judge (separate isolated workspaces), runs stop if the app restarts, model calls are spend-capped, and agents hand CAPTCHAs/logins/OTPs to the owner rather than solving them. Put Caddy HTTPS in front for a public demo (see Deploy on a VPS).

---

## Using Eclipse Crew

The workspace has three panes: **Agents**, **Chat**, and a panel with **Desktop**, **Settings**, **Tools**, **Routines**, **History** and **Memory**.

| Feature | How to use it |
|---|---|
| **Chat** | Describe a task in plain language. Replies arrive as cards (message, question, routine, approval, file). Start with `@Name` to send to a teammate. |
| **Attachments** | Paperclip, drag-and-drop or paste. Documents, images, audio, video and text, up to **250 MB** each (`MAX_UPLOAD_MB`). Files land in the agent's `inbox/`; files it writes to `outbox/` appear as cards. |
| **Take over** | Desktop tab → **Take over** → **Hand back**. Nothing is recorded while you're in control. |
| **Teach a skill** | Take over → **Record** → do the task → **Stop** → **Generate skill** → **Approve**. Passwords and OTP fields are masked; capture pauses on login/CAPTCHA pages. |
| **Routines** | Ask in chat ("every weekday at 9am…"), confirm the card. **Schedules** shows upcoming runs; missed runs follow your catch-up choice. |
| **Check-ins** | Routines tab → **New check-in**: a page to watch, hours and an optional task. **Sundance** (day) alerts you in chat right away; **Moondance** (night) works quietly and sends one morning summary. The check itself uses no AI; the agent wakes only when the page changed. If the page needs a login, you take over once and sign in; later checks use the agent’s browser. |
| **Replay** | In History, **Save as replay** on a fully verified run. Replays make no model calls; if the site changed, the agent proposes a fix as a diff. |
| **Receipts** | History → run → **Export**, then `node scripts/eclipse-crew.mjs verify run-<id>.json`. Pin your key with `--key-id` (from `key-id`). |
| **Rewind** | History → step → **Rewind to here**, add a correction, **Create branch**. Restores agent state and files, not external side effects (sent emails, orders). |
| **Approvals** | Download/send/post/delete/purchase/submit pauses for **Allow once**, **Always allow** (per agent + site + action, 20/day) or **Deny**. |
| **Astra Mode** | Per-agent switch in Settings that skips approval prompts. Receipts, budgets, scope checks and the tripwire stay on. |
| **Memory** | `SOUL.md` (persona), `USER.md` (facts about you), `MEMORY.md` (agent notes). Every change is a diff with **Undo**; pin facts to protect them. |
| **Budgets** | Daily/monthly per agent; warns at 80%, pauses at 100%. Every run has a cost receipt. Edit rates in **Settings → Models**. |
| **Connections** | **Settings → Connections:** Connect GitHub, paste scoped tokens, add pinned MCP servers or Composio. Tokens are encrypted and injected by the proxy, never shown to the model. |
| **Security** | **Security Center** shows events and the signed audit log. **Stop agent** / **Stop crew** halt everything at once. |

---

## Models

| Role | Default | Notes |
|---|---|---|
| **Main AI** | Muse Spark (`muse-spark-1.3`) | Required. Any OpenAI-compatible endpoint or local server also works. |
| **Hard steps** (optional) | Muse Wonder (`muse-wonder-1.0`) | Used only in Auto routing; falls back to Spark. |
| **Vision precision** (optional) | SAM 3.1 (`sam-3.1`) | Off by default. Helps on canvas apps, maps and design tools. |

Keys are saved once, encrypted, and shown only as `••••1a2b`. Built-in prices are pre-filled for Meta models, local endpoints cost $0, and a hosted model with no price can't start a run.

> **Contributor mode** (`muse-spark-1.3-contributor`) is cheaper but Meta may use the data. It's opt-in only.

**Local models:** use `http://host.docker.internal:11434/v1` for Ollama or `:1234/v1` for LM Studio on the same PC. For a model on another machine, connect both over Tailscale; never expose the model port publicly.

---

## Running it safely

Protections are layered, but prompt injection is unsolved industry-wide. Treat these as mitigations:

- Keep the app on `127.0.0.1`; reach it through Tailscale or Caddy with HTTPS.
- Give each agent the fewest sites, tools and actions it needs. Prefer **Allow once** until a pattern is proven.
- Use scoped tokens (e.g. a GitHub token limited to chosen repos) and set a spend limit at your model provider too.
- Keep sensitive accounts on a separate agent that doesn't browse arbitrary sites.
- Keep `.env` private and backed up. Check the Security Center regularly.

Found a vulnerability? See [`docs/SECURITY.md`](../docs/SECURITY.md). Please don't open a public issue.

---

## Your data

Everything stays on your machine: `.env`, `data/memory/` (readable Markdown copy of memory), and Docker volumes for agent files, artifacts and the database. Only model calls, tools you connect and sites your agents visit leave the machine, all through the egress proxy.

Step screenshots and checkpoints auto-delete after 32 days; receipts and the audit log are kept permanently, so proof still verifies.

**Update:** `git pull && docker compose up -d --build`, then `npm run db:provision && npm run db:migrate`.

**Forgot password:** pipe a new one into `npm run reset-password -- --login <email>` on the host (it refuses command-line arguments). This signs out only that account's sessions.

---

## Troubleshooting

| Problem | Try |
|---|---|
| App doesn't load | `docker compose ps`, then `docker compose logs -f app` |
| Port 3000 in use | Change the host port in `docker-compose.yml`, keeping the `127.0.0.1:` prefix |
| Windows: slow or permission errors | Use Docker Desktop's WSL 2 backend; keep agent files in Docker volumes |
| Agent keeps asking for approval | The confidence gate is working. Enable SAM, use a vision model, or grant **Always allow** |
| "Receipt signing is not set up" | `npm run receipt-key`, then `docker compose up -d` |
| Agent paused: budget reached | Raise its budget or wait for the next period |
| Run says **Interrupted** | The app restarted mid-run. Press **Continue** to branch from the last checkpoint |
| `@Name` sends nothing | The name must match an active agent |
| `docker compose build` stops with `fs.read` / BuildKit policy | `docker build -f Dockerfile -t main-app .`, then `docker compose up -d --no-build app`. Don't relax the Docker policy |

---

## Project status

| Shipped in v1 | Next |
|---|---|
| Docker setup, owner login, agents, chat, live desktop + takeover | Files tab, phone app (PWA), one-command installer |
| Teach from video, receipts + verifier, rewind, self-healing, isolation + tripwire | Native desktop capture, video-model skill drafting |
| Routines, replay, Sundance/Moondance check-ins, Mission Control, Schedules | Webhooks, push notifications |
| Meta models, SAM 3.1, OpenAI-compatible providers, price table | Anthropic connector, local SAM, voice |
| Approvals, Astra Mode, budgets, egress allowlist, audit log, kill switches | 2FA, backups, booking assistant |

---

## Built during the hackathon

Built from scratch for the **Meta Global AI Developer Hackathon** (Oct 27 – Nov 4, 2026), track **Push the Frontier**, using Muse Spark and Muse Wonder for reasoning and computer use and SAM 3.1 for screen grounding and verification.

## License

Apache-2.0 (planned). The desktop image downloads Chrome for Testing from Google at build time under Google's terms; it is never redistributed, and the desktop image must not be published. SAM weights are never shipped.
