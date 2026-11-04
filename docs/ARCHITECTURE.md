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

The target is one `docker compose up` on Windows (Docker Desktop / WSL 2), macOS and a Linux VPS. All services use `restart: unless-stopped`. ADR-024 adds a fixed-purpose localhost ingress to the four core services.

**Current build:** five services start after supplying database and controller credentials. `app` serves owner setup/login and an authenticated temporary desktop shell; `desktop` provides isolated persistent graphical sessions, authenticated controller operations and view-only RFB streaming; `egress-proxy` forwards only the app's model-provider requests (TASK-046). Separate internal database, desktop, ingress-to-app and app-to-proxy networks isolate the app, database and desktop; the ingress alone also has a frontend network for localhost publication. It accepts only the fixed app upstream. Disposable Docker Desktop tests verify the current auth/desktop stack on this machine; the full agent runtime and other platforms remain unverified.

Database provisioning is explicit and rejects unexpected existing roles, schemas, objects and migration history before changes. `eclipse_app` has only SELECT, INSERT and UPDATE on the current owner table; it cannot create schemas or temporary tables, escalate roles or access migration metadata. `eclipse_migrator` owns the project schema objects and has the database CREATE permission Drizzle requires. Future migrations must grant table privileges explicitly; no blanket mutation grants exist. The app receives only its runtime URL, while a short-lived helper runs migrations on the private database network with only its migration URL. Owner-scoped queries are a separate, unfinished data-access-layer responsibility.

```
┌──────────────────────────── Host (PC or VPS) ─────────────────────────────┐
│                                                                           │
│  ingress (localhost-only fixed reverse proxy → app)                       │
│                                                                           │
│  app (Next.js UI + API + agent runtime + pg-boss job workers)             │
│    ├─ talks to: postgres, desktop-controller, egress-proxy                │
│    └─ calls: Meta Model API / Baseten / user's providers (via proxy)      │
│                                                                           │
│  postgres (Docker-managed volume)                                         │
│    └─ pg-boss tables (job queue, schedules, archive)                      │
│                                                                           │
│  desktop (Linux sandbox, internal network only)                           │
│    ├─ Linux user per agent → Xvfb screen :N → Chrome profile            │
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

### Desktop-local mock vendor fixture (TASK-035)

`docker/desktop/mock-vendor/` is a synthetic external-site simulation, separate from the authenticated app. The owner starts/stops it through `scripts/mock-vendor.mjs`, which reuses guarded desktop administration to execute as the selected agent. Its detached Node process has that agent's UID, zero capabilities, no-new-privileges and a sanitized environment. It binds an ephemeral `127.0.0.1` port in its current namespace, adds no service/network/host port and holds no real credentials or database connection. Before TASK-071 production integration, loopback remains shared; the fixture is not cross-agent network isolation.

Source-controlled fixtures contain four fictional invoices and deterministic text PDFs. React/shadcn/Lucide markup and shared Tailwind tokens are generated into static assets before distribution; desktop needs no React runtime or installation-time asset build. Layout A (top navigation/table) and B (sidebar/cards) change targets and positions while retaining invoice data. Layout state is process-local and resets on restart. Same-origin, CSRF-protected POST controls change layout/reset; GET filtering is read-only. Private mode-600 lifecycle state under the agent's mode-700 `work/.mock-vendor` records PID/birth/UID and URL; stop validates the exact fixture process before signaling. Reset never deletes downloads. This supplies the demo target, not the teach/replay/self-healing implementation.

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

A single Next.js deployment plus TypeScript worker processes. `scripts/app-server.mjs` owns the Node HTTP listener and the protected desktop WebSocket upgrade. It forwards normal HTTP requests into Next.js; it does not run a separate backend service. `APP_ORIGIN` is the exact public scheme, host and port (default `http://127.0.0.1:3000`).

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

An Ubuntu sandbox on the internal network only. TASK-010 builds from the approved exact-package/SHA256 lock (445 archives / 250231110 bytes on amd64), installs packages offline with networking disabled, and verifies pinned Node archive and Chrome for Testing archive plus image-local Playwright integrity. All required tool versions execute. ADR-026 now runs a trusted root bootstrap with six explicit capabilities for Downloads and account-view mounts, then permanently drops SYS_ADMIN and installs an inherited privileged-syscall filter before starting the supervisor. Its five retained capabilities support local provisioning and UID switching; agent processes have distinct UID/GID and zero capability sets. No-new-privileges, read-only root, bounded tmpfs, isolated networks and unpublished ports remain enforced. Run c66f0dda-e890-428b-8f58-a1df20c978fa verifies authenticated Xvfb/Openbox, VNC/WebSocket transport, PNG/video, and genuine Playwright/xdotool input in graphical Chrome. Chrome’s own status page confirms namespace/PID/network and Seccomp-BPF sandboxes active. ADR-025 applies a pinned Playwright-derived seccomp profile only to desktop, with the required namespace-local chroot adaptation; the kernel still denies ordinary outer-process chroot. TASK-010 is complete. The earlier snapshot-service outage is resolved by the owner-approved package lock.

The target toolchain contains Xvfb, a lightweight window manager, Chrome for Testing (pinned, downloaded from Google at build time and SHA-256 checked), `playwright-core`, xdotool, ffmpeg, x11vnc and noVNC/websockify. It also has a text editor, PDF viewer and image viewer; LibreOffice is an optional layer **[S]**.

| Per agent | |
|---|---|
| Linux user | Unique, no sudo, home mode `700` |
| Screen | Xvfb display `:(uid - 20000 + 100)`, authenticated and TCP-disabled |
| Browser | Persistent Chrome for Testing profile at `/workspace/homes/<agent-uuid>/.config/chrome-for-testing`; graphical session under its own UID |
| Desktop UI | tint2 dock (Browser focus, Files, Terminal, clock; auto-hidden), pcmanfm desktop folders (Home, Trash, Downloads, outbox, work), xterm in `work`; private session D-Bus |
| Speaker | Private PulseAudio null sink per session; monitor-only bounded capture; no host device, TCP listener or shared mixer |
| Stream | Private view-only x11vnc → authenticated controller RFB bridge → authenticated app WebSocket → noVNC canvas |

**Current TASK-011 administration:** `npm run desktop:agent -- <create|inspect|exec> --owner UUID --agent UUID [--project NAME] [-- COMMAND ARGS]` verifies the Compose desktop and named volume before invoking fixed local commands. A root-only infrastructure registry at `/workspace/.system/agents.json` assigns stable UIDs/GIDs 20000–59999, without replacing future Postgres product records. An exclusive lock serializes creation; pending assignments keep their UID during safe recovery, while conflicting state/stale locks fail closed. Runtime passwd/group files under root-only `/run/eclipse` are mounted read-only over `/etc/passwd` and `/etc/group`; new accounts append only through trusted administration. No password/sudo is enabled. Reduced Python PID 1 reaps children; no privileged init retains SYS_ADMIN.

**TASK-012 session lifecycle:** the reduced supervisor owns a local root-only Unix socket `/run/eclipse/sessions.sock` (parent mode 700, socket mode 600). Closed `session-start`, `session-status` and `session-stop` owner commands resolve existing identities, serialize per agent and launch a capability-free worker through `setpriv`. Each worker owns authenticated Xvfb, Openbox and a graphical Playwright persistent context. CDP uses inherited anonymous pipes; no debugging port or WebSocket endpoint is opened. Display cookies and browser handles never leave private worker memory/runtime files. Chromium and Playwright do not keep cookies without an expiry across a browser restart (microsoft/playwright#36139), so the worker snapshots them to `~/.config/chrome-for-testing/eclipse-session-cookies.json` (`docker/desktop/cookie-snapshot.mjs`) on close and every 30 s when they change, and restores them with `addCookies` right after launch; a bad snapshot is ignored and never blocks start.

**TASK-077 desktop polish:** the worker seeds only missing agent-local config (mode 700/600) before starting a private session D-Bus under the runtime directory; it has no servicedir, and `DBUS_SYSTEM_BUS_ADDRESS` is disabled. pcmanfm owns the desktop with Home, Trash, Downloads, outbox and work; File System and mounted-volume icons are hidden, and automount/autorun are off. A tint2 dock shows Browser, Files, Terminal and a clock and auto-hides so page coordinates stay usable. Its Browser launcher raises the managed browser by verified kernel PID and profile path, never by title or a second launch; Files opens the agent home; Terminal starts xterm in `work` as the agent UID in the same namespace. Fixed root-owned launchers are used; no arbitrary interpolation. Stop/crash reaps xterm, pcmanfm, tint2 and dbus for that UID after tracked children. Wallpaper is a solid surface colour until the owner supplies an asset.

**TASK-079 per-agent sound:** each graphical session starts one unprivileged PulseAudio daemon before Chrome, with a null sink, a Unix socket and a cookie under the mode-700 runtime, and no TCP listener, host device, shared mixer or anonymous auth. Chrome and ffmpeg receive only that session's `PULSE_SERVER`, cookie and sink. `audio.capture` records the sink monitor through bounded argv-only ffmpeg to a mode-600 temporary WAV, validates mono 24 kHz PCM16, caps 30 s / 2 MiB and deletes the file on every path; the controller gives capture its own timeout and a capture-abort frame stops it on takeover or stop. The app re-validates the WAV and sends it to the fixed Meta `muse-voice-transcribe-1.0` ASR route; the transcript is bounded untrusted `tool` text and the raw audio never reaches the model, receipts, checkpoints, logs, memory or outbox. One attempted-duration charge is reserved on the run's shared cost call index before dispatch; uncertain requests are never retried. Replay refuses hearing explicitly.

**TASK-078 Chrome for Testing:** the desktop downloads the exact pinned Google Chrome for Testing 156.0.8078.80 archive at image build time, verifies its byte count and SHA-256 against `browser-build.lock.json`, then extracts it to `/opt/chrome-for-testing`; it never resolves a moving channel. The amd64 row is 201329937 bytes / SHA-256 b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7 (disposable spike passed H.264/AAC decode, page-structure grounding, Playwright/xdotool clicks, screenshots, tabs, downloads, session-cookie restart and two isolated profiles). The archive is never committed, published or redistributed. Each agent uses a new mode-700 `.config/chrome-for-testing` profile; the old `.config/chromium` profile is preserved but not opened by the new browser. Sandbox, private-pipe CDP, proxy-only egress and cookie protections are unchanged.

**TASK-066 native ARM64 (code complete, native acceptance pending):** one `packages.txt` root list feeds two reviewed locks. `ubuntu-packages.lock.json` stays the pinned amd64 closure; `scripts/resolve-package-lock.mjs --arch arm64` runs `apt-get --print-uris` plus `apt-cache show` inside the pinned Ubuntu 24.04 base **on a native arm64 host**, joins SHA-256 from the same apt-verified metadata, allows only `ports.ubuntu.com`, and writes `ubuntu-packages.arm64.lock.json`. `fetch-packages.mjs` holds one host/count/bytes/hash row per CPU; an unmeasured or missing ARM row fails closed. The Docker build derives lock, Node URL/hash and browser URL/pin from `TARGETARCH`, writes `amd64`/`arm64` to `/opt/eclipse/desktop/image-arch`, and refuses other CPUs with a fixed message. Node arm64 is pinned at 30968168 bytes / SHA-256 eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8 from Node's signed `SHASUMS256.txt` (release key fingerprint 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356). The arm64 Chrome row is 200722708 bytes / SHA-256 1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724; the archive's `chrome-linux-arm64` directory is normalized to the existing `chrome-linux64` path. Bootstrap selects a per-ABI syscall table (x86-64 or aarch64), kills a foreign audit architecture, refuses x32 only on x86-64, and requires `image-arch` to match `platform.machine()`; `check-tools` performs the equivalent `process.arch` check. These are internal consistency checks, not emulation detection. Oracle native build/runtime acceptance and Apple Silicon remain unverified until the owner runs the recorded matrix.

Readiness requires the display, window manager, browser and authenticated VNC readiness. Component failure stops its session; other agents continue. Shutdown first closes the browser to flush profile state, then stops only tracked session processes; fallback uses the same UID and verified process birth identities, without CAP_KILL. Ambiguous profile/display locks are refused; proven-stale owned artifacts can be removed without following links. Container recreation retains profiles, while runtime directories and the socket are temporary; explicit start reopens an agent after recreation. Synthetic local tests cover these layers, not real credential workflows.

**Current desktop-controller (TASK-013–015):** HTTP and WebSocket require the service secret and the exact current `app` DNS peer address. DNS failure denies access. Owner IDs come from validated app sessions and are checked against the protected agent registry. Closed operation schemas cover full 1024×768 X-display screenshots/crops, xdotool click/type/key/scroll, and bounded Playwright page/locator operations. DOM results carry `source_tag: tool` and `untrusted: true`; actual password/OTP targets refuse text/fill operations. The worker has no arbitrary shell/evaluate/URL endpoint.

Lifecycle, control transitions and primitive dispatch share a bounded per-agent queue. Every dispatch rechecks owner, running state, UUID generation and takeover. A lease binds the owner session reference, viewer connection ID and generation. Disconnect releases only that viewer's lease; stop/restart closes viewers and invalidates old work. Timed-out/uncertain worker execution quarantines the session for explicit restart; it is never replayed automatically.

**Product agent lifecycle (TASK-019):** owner-scoped CRUD stores agents and default-deny policies in Postgres. Creation saves a paused row, provisions/starts the controller identity and then marks the agent active; desktop failure leaves a visible paused agent for retry. Pause stops the desktop but preserves its profile and files. Selecting an agent only reads controller status; starting a stopped desktop is an authenticated POST. Pause/resume/delete hold an owner-scoped row lock across the desktop call and required final database write so interleaving cannot orphan an identity; lock waits are capped at five seconds and the runtime pool has bounded size/connect timeout. A desktop action that succeeds before a failed final DB write leaves a retryable transient mismatch; it never reports success. Deletion first writes a root-only `deleting` registry tombstone so restart recovery skips a partially removed identity, then removes the exact UUID home/downloads, NSS account entries and registry record before deleting the owner-scoped database rows; process-scan uncertainty fails closed and registry writes use unique atomic temporary files. All desktop page/stream/takeover/input/handback routes require the owner-scoped database agent as well as the controller identity; registry-only identities are never adopted.

The app authenticates each upgrade through a fixed loopback session-validated route and revalidates within five seconds. The controller authenticates upstream VNC privately; noVNC receives RFB pixels with a separate None-security negotiation only after owner authentication. The view-only protocol accepts bounded format/encoding/framebuffer requests and rejects keyboard, pointer and clipboard events. Owner input uses separate session/Origin/CSRF-checked HTTP routes. Per-session VNC passwords never enter browser responses or public session status.

Managed-browser teach capture is implemented (§11.1); native desktop/terminal capture remains open (TASK-036). Checkpoints, proof receipts and the grounding loop are implemented (TASK-029/031/032); opaque credential entry remains later.

The desktop container mounts **only** the `workspace` volume. It never sees the database, `.env` or secrets.

### 4.4 `egress-proxy`

The single outbound path for the desktop and tools. **Current build (TASK-045/046):** one built-ins-only Node process (user 65534, read-only root, no published port) with two listeners. **4320** accepts the app's routes over the internal `egress_app` network and is authenticated with `EGRESS_PROXY_SECRET` (Bearer, constant-time compare); the desktop shares the `desktop` network and can reach the port, but never holds that secret: `POST /v1/forward` forwards a model-provider request and injects the saved key (`X-Eclipse-Credential`, used for one upstream call, never stored, logged or returned; a reflected key is replaced by `[redacted]`), `POST /v1/teach-asr` sends fixed-destination narration audio, and `POST /v1/policy` replaces one agent's allowlist. Forwarded targets are public `https` hostnames on 443; the proxy resolves DNS itself, refuses private, loopback, link-local, CGNAT, multicast, metadata and IPv4-mapped addresses, connects to the checked address, refuses redirects, and caps body (9 MiB), response (16 MiB), time (60 s) and concurrency (8). **4321** is the browser proxy on the internal `desktop` network: Chromium sends `CONNECT host:443` with `Basic` username = the agent UUID and password = `HMAC-SHA256(EGRESS_DESKTOP_SECRET, "v1:" + agentId)`. The proxy requires the host to be the agent's allowlist entry or a subdomain of it, resolves and pins the first checked address, and tunnels the TLS bytes without inspecting them. A plain `http://` GET/HEAD for an allowlisted host gets a `307` to the same path over HTTPS; plaintext is never forwarded. Entries are memory-only, expire after 120 s, are re-pushed every 60 s, and a changed or blocked push destroys that agent's open tunnels; limits are 64 tunnels per agent, 256 total, 10 s connect, 120 s idle and 30 min lifetime. The token reaches the worker over the supervisor's private pipe and is never in argv or an environment variable. Loopback is bypassed for the mock fixture and remains shared until TASK-071. The proxy never holds `ENCRYPTION_KEY` or a database connection. TASK-070 adds a third route on 4320, `POST /v1/tool-forward` (authenticated with `EGRESS_PROXY_SECRET`, agent id in `X-Eclipse-Agent`, target in `X-Eclipse-Target`, method in `X-Eclipse-Method`): it injects a saved connection token for that exact agent and host only, strips any client `Authorization`, scans target/query/body for the agent canary, redacts the token, its base64 and URL-encoded forms from the reply, keeps only `content-type`, `mcp-session-id` and `retry-after`, and never follows redirects. `POST /v1/credentials` replaces an agent's in-memory entry list (at most four exact hosts, bearer/basic/header); the `/v1/policy` reply carries a SHA-256 `credentialsVersion` so the app re-pushes only when the list changed. Entries are dropped when the agent is blocked, tripped, deleted or its policy expires. The app stores the token encrypted in `connections` and decrypts it only for that push; the proxy still has no encryption key and no database. MCP calls (TASK-072) and the git gateway (TASK-073) use this route; opaque `CONNECT` tunnels never receive a credential. TASK-088 adds `POST /v1/github-device` on 4320: a Bearer-authenticated app route with two fixed operations and fixed GitHub endpoints (`/login/device/code`, `/login/oauth/access_token`), no redirects, a 15 s cap and only the fields the app needs in the reply. The caller cannot choose a host or path. TLS inspection is not implemented.

**TASK-073b git gateway:** a fourth listener on **4322**, reachable only on the internal `desktop` network, speaks git smart HTTP for `github.com`. The supervisor relay opens it from inside the agent namespace and writes `ECLIPSE-AGENT <agentId> <hmac>` first; the gateway verifies that HMAC, never a client header, and then requires the agent's allowlist. **TASK-087:** the repository path may be the address-bar form (`/owner/repo`) or end in `.git`; both map to the same upstream. `info/refs?service=git-upload-pack` and `git-upload-pack` (clone and fetch) are forwarded without an `Authorization` header when the agent has no GitHub connection, so a public repo clones with only `github.com` in Domains; both `git-receive-pack` requests still require the Basic `github.com` binding. An upstream `401` becomes a fixed `403 credential_required` with no `WWW-Authenticate` header. For authenticated traffic it replaces any client `Authorization`, pins the resolved GitHub address, streams responses (512 MiB / 10 min caps, 4 per agent / 16 total) and buffers only the first 64 KiB of a push to parse its pkt-line ref commands. Pushes to a new or non-default branch are forwarded; protected changes are TASK-073c below. `git` is in the pinned image (TASK-073b closure), and the shell's environment rewrites `https://github.com/` to the namespace gateway without ever holding the token. Chunked request bodies are refused (`411`); pack data is not canary-scanned.

**TASK-073c push approvals:** a protected ref (default branch, remote branch/tag delete, tag move) becomes one pending row in the proxy, keyed by `(agentId, owner, repo, requestHash, ref, kind, old, new)`. `requestHash` is SHA-256 over the whole parsed command list, including unprotected refs. Pending lives 15 minutes; grants live 10 and are single-use; caps are 8 of each per agent and 256 globally. The app polls `GET /v1/pending` after each shell step, asks once per pending id through the existing approval gate (Allow once / Always allow / Deny), stores the decision receipt, then posts `POST /v1/grants`; deny clears the request group. The gateway consumes every required grant atomically immediately before forwarding, so a partial or concurrent retry forwards nothing. Policy block, trip, removal, policy expiry, grant revocation, run end/cancel and a proxy restart clear the records. All five control routes (`GET /v1/pending`, `POST /v1/grants`, `DELETE /v1/pending/{id}`, `DELETE /v1/grants`, `DELETE /v1/git-approvals`) are Bearer `EGRESS_PROXY_SECRET` over the internal network; no browser route, listener or published port is added. The model gets only a "run a new push-only step" hint, never a pending id or grant.

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
| Sandbox | Ubuntu, Xvfb, Chrome for Testing, `playwright-core` (library, not MCP), xdotool, ffmpeg, x11vnc, noVNC |
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

TASK-049/050 make policy concrete in code: the action allowlist, then task scope, then grounding, then the approval gate, then the confidence gate, then execution. `lib/agent/scope.ts` derives in-scope hosts from the owner's task, the agent's configured `domains` and the first readable page, and refuses a `type` that names another host or email (`lib/agent/scope.ts`); one refusal is a blocked receipt, the second stops the run as `scope_blocked`. `lib/agent/risk.ts` classifies a grounded click as download, send, post, delete, purchase or submit from fixed keyword lists in the control name and `expect`; `lib/approvals/gate.ts` then uses a live grant with capacity or creates an approval row and waits for the owner, re-reading and re-grounding the page before execution. TASK-024 implements this loop in `lib/agent/` with every dependency injected (provider connector, desktop port, grounder, card sink), so it is tested with mocked transports only. `intent.ts` holds the strict Zod schema and the single `next_step` tool (click, type, key, scroll, wait, get_time, finish, ask_owner; no coordinates or selectors). `context.ts` builds each request: the owner task is the only `user`-tagged content, the screenshot is tagged `web` and the step history `agent`, and the clock block from `lib/time/clock.ts` follows the stable prefix (see §19). `executor.ts` defines the `Grounder` seam: coordinates exist only when a grounder returns them; the default grounder uses page structure (TASK-025, §7.2), and a click it cannot place hands off to the owner. `desktop-port.ts` wraps `desktopCommand`, so takeover leases still stop input (`takeover_active` ends the run as `paused_by_owner`). Policy includes the agent's default-deny `actions` allowlist and TASK-028 independent target agreement (§7.4). TASK-069 connects chat and TASK-046 supplies authenticated proxy transport. TASK-073c reuses the same approval gate for blocked git pushes: the loop polls the proxy after a shell step, asks once per protected ref, stores the decision receipt before issuing an exact single-use proxy grant, and tells the model to run a new push-only step rather than repeating the blocked command. TASK-029 adds per-step receipts and the `runs`/`steps` tables (9.2): `RunDeps.receipts` is a sink the loop calls once per step, and a run that cannot record its proof stops with `receipt_error`. TASK-033 guards are now 60 steps, 400,000 weighted tokens (uncached input + output + one tenth of cached input), a 30-minute wall clock, and the 3rd identical step; one run per agent. **TASK-087:** an agent whose Actions include `shell` gets the same 60 steps, 1,500,000 weighted tokens and 60 minutes; a caller can still ask for less (heal uses 8), and no caller can exceed the agent's ceiling. The stop card shows the limit that was reached. TASK-079 adds an opt-in `hear_audio` step: it captures at most 30 s from the agent's private speaker monitor, transcribes through the fixed Meta ASR route, and injects bounded untrusted text as a tool result; the attempt is charged before dispatch and is not replayable. The deadline begins before receipt initialization and covers desktop, model and verification work. Its abort signal reaches the provider transport, and a returned step is not executed after a token or time stop. Receipts still seal the run with the guard outcome. Checkpoints remain TASK-032.

**TASK-083 conversation and live steps:** chat runs and branches load at most ten earlier messages from the last 24 hours (1,500 characters each, 6,000 total, newest kept); the current message is excluded. Owner messages are `user` context under a framing line that keeps the latest message as the only task; agent replies are `agent` data. Routines, replays and heal runs load none, and a branch stops before its source run started. Only hosts and emails named in included owner text extend TASK-049 scope. Base guards are 60 steps, 30 minutes and 400,000 weighted tokens (uncached input + output + one tenth of cached input); shell agents keep the same steps and a 1.5M/60-minute ceiling. The chat renders the newest 20 compact steps from an owner-scoped, no-store live route (null when idle, last-20 steps and cost when active), polls at 2 s while the agent is active and 10 s otherwise, and cancels through the existing owner/CSRF run route. The live card is not stored as a message.

**TASK-085 durability core:** every chat run updates `runs.heartbeat_at` every 15 s. The 60 s scheduler tick seals an unsealed run whose heartbeat is older than three minutes as `interrupted`, deriving step count, head hash and summed usage from stored receipts, expiring its pending approvals, posting one honest card and writing `run_interrupted` to the audit log. The sweep is bounded to 20 runs, guarded by `signature IS NULL`, ignores runs with no heartbeat and has `RUN_SWEEPER_ENABLED`. Cancel on a run held by another process sets `runs.cancel_requested_at`; the next heartbeat stops it. Jobs treats a heartbeat younger than 90 s as Running. Handoff, @mentions, the Continue dialog, continuation of sealed helpers and the bulk enable are built (see §6.6); their live restart and two-agent checks remain.

### 6.2 Run guards [M]

| Guard | Behaviour |
|---|---|
| Max steps / max tokens / wall-clock limit | Stop the run and report |
| Loop detection | The same action repeated 3× stops the run |
| Budgets | Checked before every step against the live total spent (not a balance read at run start). Warn at 80%; at 100% the run pauses with a `budget_paused` outcome, posts a chat card and asks the owner (see §18) |
| Concurrency | One *screen* run per agent at a time; agents run in parallel. Up to 3 screenless helpers may run beside that run (TASK-076) |
| Heartbeat | A live run updates `runs.heartbeat_at` every 15 s. No row back means the sweeper sealed it; the loop stops without a second card (TASK-085) |
| Sweeper | An unsealed run whose heartbeat is older than 3 min is sealed `interrupted` (signed, from stored steps), its approvals expire, one card with Continue is posted, and its helpers are sealed too. `RUN_SWEEPER_ENABLED=false` turns only the sweep off |
| Cancel across processes | The cancel route uses the in-process control when it holds the run; otherwise it sets `cancel_requested_at`, which the next heartbeat observes (TASK-085) |

Per-step checkpoints are also needed because stateless computer-use replay is reportedly capped at 29 screenshot/action pairs per request (to verify).

### 6.3 Takeover and hand-off

- The owner can take over any screen (mouse + keyboard). The agent pauses and resumes on **Hand back**.
- Browser-side takeover eligibility (2026-11-03 UI alignment) is a UX policy in `components/desktop/use-takeover-eligibility.ts`: Take over unlocks only after one trusted mouse pointer action and one trusted non-composing keyboard event are demonstrated on the takeover control in the current viewer session (`(any-pointer: fine)` is only a hint). It replaces the earlier viewport-width rule; touch-only devices stay view-only at any width and keyboard+mouse devices can take over at any width. Remote pointer forwarding accepts only `pointerType === "mouse"` events; evidence resets on stream loss, page resume and capability change, which also stops recording, blocks queued input and releases the lease. It is not hardware attestation and not a server authorization boundary — the leases and route guards below remain authoritative.
- Current transport leases stop agent input and screenshot dispatch after takeover acknowledgment. Route leave/disconnect releases the bound lease; the later agent runtime must use the same guarded primitives.
- Agents pause at login walls, CAPTCHAs, OTPs and payment verification and hand off to the owner.
- Nothing is screenshotted or recorded during takeover, except when the owner explicitly presses **Record** in teach mode. Logins, CAPTCHAs and OTP entry are never recorded.

### 6.4 Structured replies [M]

Agent chat output is validated with Zod into one of five card types:

| Card | Purpose |
|---|---|
| `message` | Plain reply |
| `clarification` | Asks for missing parameters |
| `tool_connection` | Inline card to connect a tool |
| `routine` | Schedule blueprint for confirmation |
| `file` | A file in `inbox/` (owner upload) or `outbox/` (agent result): safe name, size, kind, SHA-256 |

TASK-022 implements the durable chat boundary: users append validated text messages through the owner-scoped API, while agent, tool and background output enters only through the server-only append function. The workspace renders all four cards, reloads bounded history and polls visible timelines so appended run results appear without adding the later SSE channel. **Agent files (TASK-067):** three more closed operations on the 4311 listener, `POST .../files/list|read|deliver`, run `file-tools.mjs` as the agent's own Linux user (60 s limit, 768 MB heap, no network need). `list` names up to 50 plain regular files in `inbox/`, `Downloads/` and `work/` with their content type. `read` takes an `inbox/` file by plain name and returns text in windows of at most 20,000 characters (`offset`, `nextOffset`, `totalChars`): UTF-8 text/CSV/JSON/code, `.docx` (`unzip -p` of `word/document.xml`, tags stripped), PDFs with a text layer (pinned `pdfjs-dist` 4.10.38, offline, no eval, no native canvas), or a PNG/JPEG/WebP up to 4 MiB as an image. Scanned PDFs, xlsx/pptx, audio, video and archives return fixed codes (`no_text_layer`, `unsupported_type`, ...). `deliver` copies a `Downloads/` or `work/` file into `outbox/` (blocked types and extension/content mismatches refused, `O_EXCL`, mode 600, numbered suffix on a name clash, source untouched) and returns name, size, kind and SHA-256 so the file card appears at once. The step loop gets `read_document` and `deliver_file` intents (default-deny by name in the agent's `actions`), keeps the newest two document windows as `document`-tagged data, and lists the agent's files each turn as `tool`-tagged data. Final answers may be 4,000 characters with line breaks and always end with the names of delivered files. **Document search (TASK-082):** extracted text now marks pages (`--- page N ---`), sheets (`--- sheet "Name" ---` with CSV rows) and slides (`--- slide N ---`), so windows, search offsets and citations agree. `.xlsx` reads `xl/workbook.xml`, `xl/sharedStrings.xml` and `xl/worksheets/sheetN.xml` (formulas give their cached value, at most 50 sheets and 200,000 cells); `.pptx` reads `<a:t>` in slide order (at most 500 slides). Each file version has a derived index in `~/.cache/eclipse/doc-index/<sha256>.json` (mode 700/600, at most 20 files and 256 MB, oldest evicted first): the text, page starts, overlapping 1,500-character chunks and a BM25 postings list (k1 1.2, b 0.75). The file server starts `index` in the background after a document upload (best effort, one per agent and two at a time); `search` builds it on demand when missing or stale. `search_document{name, query, expect}` uses the `read_document` permission, accepts a query of at most 200 characters and 16 terms, and returns the top five passages with `offset`, page/sheet/slide and text; `no_match` is a normal result. Only the newest two searches stay in context, tagged `document`; receipts keep the file name, query length and hit count, never the query or passages. Replay refuses the step. **Chat trigger (TASK-069):** after `POST /api/agents/[agentId]/messages` stores the message and returns 201, `lib/agent/chat-run.ts` starts one step-loop run in the `app` process (not durable: an app restart loses the run). It uses the saved Main AI role through the egress-proxy transport, the owner's timezone and the agent's persona and `actions`, and posts the result as one agent card. A busy agent, a missing model or key, or an unreachable desktop each produce one fixed message card with no error details. The run loads up to ten earlier messages from the last 24 hours as context after the task (each cut to 1,500 characters, 6,000 total, excluding the current message); routines, replays and heal runs stay self-contained. Card actions that connect credentials or save routines remain display-only until TASK-046/038. **Attachments (TASK-023a):** one file per request, `POST /api/agents/[agentId]/files` with raw bytes and the name in `X-File-Name`. The route streams the body to a second `desktop` listener on port 4311 (same internal network, secret and source check as the controller, but its own timeouts), which streams it into `inbox-writer.mjs` running as the agent's own Linux user. The writer is the only authority for the stored name, content type and size, writes `.part` with `O_EXCL|O_NOFOLLOW` mode 600, links it into place without overwriting, and returns the card data. `app` never mounts the workspace volume and never stores the bytes. Inbox cards are written only by the owner's upload; an agent can post `outbox` file cards only. **Outbox (TASK-023b):** `POST /api/agents/[agentId]/outbox/refresh` (called by the chat poll; TASK-024 will call the same functions) asks the 4311 listener to list `outbox/` as the agent's user (`outbox-reader.mjs`; at most five new files hashed per call, files younger than 2 s wait) and appends one `outbox` file card per new file (agent message, source tag `tool`). `GET /api/agents/[agentId]/files/[messageId]` streams the file through the listener after it re-checks size and SHA-256 against the card. `POST /api/agents/[agentId]/files/open` runs the new `file.open` controller operation, which opens the file in a new tab of the agent's own Chromium (`session-worker.mjs`). Files written to `outbox/` appear as **file result cards** (preview, Download, Show in Files, Open on the agent's desktop).

---

### 6.5 Sandbox, graphics and browser lifecycles (2026-11-03)

An agent has three independent states:

| State | Owner | What it provides |
|---|---|---|
| Sandbox | the session worker process (`session-worker.mjs`) | the agent's Linux user, namespace, egress relay, shell and file tools |
| Graphics | Xvfb, Openbox, the private D-Bus bus, `pcmanfm`, `tint2` and x11vnc | the live desktop and VNC stream |
| Browser | the managed `playwright-core` persistent context | page snapshots, screenshots and browser input |

The supervisor starts the worker alone for `sandbox.start`; `desktop.start`/`desktop.stop` and `browser.start`/`browser.stop` change only graphics/browser and are serialized per agent. `session.status` returns all three states plus the session generation. A browser close reports `browser=stopped` and leaves graphics and the sandbox running; a graphics loss reports `graphics=failed` and leaves the sandbox usable; only the worker process ending fails the session. `session.stop` (Pause agent, crew stop, security stop) ends the sandbox too.

`lib/agent/runtime.ts` is the lazy client. Chat preparation starts no graphical components: the desktop port ensures the sandbox on the first shell/file/tool/checkpoint call and acquires graphics+browser only for a screen action or a `start_desktop`/`start_browser` intent. The controller binds every lifecycle call to the run's agent; the app rechecks active/crew/security/budget before a lazy start and never resumes a paused agent. The step loop accepts a run with no screenshot; nonvisual steps still write signed receipts with null screenshot hashes, and a missing file manifest is an explicit `partial` checkpoint, never `complete`. Screen actions reacquire the current generation and re-ground before acting; the existing confidence gate, approvals and takeover behavior are unchanged.

### 6.6 Handoff and screenless helpers (2026-11-03)

**Handoff (TASK-085).** `handoff{agent, note}` is a separate permission (`handoff`). New agents start with it; existing agents change only through the owner's explicit "Allow handoff for all agents" action. The receiver's task is a copy of the stored owner message; the note is a `agent`-tagged one-liner. A receiver runs under its own permissions, allowlist, connections and budget; nothing is borrowed. Code enforces two hops, no return to an earlier agent, no self-handoff, and unavailable/busy receivers; a refusal is reported to the sender and its run continues. The sender seals `handed_off`; the receiver's `run_meta` has `trigger = 'handoff'` and `handoff_of`, and its header carries `handoff_of` only when present. A leading `@Name ` in chat routes the owner's words to that agent's chat; unknown names send nothing.

**Helpers (TASK-076).** With `spawn_subagent` and at least one screenless tool, the model may start up to 3 one-level helpers with `{task, tools}`. Refusals are `no_tools`, `tool_not_granted`, `duplicate_task`, `subagent_limit`, `nested_spawn` and `invalid_task`. Each helper gets 20% of the parent's actual step, wall-clock and weighted-token limits; its allowed actions are `tool_call` (granted slugs only), `read_document`, `search_document`, `search_history`, `get_time` and `finish`; it never takes the screen lock, writes memory, hands off or spawns. It is its own signed run with `run_meta.parent_run_id`, a `parent_run`/`parent_step` header, heartbeat and checkpoint. Its summary (≤4,000 characters) reaches the parent as `tool`-tagged data; `finish` waits ≤60 s, then cancels. Parent cancel cascades in process and through `cancel_requested_at`; the sweeper seals orphaned helpers `interrupted`. Live chat shows the helpers indented under the parent; History and Jobs link/count them, and helper rewind is not offered.

## 7. Perception layer

The perception layer sits between every brain model and the screen. Muse, Claude, GPT, Glimmer or any other model gets the same behaviour, receipts and safety rules; only precision differs.

### 7.1 Intent schema [M]

Models never emit raw coordinates. They emit:

```json
{ "action": "click", "target": "Submit button", "expect": "order confirmation appears" }
```

The actions are `click`, `type`, `key`, `scroll`, `wait`, `get_time`, `read_document`, `search_document` (TASK-082), `deliver_file`, `extract` / `navigate` / `select` (TASK-084), `remember`, `tool_call`, `shell`, `start_desktop`, `start_browser`, `finish` and `ask_owner`. Every schema is strict: an extra field, a coordinate or a selector makes the whole step invalid. `extract{name, value, expect}` saves page text under a short name only when the exact text (whitespace-normalised, case kept) is found in a non-sensitive frame or open shadow root; `type` fills `{{name}}` from run memory, and an unknown or empty name makes the step invalid. Values are never written to the database, receipts, checkpoints or logs; a branch keeps names only and says "(extract again)". `navigate{url, expect}` accepts `http(s)` only, no credentials, and goes through the typed-URL scope check (permission `type`); `select{target, option, expect}` grounds the dropdown through the normal cascade (permission `click`). None of the three is classed as risky, and replay refuses all three.

### 7.2 Grounding cascade [M]

The layer uses the best available method first and cross-checks when two methods agree:

1. **Page structure** (built, TASK-025): the worker op `page.snapshot` lists up to 150 visible, unobstructed, clickable controls of the focused page (role, name, box) in screen pixels. It parks the real pointer on a known screen point once and reads the browser's own `screenX - clientX`, so the exact place of the page on the screen is measured, not guessed; zoomed pages are refused. `lib/agent/grounding.ts` matches the intent's `target` against the names with plain code (no model call) and returns the control centre, or nothing on no match, a weak match or a tie. The model sees only a `web`-tagged list of roles and names. TASK-084 replaces the top-frame scan with scanner A from the shadow/frame spike: every Playwright frame plus every open shadow root, each frame's offset added, a parent hit test for occlusion, and clipped screen boxes; controls carry `frame` (`top`/`child`) and `shadow`. Payment-shaped frames are counted and never listed; a sensitive (password/OTP/card) frame is never listed and its text never matches `page.find_text`. Closed shadow roots remain unreachable and hand off to the owner. The model list says which controls are in a frame or shadow root and warns when the page has a payment frame. Click accuracy, the 150-control cap and the 1,500 ms p95 bar come from the spike report; the production fixture re-run inside the desktop image is still owed. TASK-028 independently cross-checks targets before input (§7.4).
2. **Set-of-marks [S]:** numbered boxes drawn on the screenshot from page structure, the Linux accessibility tree or local OCR (any vision model).
3. **SAM 3.1 pixel masks** (built, TASK-091): only if enabled, clicks only, after two page-structure misses (the model has already seen the visible names once). Exactly one mask with confidence ≥ 0.90 counts; the click point is its centroid, or the nearest set pixel when the centroid is outside the shape.
4. **The model's own computer-use coordinates** (built, TASK-091): only for Meta models whose known profile supports computer use (`muse-spark-1.3*`, `muse-wonder-1.0*`), using the Main model. A separate single-purpose call (`lib/agent/visual-grounding.ts`) asks for a screenshot, receives this step's screenshot through `continueComputer`, and must return exactly one in-bounds left click; a click before observing, any other action and any `pending_safety_checks` end the attempt (safety checks are never auto-acknowledged). The planner's intent still carries no coordinates (ADR-008).
5. **Hand off to the owner.**

Visual points (rungs 3-4) never run on a page that shows a payment frame. The confidence gate (§7.4) needs a second independent agreement: irreversible clicks need SAM and computer use to agree (the computer-use point inside the unique SAM mask); ordinary clicks may instead use the model's pixel check (`confirmPoint`). After an approval wait the point is located again the same way and may drift at most 16 px, or the step is stale. Receipts record `sam` / `computer_use` methods.

### 7.3 Verification cascade [M]

Each `expect` is checked with, in order:

1. page-structure postconditions
2. pixel diff of the target region **[S]**
3. local OCR **[S]**
4. SAM 3.1 before/after masks (if enabled)
5. model judgement (last resort)

**Implemented TASK-028:** `lib/agent/verification.ts` accepts exact `expect` forms `control_present: Name`, `control_absent: Name`, `url_path: /path`, and `object_visible: concept`; prose falls back to visual judgement. The guarded read-only `page.verify` operation checks the bounded visible top-frame control inventory or exact URL pathname, never selectors or evaluation. Control absence means absence from that inventory, not proof of deletion or absence elsewhere. A supported DOM failure polls at most three times with two 500 ms settling waits, then stops; visual opinion cannot override it. SAM runs only when enabled and applicable to object presence; only one unique mask with confidence >=0.90 passes. Missing/ambiguous masks and missing confidence are unknown, never proof of deletion. Independent SAM requests are correlated by concept/geometry, never object IDs across responses. Mask movement cannot establish arbitrary external outcomes.

Model judgement is last resort: strict verdict tool, before/after screenshots, clock and source tags, maximum 512 output tokens, no retries. Model coordinates are never accepted. Per desktop step there are at most one Main-model gate request, one Main-model postcondition request and two single-image SAM requests (before/after), each with a 30-second deadline. SAM uses only authenticated egress transport. `RunStep` keeps pass/fail/unknown evidence and SAM off/on/unavailable state; token usage is added to run totals. SAM image requests are bounded but monetary pricing is not computed here. Failed/unknown postconditions stop with a needs-owner card after recording the attempted action. Final summaries remain model reports and name only postconditions checked. File-tool results are separate from visual verification. Receipts are persisted by TASK-029 (9.2); the History UI that presents them is TASK-031.

### 7.4 Confidence gate [M]

Irreversible actions (purchase, send, delete, payment hand-off) need **high confidence, meaning two methods agree**. Otherwise the agent asks. Weaker setups ask more often.

**Implemented TASK-028:** conservatively treat all clicks, typing and key presses as potentially irreversible. Page structure must identify one named target (or a visible focused control for typing/keys), plus independent screenshot-only SAM mask agreement for a click or a Main-model semantic observation. SAM must uniquely cover the grounded pixel and overlap the target box (IoU >=0.5, confidence >=0.90); otherwise the screenshot observer identifies the target without DOM answer hints. A repeated DOM lookup is not an independent method. Before dispatch, a fresh guarded snapshot must still match target role/name/geometry, page URL and required focus. Missing/conflicting evidence hands off before input. Existing action permissions still apply. Agreement establishes targeting, not safety or authorization for every possible website effect; the page can still change between checks and dispatch. Wait/scroll require the action allowlist and postcondition checks. Login/OTP input remains denied by the worker; takeover blocks checking/capture/input. This task does not introduce durable approvals or automatic resume.

### 7.5 Capability profile [M]

When a provider is added, the layer detects tool calling, vision, video, audio (with known caveats, e.g. Muse Spark 1.3 audio degraded), computer use and context size. Methods are then chosen automatically, with no user configuration. Tool calling is the minimum for an agent.

TASK-021 implements hybrid capability profiles in `lib/providers/capabilities.ts`: live forced-tool and exact vision-confirmation probes, provider model metadata, and documented Meta media/computer/context profiles. Failed or incomplete probes stay `unknown`; only a validated no-tool completion is `unsupported`. `assertAgentCapable()` rejects models that cannot satisfy the tool-calling minimum.

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
| Meta API (`sam-3.1`) | Meta key | $2.50 / 1k images | [M] |
| Local (`local-vision` profile) | NVIDIA GPU, CUDA 12.6+, Python 3.12+, PyTorch 2.7+; gated Hugging Face weights (3.50 GB FP32) | Free, offline | [S] |
| Off | — | Free | Default with no Meta key or GPU |

Only single images are used for verification. CPU-only SAM is not offered for per-step use (too slow).

TASK-008 adds a server-only developer CLI, `spike:sam-screenshot`, separate from the future perception adapter. With explicit `--live` consent it makes one non-streaming `sam-3.1` request to the fixed Meta Responses endpoint using the existing private host key, the fixed concept `button` and a validated owner-selected PNG. It uses `store:false`, compact one-bit masks and confidence metadata. It has a 30-second request/read deadline, an 8 MiB response cap and no retries; billing is for one image, not Muse reasoning tokens. Specialized SAM input contains only the concept and image, with UTC evidence time generated by code. No computer tool, replay state or input execution is involved. The direct endpoint exception is development-only; product SAM remains off by default.

Before the official pinned parser can allocate masks, complete wire preflight enforces frame 0, paired box/mask records, unique IDs, exact source dimensions, inclusive in-bounds geometry, confidence, at most 64 objects and 16 million decoded pixels total. Masks must be nonempty and decode canonically; source-aligned monochrome PNGs and sanitized metadata are written exclusively under ignored `data/spikes/task-008/<uuid>/`. Zero matches is a normal incomplete-target outcome. Raw responses, encoded payloads, provider IDs, credentials and source-image copies are excluded. Precise safe stage/reason/schema/parser codes distinguish failures without logging arbitrary provider text. Live run b91a98d6-8c75-408b-9b01-bfbba38c92b0 validated one mask in 2122 ms; agent visual comparison confirmed View project status. This completes the developer spike, not production grounding/verification. Original request-time evidence remains unchanged.

### 7.8 Model check [S]

The owner-approved spike:meta-live-click developer test uses fresh credential-free headless Firefox on a self-contained loopback fixture page only (not the app), at a 1862x946 DPR1 viewport. It keeps model coordinates as internal grounding data for a fixed click intent, independently validates the point/scene, executes at most once and verifies details closed→open plus visible status. Screenshots explicitly use original detail in all newly constructed image items. Validated PNG dimensions must equal viewport CSS dimensions at DPR1; viewport capture uses no crop or full-page expansion. The request states actual image dimensions and pixel coordinates without target hints. Geometry mismatches fail closed. Limits: low reasoning, 1024 output tokens/request, 3072 total, at most three requests, 30 seconds/request and 90 seconds active model time; no retries. Generic computer_action_requires_confirmation may pause for specific owner approval only after target validation; a run/action-scoped single-use stdin token binds that reply. Review is capped at five minutes, excluded from model time, and never auto-approved. Raw checks/call IDs/receipts stay in memory. After approval and rechecking, execute once and replay genuine history with exact reviewed checks and real after-image for acknowledgement. Unknown genuine metadata and documented assistant phases are preserved; action schemas remain strict. Further returned actions never execute. Execution/postcondition/acknowledgement states remain separate. Private fixture-page before/after and safe metadata live under ignored data/spikes/task-007-live-click/. This does not implement production desktop/egress services. Earlier calls/unknown discarded fields remain historical. Earlier reviewed-flow run d1395501-fc64-4938-bb4e-676bd3e3fef0 successfully completed observation/replay, then failed the independent target gate at (359,483), below the button. No review was requested and no input/acknowledgement occurred. Two calls used 191/176 output tokens; larger caps did not resolve grounding. Production page-structure/SAM grounding is still future work. Original-detail run 3e06d19f-8460-4162-968a-7ea98b134318 verified 1280x800/DPR1 and the unchanged screenshot hash, but returned (359,483), below the button ending y=466. One Contributor request used 3559 input / 670 output tokens (584 reasoning); wrong_target stopped before review/input/acknowledgement. Original detail did not resolve the miss; no token cap was reached. Run 21c0933d-7e35-4ec4-be42-a784ab4ec56d (fixture, 1862x946/DPR1): after one screenshot observation the model proposed (657,471) inside the button (571,456)-(746,488); owner approved the specific point; one Firefox click opened the section (closed->open, Project status visible, after.png inspected); the reviewed acknowledgement was accepted and no further action executed. 3 Contributor requests, 21354 input / 527 output tokens (338 reasoning), 15.9 s model time, no caps reached. The earlier 1280x800 misses at (359,483) are historical; the viewport size, not original detail, is the likely cause (one run, not proven). TASK-007 is complete.

When a model is added, it runs about 10 standard tasks on the built-in mock vendor portal. The result is shown as a score and expected behaviour, e.g. "8/10, purchases will ask for approval".

---

## 8. Model provider layer

### 8.1 Adapters

- **OpenAI-compatible adapter:** OpenAI, OpenRouter, Baseten, other compatible providers, and local servers (Ollama, LM Studio, llama.cpp, vLLM). Base URL + key.
- **Anthropic-compatible adapter [S]:** Anthropic's Messages API and any endpoint that speaks the same format. Base URL + key. Handles tool calling, image input, prompt-cache markers, and Claude's computer-use tool (translated through the intent schema, §7.1). See ADR-023.
- **Native Meta adapter:** Muse models, including the Responses API computer tool (`tools: [{type: "computer"}]`) on `muse-wonder-1.0` / `muse-spark-1.3`, batched actions in screenshot pixel coordinates, and acknowledgement of `pending_safety_checks`.

TASK-021 implements the server-only provider modules in `lib/providers/`. Adapters are keyless and receive an injected `ProviderTransport`; they never accept API keys or add authentication headers. TASK-046 supplies the authenticated transport (`lib/providers/proxy-transport.ts`, `lib/models/transport.ts`): the key is decrypted per request, sent only to the egress proxy, and added there; there is no direct-auth or proxy-bypass path. Requests and provider output are bounded and schema-validated; source-tagged text is JSON-framed so untrusted text cannot forge a new tag. Meta computer continuation requires the exact validated `call_id`, actions, replay items and explicitly approved safety checks, never an automatic acknowledgement. Usage is required before a result is accepted so cost accounting cannot silently disappear. TASK-021 proves these boundaries with mocked transports only; live provider connectivity remains pending.

TASK-007 provides a standalone, server-only developer probe with a bounded read-only observation loop. The owner-selected muse-spark-1.3-contributor model receives a text-only observation request, then the validated static PNG as computer_call_output only after a single valid screenshot call with empty safety checks. At most two requests use minimal reasoning, 512 output tokens each (1024 total), a 30-second per-request deadline and 45-second total deadline. No retries or desktop input occur. A click before the image is supplied is rejected. Native coordinates remain provider-grounding evidence, separate from product intents; no provider adapter, desktop driver, egress proxy or production receipts are implemented. A genuine validated live click and owner target confirmation are required for completion.

Safety metadata is schema-validated before classification. Opaque check strings follow Meta's string types and are bounded by the 1 MiB response cap rather than an invented 128-character ID limit. Malformed metadata produces `invalid_response`; valid nonempty checks produce `safety_review_required`. The general result contains only safe codes/counts and field/type/constraint diagnostics. A separate private `safety-review.json` preserves bounded sanitized explanations for review, never opaque IDs or raw payloads. It is explicitly untrusted tool data and never triggers execution or automatic acknowledgement. Historical discarded check reasons cannot be reconstructed from old evidence.

Stateless store:false continuation retains the genuine computer_call, call_id and meta_safety_replay_receipt unchanged, with documented reasoning items carried only in memory. Missing/malformed replay data stops before a second request. The supplied PNG is a static test scene, never represented as a fresh host capture. Per-turn stages, request counts and numeric usage are saved; opaque handles, receipts, reasoning and raw payloads are excluded. Repeated screenshot requests, unsafe/malformed output and exhausted budgets stop without accepting a click. Earlier one-shot evidence remains unchanged. Latest live evidence f4aa6650-f817-4148-8802-bb369129efcc contains a valid empty-check screenshot request, but continuation failed replay validation before a second call. Its finer replay reason was not retained and cannot be reconstructed. New executions expose only whitelisted replay subreason codes; the provider remains responsible for receipt authenticity verification. TASK-007 is still open.

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

TASK-020 implements Settings → Models for Main AI and SAM 3.1. Owner-scoped `providers` rows hold encrypted keys and last-four hints; `model_roles` holds one row per owner/role, with SAM either off, sharing the Main provider through `use_main_key`, or using its own Meta key. Main supports Meta and OpenAI-compatible endpoints, while SAM supports Off or Meta API. The server never returns plaintext or ciphertext, accepts blank key input as "keep the saved key", and refuses to change Main away from Meta while SAM depends on that key.

Test uses only saved configuration, returns a bounded model list and measured latency through the keyless connector with an injected transport, and has its own owner-wide rate limit. The production route builds its transport with `proxyTransportFor` (TASK-046): the saved key is decrypted per request and the call goes through the egress proxy. It still fails closed with `authenticated_transport_unavailable` (503) when the role has no saved key, `ENCRYPTION_KEY` or `EGRESS_PROXY_SECRET` is missing or invalid, or the saved key cannot be decrypted. There is no direct-auth fallback.

### 8.3 Routing [M]

| Work | Default model |
|---|---|
| Chat, planning, routine compilation, extraction | Muse Spark |
| Hard computer-use steps, recovery after Spark fails | Muse Wonder (preview; falls back to Spark) |
| Grounding and verification | SAM 3.1 (if enabled) |
| Probes, quarantined reader, consolidation, research extraction | Background role (e.g. local Glimmer) **[S]** |
| Dev agent code changes | Muse Code in the agent's terminal **[S]** |

A model label ("Muse Spark", "SAM 3.1", …) is shown on every step in the UI.

**Implemented (TASK-027):** routing is a setting on the Main AI card. **Fixed** (default) always uses the Main model, which in the hackathon build is `muse-spark-1.3-contributor`. **Auto** adds a hard-step model on the same provider and key (stored as `model_roles.routing` and `hard_model`). A turn uses the hard-step model only when the previous turn failed (invalid output, target not found, failed file action) or the same step repeated, at most 5 times per run. If the hard-step model errors, the same turn is retried on Main and escalation ends for that run. Muse Wonder has no Contributor mode on pay-as-you-go, so any hard-step model is billed at its standard rate and is outside Contributor terms; Settings says so. Each executed step records `model`, `modelLabel` and `route` (`main`, `hard`, `fallback`) in `RunStep`; the visible per-step label comes with the History timeline (TASK-031).

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
- Screenshots are stored in the `artifacts` volume and kept permanently by default. Built (TASK-031) as the exact PNG bytes named by their SHA-256, not WebP thumbnails, so a stored file re-hashes to the signed `before_hash` / `after_hash`.
- `eclipse-crew verify <run.json>` checks the chain and signature offline.
- When SAM is off, receipts still state the method, e.g. *"Verified by: page structure + pixel diff (SAM off)."*

**Implemented (TASK-029, TASK-030).** `lib/receipts/chain.mjs` is plain JavaScript (`node:crypto` only) so the offline CLI runs it with bare `node`. `fields.ts` maps a step to a receipt, `store.ts` writes to Postgres, `signer.ts` loads the key.

- **Key:** `RECEIPT_SIGNING_KEY` in `.env` is a 64-hex Ed25519 seed made by `npm run receipt-key` (never printed, never rotated). Only `app` receives it. Each run records the public key and its fingerprint `sha256:<hex of the raw public key>`. With no valid key the chat run does not start (a fixed card names the fix); if a receipt cannot be written the run stops with `receipt_error`.
- **Canonical text:** sorted keys, no whitespace, integers only. The exact text that was hashed is what is stored (`runs.header_json`, `steps.receipt_json`), so a hash is always re-checkable.
- **Header:** `{v, run_id, agent_id, agent_name, task (max 2,000 chars), started_at, key_id}`, plus `branch_of`/`branch_at` only on a branch (TASK-043), `handoff_of` only on a handoff receiver (TASK-085), and `parent_run`/`parent_step` only on a screenless helper (TASK-076); `header_hash = sha256(text)`. The optional fields are written only when present, so every earlier header and hash is unchanged. `interrupted` and `handed_off` are ordinary seal statuses and verify offline with the existing CLI.
- **Receipt (v1):** `v, run_id, idx, at, agent_id, model, model_label, route, action, target {role,name}, grounding_method, methods [{phase gate|verify, method, status, code}], sam off|on|unavailable, confidence, before_hash, after_hash, postcondition, result, code, executed, usage {input,output,cached,reasoning}, cost_micro_usd (null until the cost ledger), prev_hash`. `receipt_hash = sha256(text)`; step 1 `prev_hash` is the header hash. One receipt per executed step, per step stopped by the target gate (`blocked`), and per file action (`executed` or `failed`). `get_time`, `finish`, `ask_owner` and hand-offs before any step are not steps; the seal carries the final outcome. Token usage in a receipt is what was spent since the previous receipt, so receipts add up to the run total.
- **Confidence:** `high` two or more different methods passed and none failed; `medium` one passed; `low` anything else, including every non-`pass` result; `none` for file actions.
- **What is never stored:** typed text (only the character count), key names beyond the chord, file contents, page values, model reasoning, credentials. Page text (control names) is bounded to 200 characters and stripped of control characters. Receipts hold only the SHA-256 of each screenshot; the PNG files are in the artifacts store (Evidence and History below).
- **Seal:** Ed25519 over `"eclipse-crew/run-seal/v1\n"` plus canonical `{run_id, header_hash, step_count, head_hash, status, ended_at, usage}`; `status` is the run outcome. The seal is written once (`WHERE signature IS NULL`). A run that never seals (crash) stays unsealed and fails verification with `unsealed`.
- **Tables:** `runs` (owner_id, agent_id without a foreign key so proof outlives the agent, branch_of, header text and hash, key id and public key, started_at, status, and the seal columns that are all NULL or all set) and `steps` (owner_id, run_id, idx, receipt text, receipt hash, prev_hash; unique `(run_id, idx)`). The app role has SELECT and INSERT on `steps`, so receipts cannot be rewritten or deleted through the app. It also has UPDATE on `runs` to write the seal; a seal rewritten later no longer verifies, so that is detected, not blocked.
- **Export and verify:** `GET /api/runs/[runId]/export` (owner session, scoped by owner, a download) returns `{format: "eclipse-crew-run/1", run_id, header, header_hash, key_id, public_key, steps: [{idx, receipt, receipt_hash, prev_hash}], seal}` where `header` and `receipt` are the stored canonical text. `scripts/eclipse-crew.mjs verify <run.json|-> [--key-id sha256:...] [--json]` needs only Node (no database, network or `.env`). Failure reasons are fixed codes (`receipt_hash_mismatch`, `prev_hash_mismatch`, `step_missing`, `step_order`, `step_count_mismatch`, `head_hash_mismatch`, `header_hash_mismatch`, `bad_signature`, `unsealed`, `key_id_mismatch`, `pin_mismatch`, `bad_format`), with the failing step. The CLI prints only a validated run id and key id from the file. `eclipse-crew key-id` prints this install fingerprint from `RECEIPT_SIGNING_KEY` in the environment, never the key.
- **Evidence and History (TASK-031).** After each receipt the loop stores the exact before and after screenshots with `lib/artifacts/blob-store.ts` (`<artifacts>/blobs/ab/<sha256>`, written to a temp name and renamed, mode 600, re-hashed on read, only 64-hex names reach the filesystem) and inserts a `step_evidence` row (owner_id, run_id, idx, before_hash, after_hash, width, height, `sam_box`; unique run + idx; insert-only for the app role). The SAM box is an annotation, not part of the signed receipt: it is set only when SAM found exactly one mask with confidence 0.90 or more for an `object_visible` check, and the UI says so. A failed evidence write never stops a run (the step then shows "screenshot not stored"). The History tab (`components/history/`) lists the selected agent's newest 20 runs (`GET /api/agents/[agentId]/runs`) and shows one run's timeline (`GET /api/runs/[runId]`): action, method (including "SAM off"), confidence, cost, before/after thumbnails, pass/fail, an expandable row with full screenshots and the 2 px `corona` outline, and a **Chain verified** badge that comes from running `verifyRunExport` on the stored rows at load time (an edited receipt shows the reason code and step; an open run shows "not sealed yet"). Screenshots load from `GET /api/runs/[runId]/evidence/[hash]`: owner session, the hash must be listed as before/after evidence of that owner's run, bytes are re-hashed, `image/png`, `nosniff`, sandbox CSP. The open run refreshes every 3 s while it is running. Rewind controls, the checkpoint dialog and branch badges/links are built (TASK-043).
- **Trust model:** the signature proves the export was not altered after signing and, with a pinned fingerprint, that it was signed by this install key. `app` holds the key, so a compromised `app` could sign a made-up run; pinning cannot stop that. Losing `RECEIPT_SIGNING_KEY` means new runs use a new key and a new fingerprint; old runs still verify against the public key stored with them.

---

## 10. Checkpoints, rewind and branching

### 10.1 Checkpoints [M]

After every step the runtime stores:

- agent conversation and context state
- task state
- changed files in the agent's home, **content-addressed** (by hash, so unchanged files are not copied again) in `artifacts`

Excluded: browser cache. Files above the size limit (default 200 MB) are recorded by hash only and marked "not restorable". The browser profile is snapshotted daily.

**Implemented (TASK-032).** `lib/checkpoints/` and `docker/desktop/checkpoint-tools.mjs`. A checkpoint is taken before the first step (idx 0) and after every receipt (idx N is the state after receipt N). The `checkpoints` table (owner_id, run_id, idx, state_hash, manifest_hash, file_count, restorable_count, status `complete`/`partial`, reason; unique run + idx; insert-only for the app role) only points at content-addressed blobs in the artifacts store.

- **State blob:** canonical JSON validated with Zod (`lib/checkpoints/state.ts`, at most 256 KiB, unknown fields refused): the owner task, the short step history, document references (name and offset; contents are re-read on resume), delivered file names, the loop counters and routing flags, token usage, and the previous intent with typed text replaced by its length. It never holds typed text, screenshots, document contents, keys or tokens.
- **Files:** the desktop lists the agent's files in `inbox`, `work`, `downloads` and `outbox` (recursive, at most 2,000 files, depth 6, no symlinks, devices, FIFOs, hard-linked or hidden files) with their SHA-256, as the agent's own Linux user (`POST .../checkpoint/manifest` on the file listener, port 4311). The app asks for the content of only the hashes it does not already hold (`POST .../checkpoint/blob`), re-hashes every body, and stores it. An unchanged file is therefore copied once across all checkpoints. `artifacts` is **not** mounted into `desktop`.
- **Limit:** files above **4 MiB** (not 200 MB: the app caps a desktop response at 6 MiB, and base64 adds a third) are listed with name and size only and marked not restorable. Larger files need chunked transfer.
- **Failure policy:** a failed capture is retried once (a file may be written during the scan). If it still fails, or exceeds the 10 s bound, the row is stored as `partial` with a fixed reason (`files_unreadable`, `content_changed`, `too_many_files`, `scan_limit`, `capture_timeout`, `files_unsupported`); the state is still saved, the run continues, History says "Can't rewind to this step", and rewind (TASK-043) must refuse a partial checkpoint. Receipts, by contrast, stop a run when they fail.
- **Restore (TASK-043):** `lib/rewind/` plans the diff between the saved manifest and the live files, then applies it through the agent-user restore tool (`docker/desktop/checkpoint-restore.mjs`). Restorable files that are missing or changed are written back atomically and re-hashed; live files that did not exist at that step are moved to `<area>/.rewound/<new-run-id>/`, never deleted. A `partial` checkpoint, a missing/altered blob, or a file over 4 MiB that is missing or resized refuses the rewind before any write. Browser pages, tabs and logins are not restored.
- **Not built yet:** blob cleanup (blobs are kept permanently for now) and the daily browser-profile snapshot.

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
- **Continue (TASK-085):** an interrupted run's card and History open this same rewind dialog with the last `complete` checkpoint selected. There is no same-run resume; the result is a normal branch. Missing or `partial` checkpoints refuse restoration.

**Implemented (TASK-043).** `POST /api/runs/[runId]/rewind` accepts `{step, correction}` (owner session, CSRF, 16 KiB). It verifies the original chain and seal, loads a `complete` checkpoint, plans the file restore, and applies it as the agent's own Linux user. The held per-agent lock is passed into `runTask` with a resumed state (history, document references, delivered files, turn); the branch task is the checkpoint task plus `Owner correction: …` (trimmed to 2,000 characters) and the first new step continues the step numbering. Receipts, evidence, checkpoints and costs are normal; the branch's signed header carries `branch_of`/`branch_at`, and History shows both runs. The correction cannot undo external effects, and the browser page/tabs/logins stay as they are now.
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

**Current build (TASK-036, managed browser):** recording is explicit owner consent, separate from takeover, and covers only the selected agent's managed browser viewport — not the app workspace, other windows, terminal or desktop. It requires the live owner session, owned active agent and current viewer/generation/lease; ordinary takeover records nothing. Capture states are `recording → paused → recording → finalizing → complete`, or `aborted`/`failed`; handback, lease/viewer loss, session stop, agent stop and worker failure stop capture and microphone intake immediately, and reconnect never resumes automatically. Frames are masked in memory before screenshots, encoder or storage, and typed text, clipboard and printable keys are never persisted. Privacy gates pause on login/password/OTP/CAPTCHA, dialogs, uninspectable frames/shadow roots and unsupported surfaces; Resume repeats the gate. Limits: 120 s active, 300 events, 5 fps, 1024×768, 128 MiB total, 8 MiB per artifact and 3 MiB per audio segment; a limit stops the capture rather than completing a truncated one. Narration is opt-in, held in bounded memory and transcribed after Stop by the saved native Meta Main provider through the fixed `api.meta.ai/v1/asr/transcribe` proxy route; audio cost is recorded in integer micro-USD and transcripts are untrusted. Artifacts live in the owner-scoped `artifacts/teach/<owner>/<capture>/` namespace and are served only by manifest-checked owner routes; the desktop has no artifacts mount, database or key access. A bounded owner+agent list of the newest 20 completed captures (counters, status and timestamps only) supports reopening after reload; review still requires manifest membership. Discard deletes that private namespace and retains a minimal `discarded` row for cost attribution. Native desktop/terminal capture is owner-deferred for v1 (no reliable native field masking); skill generation/review/approval and post-approval cleanup are TASK-037.

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
- TASK-037 implements the image-only path from validated capture events, paired after-shots and transcribed narration. The structured draft is rendered by code; the owner approves it, drafts remain non-callable, and approval grants no permissions. Native video-to-MP4 conversion and real-provider video generation remain unverified.
- **[S]** Long recordings are capped and downscaled to fit context, with a warning to split long tasks.
- **[S]** Post-run review improves skills, gated like memory writes.
- **[S]** Import/export uses the OpenClaw/Hermes format. Imported skills are scanned and can never grant permissions.

### 11.3 Deterministic replay [M]

A verified run compiles into a **replay script** (selectors, reference crops, coordinates, postconditions). Later runs replay with **no model calls**. The model is invoked only on a postcondition mismatch, so a second run with no drift costs $0 in model fees.

**Implemented (TASK-041).** `lib/replay/` (`script.ts`, `runner.ts`, `store.ts`, `ports.ts`, `view.ts`). Differences from the description above, each approved by the owner:

- **Compile.** `compileRun` loads the run export, verifies the chain (`verifyRunExport`), requires status `finished`, and turns the signed receipts into at most 20 steps with `compileFromReceipts`. Only a click's grounded role and exact name, a key chord, a scroll direction, a structural postcondition (`control_present`, `control_absent`, `url_path`) and a delivered file name are kept. Typed text is never stored (it is not in the receipts): each `type` step becomes an input the owner supplies when replaying. `read_document`, `object_visible` and prose postconditions refuse to compile with fixed codes and the step number. One script per source run (`replay_scripts.source_run_id` is unique).
- **No coordinates or crops.** Receipts hold neither, and stored coordinates go stale when the window scrolls. The click point is re-derived from the live page structure on every replay.
- **One check per step.** The two-method gate's second method is a model or SAM call, so a replay uses page structure only: exactly one visible control with the recorded role and exact name (or one focused text field for `type`/`key`), read again before input, then `desktop.verify` up to three times. Receipts record model `none`, route `replay`, confidence `medium`, zero usage and 0 micro-USD. `unknown` or a missing verifier is a mismatch.
- **No model on mismatch.** The runner has no provider in its dependencies. A mismatch writes a `blocked`/`fail`/`unknown` receipt, seals the run `needs_owner` and posts a fixed "Replay stopped at step N" card; TASK-044 then starts a bounded repair run and proposes a new replay version (§11.4).
- **Same run bookkeeping.** Checkpoint 0, then receipt, evidence and checkpoint per step, then the seal (a failed receipt stops the run). Chat runs and replays share one per-agent lock (`claimAgent`, kept on `globalThis` because they start from different route bundles).
- **Routes.** `POST /api/runs/[runId]/replay-script` (save), `GET /api/agents/[agentId]/replay-scripts`, `DELETE /api/replay-scripts/[scriptId]`, `POST /api/replay-scripts/[scriptId]/run` (202; body `{inputs}`, up to 64 KiB). A replay needs an active agent, a running desktop and the receipt signing key, not a model key.

### 11.4 Self-healing [M]

When a postcondition fails because the site changed, the agent:

1. re-plans visually
2. completes the step
3. proposes a **skill diff** ("what changed") for approval

**Implemented (TASK-044).** `lib/heal/` (`codes.ts`, `task.ts`, `view.ts`, `store.ts`, `heal.ts`, `ports.ts`), `lib/replay/diff.ts`, two tables and two proposal routes. A `needs_owner` replay with a site-change code (`target_missing`, `ambiguous_target`, `target_changed`, `unsupported_focus`, `postcondition_failed`, `postcondition_unknown`) starts one bounded model run (8 steps, 100k tokens, 5 min) from the live screen. It does not restore files or set a branch: TASK-043 owns rewind/branch. The fixed instruction is the signed run task; the saved step labels travel only in a code-built `web`-tagged context part (quoted, bounded, data only). The repair uses the agent's current Actions, two-method gate, verification, budgets, receipts, evidence and checkpoints. No heal for typed remaining steps, a pending proposal, no Main model, a busy agent, a stale version, takeover, limits or errors.

- **Proposal.** A sealed, finished, chain-verified repair compiles its receipts with the replay compiler; the steps before the failure are prefixed and the result is renumbered and re-validated (at most 20). A pending `replay_script_proposals` row stores the steps, the failed step and code, the replay run and the repair run (unique). "Why this changed" is fixed text chosen by the code plus the old step label; model prose is never shown. The chat card `skill_update` and the Saved replays badge open the same review, and the diff is computed against the version the replay actually ran.
- **Approval.** Approve appends `replay_script_versions` v(base+1) and marks the proposal approved in one transaction; `getScript`/`listScripts` resolve the latest version, so the next replay runs it. Reject, a second decision, a stale base and another owner change nothing. Versions are append-only for the app role; approval grants no permission and replay still checks the current Actions allowlist.
- **Limit.** The taught `SKILL.md` is not changed: a replay script has no link to a `skills` row and the two use different step models. Repair spend counts against the agent's budget.

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
- **Implemented (TASK-039/040):** one `routine.run` queue starts in the Next process via instrumentation, so chat/replay/routine runs share the per-agent lock. Enqueue and `next_run_at` commit in one Drizzle transaction; jobs use `SKIP LOCKED`, deterministic execution ids, `groupConcurrency: 1` per agent and two exponential-backoff retries. Run Now enqueues a `run_now` job; the routine card polls owner-scoped execution status and signed run detail every two seconds.

### 12.3 Sundance / Moondance [S] (implemented)

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

**Implemented (2026-11-04, owner-requested beyond v1 [M]):** check-ins live in their own `check_ins` table (migration 0038), not in `routines`, and are created in the agent's **Routines** tab (`/api/agents/<id>/check-ins`; list/create, pause/resume, delete, Check now).
- **Probe:** a page fingerprint. `lib/check-ins/logic.ts` builds one `shell.run` command that runs **as the agent in its own sandbox**: `curl` (https only, 20 s, 5 MB, ≤5 redirects) through the agent's egress relay, so its website allowlist, the private/metadata block and the tripwire apply, then `python3` strips scripts, styles, comments and tags and prints a SHA-256 plus up to 12,000 characters of text. The owner-entered URL must be plain https with no quote, `$`, space, backslash or backtick, and is single-quoted. No model is called.
- **Compare:** first check saves a baseline; same hash → "nothing new" and the quiet streak grows (4 quiet → 2×, 8 → 4×, max 12 h); new hash → streak resets, changed lines are counted (multiset diff). Page text is never put in a chat card or a model prompt.
- **Alert / wake:** Sundance (and Moondance marked *urgent*) posts a system card right away. Moondance otherwise counts changes and posts one summary card after its window closes. If the owner set a goal, the agent wakes **only on a change** through the normal chat run (`trigger: schedule`, label `Sundance · <name>`), with the goal plus line counts as its task, under its own permissions, budget and receipts.
- **Guards:** a paused agent, stopped crew, security stop or a check-in outside its hours is not probed; `shell_busy`/takeover → skipped; a failed fetch posts one card per outage. The tick runs beside the routine tick (one pass at a time, ≤12 claimed per minute with a 10-minute lease, 3 probes in parallel). Check now (owner, ≤ once per 30 s) runs the same path outside the hours.
- **Login walls:** fetch mode treats HTTP 401/403 or a password field as a login wall. The check-in switches to `via = browser`, resets its baseline, shows **Needs you: sign in** and posts one card asking the owner to take over and sign in (the agent never types credentials). Browser mode opens the page in the agent’s own Chromium (cookies persist across restarts), skips while the agent is running or the owner has taken over, and fingerprints the snapshot (title + up to 150 visible labelled links/buttons/fields; password fields are never listed). A login wall there is recognised by a login-style path or a near-empty page that is mostly a sign-in control. The owner can also pick browser mode when creating the check-in.
- **Not built:** webhooks-first, non-page probes (unread counts, API status), push notifications (alerts are chat cards).

### 12.4 Webhooks [S]

`POST /api/hooks/<id>` with a secret token starts a routine. Received payloads appear in the event log.

### 12.5 Jobs dashboard

A built-in page over pg-boss and the run tables, with no extra service or port.

- **[M]** Runs list (status, agent, trigger, start, duration, cost; filters and search), run detail (step timeline, receipts, I/O, errors, retry history), actions (Run now, Cancel, Retry, Pause/Resume) and upcoming runs in local time.
- **[S]** SSE live updates, a health strip (queue depth, failures in 24 h, "nothing new" rate), replay from the failing step and the webhook log.

**Implemented (TASK-042 Part A).** `/jobs` lists every owner-scoped run newest first (agent, outcome, date range and search filters; keyset paging by `(started_at, id)`), grouped outcomes (Verified, Finished, Needs you, Paused, Asked you, Canceled, Failed, Running, Not sealed), one grouped cost query per page, and a "Failed" view. `/jobs/[runId]` adds the signed task as input, the run's final card and delivered files, failed steps with their fixed codes, the retry chain and the existing proof timeline. Upcoming runs are computed from the `routines` table with `nextRoutineRun` in each routine's IANA timezone and grouped in the owner's timezone; paused routines are listed separately and can be resumed. Cancel aborts a run held by this app process, or sets `cancel_requested_at` for a run held by another process (TASK-085); Retry starts a fresh chat run from the signed task for a sealed, non-verified chat run. Run now and retrying scheduled runs wait for TASK-040. Display metadata (trigger, routine, replay script, retry-of, label) lives in the insert-only `run_meta` table, written by `receipts.begin()`; the signed header is untouched. **Part B (TASK-042, after TASK-040):** Upcoming runs and Crew actions mount the routine Run now component, which calls `POST /api/routines/[routineId]/run` and polls its execution view for queued/running/completed status. Retrying a sealed `schedule`/`run_now` job with a `routine_id` enqueues a new `run_now` execution with `retryOf`, so the new attempt's `run_meta.retry_of` points at the original; a routine run with no routine id and replay/branch/heal runs stay unretryable.

### 12.6 Starter crew and Mission Control (TASK-058)

**Starter crew.** `/crew` previews the six server-side templates (PR Reviewer, Dev Agent, Daily Briefer, Inbox Triage, Research Analyst, Travel & Booking Assistant). One Create request inserts `starter_crew_setups` (one per `owner_id`) and six `starter_crew_members`, each with a preallocated `agent_id` and state `pending | creating | created | failed`. The app identity is inserted once and audited once; provisioning retries reuse the same UUID. A member claim is an atomic `UPDATE ... RETURNING`; a live `creating` claim is left alone and a stale one can be resumed. A partial set keeps finished agents and the paused identity of a failed desktop, and Retry resumes only the failed members. Templates grant only what the normal create form could grant; missing accounts, domains and pinned tools remain setup rows.

**Mission Control.** `/api/crew/status` returns only the session owner's agents, the newest unsealed run with a heartbeat younger than 90 s, its step count and cost, today's spend in the owner's local day, pending approvals and the Main model label. Desktop status uses `session.status` only and never starts a sandbox or browser. The page polls every two seconds only while visible, holds one request at a time, renders at most four view-only noVNC thumbnails, and releases every stream on hide, unmount or logout. A thumbnail revalidates `/api/desktop/[agentId]/stream` with the same connection id immediately before opening its socket; a denied stream shows the stopped placeholder and never labels a cached frame live.

**Morning report (removed 2026-11-04).** Replaced by Schedules (`/schedules`, routines). There is no settings UI, route, `crew.report` queue or scheduler tick any more. The `crew_report_settings` and `crew_report_deliveries` tables from migration 0032 remain unused (dropping them needs a migration), and the `crew_report` chat card type stays so earlier report messages still render.

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
- Prompt rules: an agent checks its memory before saying it doesn't know something about the owner or earlier work, and says it will remember something only after it has made a write request. A write request still goes through the path above.
- Implemented (TASK-053/054): `memory_entries` holds current state and `memory_versions` is append-only per document (`user`, `agent:<id>:memory`, `agent:<id>:private`, `agent:<id>:soul`). Per-document advisory locks give gap-free versions and cap-safe concurrent writes. The persona (PERSONA.md, formerly SOUL.md) stays in `agents.soul_md`; the mirror also writes INSTRUCTIONS.md from `agents.instructions`. Agents can only `remember` (add-only, default-deny by their memory scopes); every request is scanned, stored as pending, shown as a diff, and applied only by an owner approval in one transaction with its version row. Undo appends a restore; pinned entries refuse body changes. One frozen snapshot per run is rendered into the stable instructions after the persona. The Markdown mirror is rewritten atomically after each commit and is never read back.

### 13.3 Nightly consolidation [M, TASK-086]

Implemented as `memory.tidy` (ADR-032): per document at 03:00 local or at 85% of cap, at most every 6 hours, using the Background model or Main. It may only propose `merge{ids,title,text}`, `shorten{id,text}` and `archive{id,reason}`; code accepts a merge or shorten only when at least 95% of its content words appear in the source entries. Pinned entries are never touched. Accepted operations apply in one transaction with one `batch_id`; each change has its own version, the chat shows one "Memory tidied: n merged, a archived" card, and one Undo restores the whole batch.

`memory.review` runs once per agent 120 s after chat activity with a per-agent message cursor, at most 5 changes, and the same origin gate as `remember`. Caps are USER.md 1,500, MEMORY.md 3,000, private 2,200 and the snapshot 8,000 characters. `search_history` is Postgres full-text (`simple`) over the agent's own chat only, returning up to five 300-character snippets tagged `document`.

Original design notes (safeguards):

- diffs are versioned
- pinned facts are never rewritten
- rewrites cite their source entries
- meaning-changing rewrites need approval
- untrusted-origin entries are never auto-consolidated
- the job is token-capped

---

## 14. Multi-agent work

v1 implements handoff and screenless helpers as specified in §6.6 (TASK-085/076, ADR-034): no shared folders, no per-pair Linux groups, no crew threads. The table below is the earlier **[S]** sketch, retained for post-v1 work.

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
/workspace/homes/<agent-uuid>/  owner: agent Linux user, mode 700
├── inbox/            uploads from the owner
├── outbox/           deliverables
├── work/             scratch, cloned repos
├── Downloads/        validated alias -> /downloads/<agent-uuid>
├── .config/chrome-for-testing/ browser profile (hidden from Files tab)
└── .cache/eclipse/doc-index/  derived document index (TASK-082; 0700/0600, never listed, checkpointed or restored)
```

- Each agent gets its own Linux user, screen, browser profile, credentials and files. There is no sudo and no access to other homes.
- Containers run non-root except ADR-026 trusted desktop administration. Desktop adds only the six approved bootstrap capabilities after cap-drop ALL, permanently removes SYS_ADMIN before normal operation, and applies an inherited syscall/ABI filter. Every agent has zero capability sets. Docker default AppArmor (desktop: the derived `eclipse-desktop` profile, ADR-038), read-only system paths, no-new-privileges and the pinned Chromium sandbox profile remain enforced.
- `app` also drops all capabilities and sets no-new-privileges. `npm run test:posture` validates the effective Compose posture (ports, mounts, networks, capability sets, secret scoping) and live non-root identities; `npm run test:agent-isolation` re-runs the cross-agent process, file, `/tmp`, display and network denials in both directions. Shared loopback is authenticated, not isolated, until TASK-071.
- Canonical `/downloads/<agent-uuid>` is mode 700 and mounted `noexec,nosuid,nodev`; its persistent source is inaccessible to agents under root-only `/workspace/.system`. Home/profile/subdirectories are mode 700. Alias changes and wrong ownership are rejected. `noexec` prevents direct execution, not interpreter use or copying elsewhere; approval/file-type checks remain later work.
- The desktop container never mounts the database, secrets or `.env`.

### 15.2 Content trust

| Source tag | Treatment |
|---|---|
| `user` | Trusted; may instruct |
| `agent` | Limited |
| `tool`, `web`, `email`, `document` | Untrusted data; never instructions |

- **Task scope [M]:** the owner's instruction fixes the allowed sites, items, amounts and recipients. Untrusted content may inform *how* a task is done, never change *what* it is. Implemented (TASK-049): scope hosts are the agent's `domains` allowlist, hosts named in the owner's text and the first readable page host; emails must appear in the owner's text. Only `type` is checked, because clicks, keys, scrolling and file delivery do not carry a destination the code can read. A refusal is a blocked receipt and one `security_events` row; the second refusal stops the run with `scope_blocked`. Matching is label- and IP-exact with look-alike and userinfo tricks resolved by the URL parser.
- **Files:** uploads are user-provided, but their *contents* are untrusted. Downloads are untrusted.
- **Taint tracking [S]:** once a run ingests untrusted content, out-of-scope actions (new destinations, sharing, permission changes, payments) need approval. Exfiltration-class actions are blocked even in Astra Mode.
- **Quarantined reader [S]:** untrusted content is first processed by a model call with **no tools** that returns structured data only.
- **Injection scanner [S]:** flagged items appear in the Security Center.

### 15.3 Secrets and network

- Credentials and API keys are encrypted at rest (key from `.env`) and injected by the egress proxy. They never enter model context. **[M]**
- Implemented master encryption uses a server-only 256-bit `ENCRYPTION_KEY` and versioned AES-256-GCM envelopes (`v1.<nonce>.<tag>.<ciphertext>`) through `lib/security/encryption.ts`. The key is passed only to `app`; malformed, tampered and wrong-key values fail without exposing plaintext or key material (ADR-027). **[M]**
- Implemented browser egress (TASK-045): `app` pushes each agent's domain allowlist to the proxy's memory-only registry every 60 s and on lifecycle/run changes; the desktop browser may `CONNECT` only to allowlisted HTTPS hosts, and private, loopback, link-local, CGNAT and metadata addresses are always refused. The desktop identifies itself with an HMAC token delivered over the supervisor's private pipe; `EGRESS_DESKTOP_SECRET` stays with the supervisor and proxy, and `EGRESS_PROXY_SECRET` stays with `app` and the proxy. Plain HTTP is redirected to HTTPS, never forwarded. Loopback remains shared until TASK-071 and HTTPS bodies are not inspected. **[M]**
- Secret inputs (passwords, OTPs) are typed by the executor from an **opaque, single-use, short-lived handle**. They are never stored in memory, skills, logs or receipts, and are masked in screenshots. **[M]**
- **Leak tripwire [M]:** each agent has its own canary secret (bait, stored encrypted; the proxy holds only its SHA-256). The app checks every `type` text before execution, including text split across steps and common encodings; the proxy checks the `CONNECT` host and plain-HTTP request line/headers before any resolve or connect. A match refuses the traffic, trips and latches the proxy, cancels the agent's other runs, stops its desktop, pauses it with `security_stop` and writes one append-only `security_events` row plus one card. Not detected: HTTPS bodies/paths, chat text, owner takeover typing and provider calls. The decoy `inbox/passwords-backup.txt` is planted once and is not recreated if deleted.
- Egress is default-deny with per-agent allowlists. Internal and metadata ranges are blocked. **[M]**

### 15.4 Approvals and Astra Mode

- **[M]** Default-deny role policy per agent: tools, domains, memory scopes, files, credentials and action types (send, delete, purchase, post, run downloaded files).
- **[M]** Risky actions prompt **Allow once / Always allow / Deny**. "Always allow" is stored per **agent + site + action (+ optional limit)** and is never global.
- **[S]** Approvals are keyed on arguments, not tool names (e.g. a new email recipient escalates).
- Implemented (TASK-050): a risky grounded click is classified by code from the control name and `expect` (download, send, post, delete, purchase, submit). The run waits for Allow once / Always allow / Deny; a timeout (10 minutes) or an app restart leaves the request `expired`, and a page that changed while waiting makes it `stale`. A grant is one row in `permissions` for exactly one agent, one exact host and one class, default 20 uses in a rolling 24 hours; revoking takes effect on the next action. Replay never waits: it needs a live grant with capacity, otherwise it stops with `approval_required`. Classification is heuristic—the page can label a destructive button neutrally—and an Enter key that submits a form is not classified. Astra Mode (TASK-051, implemented) removes only this prompt: the gate records `auto_allowed` and the step receipt carries `astra_allowed`.
- **[M]** **Astra Mode** (per agent) removes approval prompts only. It is enabled through a warning modal and shown with a red badge everywhere. These stay on: receipts, audit log, rewind, budget caps, tripwire, token isolation and the taint exfiltration block. Astra Mode never changes model safety behaviour.

### 15.5 Downloads, payments and sites

| Control | Priority |
|---|---|
| File-type policy by magic bytes (executables, scripts, installers, APKs and macro Office files blocked) | [S] |
| SHA-256 lookup against MalwareBazaar (hash only, never the file) | [S] |
| Kernel `noexec` Downloads | [M] TASK-011 |
| Office macro policy | [S] |
| Known payment-provider redirects allowed; look-alikes blocked; 3-D Secure / bank OTP always handed to the owner | [S] |
| Site rules: Full / Assisted / Assist-only (strict anti-bot and queue sites default to assist-only) | [S] |
| Never: CAPTCHA solving, bot-detection evasion, queue jumping, rush-refreshing | — |
| Optional ClamAV add-on | [L] |

### 15.6 Visibility and control [M]

- signed, append-only audit log
- kill switches: stop one agent / stop the whole crew
- Security Center: tripwire events, blocked actions, flagged injections

Implemented (TASK-052): `audit_log` is one hash chain per owner with an Ed25519 signature per entry over `eclipse-crew/audit-entry/v1\n<entry_hash>`; the canonical entry text is stored so it can be re-hashed offline. Writers take `pg_advisory_xact_lock(hashtext(owner), hashtext('audit'))`, so `seq` has no gaps. Login, account changes, agent lifecycle, approvals, Astra toggles, scope blocks, trips and egress blocks are recorded; kill switches log afterwards on a best-effort basis. `haltAgent` is latch egress → cancel in-process runs → stop desktop (best effort) → mark paused with one 2 s-locked UPDATE, each step independently time-bounded. `owner.crew_stopped_at` is set before Stop crew halts anyone; `prepare` in both chat and replay refuses while it is set, and the scheduler leaves `next_run_at` untouched. `/security` lists the owner's security events and full audit log, verifies the chain server-side and hosts Stop agent, Stop crew and Resume crew. `eclipse-crew verify-audit` checks an export offline; truncation at the end is only detectable against an earlier export or `--expect-seq`.

---

## 16. Authentication

| Aspect | Design |
|---|---|
| Accounts | Owner-created accounts (ADR-037), one isolated workspace each. The first is created at first run; `/setup` closes permanently afterwards. Extras come only from the host CLI (`account:create`); there is no signup, invites or admin role |
| Credentials | Email + Eclipse Crew password, hashed with argon2id |
| Sessions | Database-backed expiring/revocable records; HttpOnly, SameSite=Lax cookie (`eclipse_session` on HTTP, Secure `__Host-eclipse_session` on HTTPS); exact Origin and session-bound CSRF. Each session belongs to exactly one account and sees only that account's data. Settings → Account lists only live owner sessions, marks the current one, and "Sign out everywhere" revokes every other session. |
| Abuse | Per-login rate limiting (5 failures in 5 min lock that login for 15 min) plus a global ceiling (50 failures in 5 min lock everyone for 5 min); unknown emails take a dummy argon2 verify so timing reveals nothing |
| Changes | Change password / email requires the current password; a password change signs out other sessions |
| Recovery | `npm run reset-password -- --login <email>` on the host, with the new password supplied through private stdin; verified Compose image/network and least-privilege app role; password update and that account's session revocation are atomic; other accounts keep working |
| Future | Every table carries `owner_id`; accounts are equal peers with no admin role. The memory mirror roots at `<MEMORY_MIRROR_DIR>/<ownerId>/`, so accounts never share `USER.md` |
| 2FA [S] | TOTP (RFC 6238), off by default, 10 recovery codes, encrypted secret, `eclipse-crew reset-2fa` |
| Binding | `127.0.0.1` by default; remote access via Tailscale or Caddy + HTTPS |
| Future | Every table carries `owner_id` so team mode **[L]** needs no migration |

Setup, login, account credential changes and password recovery use the same transaction advisory lock. Migration `0039_multi_account` drops the `owner_singleton_idx` (index present only for migration counts 3–39); the login stays unique. Supported original-owner and sessions-schema migrations preserve rows/history, including historical LF/CRLF checksums; an unexpected migration history fails without deletion. The per-login lockout ignores caller-supplied forwarding headers.

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

Workspace and artifacts use Docker volumes rather than Windows bind mounts. This preserves Linux ownership and permissions and avoids the Windows host-file sharing path. `./data/memory` is the one intentional host bind mount, on `app` only (TASK-053); `desktop` never sees it. On a Linux host the folder must be writable by uid 1000.

TASK-009 developer feasibility is verified on Windows with Docker Desktop Linux engine 29.9.2 using a separate pinned Ubuntu fixture, one shared container and a fresh named home volume. Two real UIDs (20001/20002) retain mode-700 homes and synthetic file/profile markers after container recreation; 40 cross-user denial checks pass. Runtime has no effective capabilities, sudo, network, host mounts or published ports, and uses read-only root plus no-new-privileges. The spike runs no production services or model calls. Exclusive private evidence lives under ignored data/spikes/task-009/<uuid>/; cleanup checks exact labels, image identity and local-volume settings before removing only test resources.

Run 68cb4301-90ea-4b9d-b191-3d91327f7447 completed six bounded I/O rounds in 28.6 seconds overall: each 1,000-file/4 KiB create-read-rename-delete cycle took approximately 2.8–2.9 seconds, and 32 MiB sequential writes including fdatasync measured 416–592 MiB/s. Reads were cached (1347–1383 MiB/s). These shell-workload measurements establish feasibility on this machine, not a product SLA or a comparison against bind mounts. That spike did not implement production provisioning. TASK-011 now verifies stable identities/private layouts and Downloads noexec; TASK-012 now verifies screens/browser sessions; controller and live viewing are implemented by TASK-013–015.

### 17.2 Data model (initial)

| Table | Key fields |
|---|---|
| `owner` | id, owner_id (equal to id), login (unique, lowercase email), password_hash, timezone, crew_stopped_at, created_at. One row per account (ADR-037); no admin role, accounts are equal peers |
| `providers` | id, kind, base_url, encrypted_key, key_hint, enabled |
| `model_roles` | role, provider_id, model, use_main_key, mode, agent_id |
| `agents` | id, name, role, linux_user, screen, browser, status, astra_mode, avatar_variant, budgets, routing |
| `agent_policies` | agent_id, tools[], domains[], actions[], memory_scopes[], limits |
| `agent_canaries` (implemented TASK-047) | agent_id (PK, cascade), owner_id, encrypted_canary (ADR-027), canary_sha256 (unique), created_at, planted_at (once-only decoy claim) |
| `permissions` (implemented TASK-050/073c) | id, owner_id, agent_id (cascade), site (exact host, or `github.com/<owner>/<repo>` for a push grant), action_class `download/send/post/delete/purchase/submit`, max_per_day (default 20), created_at, revoked_at; one active row per agent + site + class. Revoking a git site also clears that agent+repo+class' unused proxy grants |
| `permission_uses` (implemented TASK-050) | id, owner_id, permission_id (cascade), nullable run_id, used_at; append-only, counted over a rolling 24 hours |
| `sessions` (implemented owner authentication) | id, owner_id, token_hash, csrf_token, created_at, expires_at |
| `chat_sessions` (implemented) | id, owner_id, agent_id, created_at; one owner-scoped conversation per agent |
| `messages` (implemented) | id, owner_id, session_id, role, card_type, jsonb content, source_tag, nullable run_id, created_at |
| `memory_entries` / `memory_versions` (implemented TASK-053) | entries: id, owner_id, doc `user/memory/private`, nullable agent_id (cascade), scope `global/agent/private`, visible_to[] (max 10), title/body (caps 1,375/2,200/2,200), pinned, trusted, status, author, source_run_id, source_label, version, timestamps; versions: owner_id, doc_key, seq, entry_id, agent_id, op, before/after jsonb, author, reason, source_run_id; unique (owner_id, doc_key, seq), append-only |
| `memory_changes` (implemented TASK-054) | id, owner_id, agent_id (cascade), run_id, doc, scope, title, body, reason, flags[], state `pending/approved/rejected`, result_version_id, created_at, decided_at; pending expires after 14 days |
| `audit_log` (implemented TASK-052, append-only) | id, owner_id, seq (unique per owner), kind (closed list), nullable agent_id/run_id/ref/code/host/source_ref (unique per owner), entry_json, entry_hash, prev_hash, signature, key_id, created_at |
| `skills` / `skill_versions` (implemented TASK-037) | owner_id, agent_id, capture_id, name, description, source, status, version, body, reference_shots; versions are append-only |
| `routines` (implemented TASK-038) | owner_id, agent_id, source_message_id, skill_id, goal, steps, schedule, schedule_spec, timezone, next_run_at, tools, budget_cents, catch_up, active, mode |
| `check_ins` (Sundance/Moondance, migration 0038) | owner_id, agent_id, name, kind (`sundance`/`moondance`), url, via (`fetch`/`browser`), goal, urgent, interval_minutes, window_start/end, timezone, active, fingerprint, snapshot (≤12,000 chars, server-only), quiet_streak, pending_changes, last_status, next/last check times |
| `runs` (implemented TASK-029) | id, owner_id, agent_id (no FK), branch_of, header_json, header_hash, key_id, public_key, started_at, status, ended_at, step_count, head_hash, usage, signature; index (owner_id, started_at desc) for the Jobs list |
| `run_meta` (implemented TASK-042, insert-only) | run_id (PK, references `runs`), owner_id, agent_id (no FK), trigger `chat/run_now/schedule/replay/branch/heal/handoff/subagent`, routine_id (set null), execution_id (TASK-039, nullable, indexed with owner; shared by retries), replay_script_id (set null), retry_of (references `runs`), handoff_of (references `runs`, TASK-085), parent_run_id (references `runs`, indexed, TASK-076), label (1-120 chars), created_at. `runs` also has nullable `heartbeat_at`, `cancel_requested_at` and the partial heartbeat index (TASK-085) |
| `steps` (implemented TASK-029, append-only) | id, owner_id, run_id, idx, receipt_json, receipt_hash, prev_hash, created_at; unique (run_id, idx); checkpoints are separate rows (`checkpoints`) |
| `step_evidence` (implemented TASK-031, insert-only) | id, owner_id, run_id, idx, before_hash, after_hash, width, height, sam_box (jsonb, annotation), created_at; unique (run_id, idx) |
| `checkpoints` (implemented TASK-032, insert-only) | id, owner_id, run_id, idx (0 = before the first step), state_hash, manifest_hash (null when partial), file_count, restorable_count, status complete/partial, reason, created_at; unique (run_id, idx) |
| `replay_scripts` (implemented TASK-041) | owner_id, agent_id (cascade), source_run_id (unique, references `runs`), name, steps (jsonb, validated by `lib/replay/script.ts`: no coordinates, no typed text), step_count (1-20), created_at; app role has SELECT, INSERT and DELETE only |
| `replay_script_versions` / `replay_script_proposals` (implemented TASK-044) | versions: owner_id, script_id (cascade), version >= 2, steps, step_count, source_run_id (the repair run), created_at; unique (script_id, version); append-only. Proposals: owner_id, agent_id (cascade), script_id (cascade), base_version, proposed_version (= base + 1), failed_step, failure_code (site-change codes), replay_run_id, heal_run_id (unique), steps, step_count, status `pending|approved|rejected`, decided_at, created_at; at most one pending per script |
| `cost_entries` (implemented) | owner_id, run_id, agent_id, provider_id, call_index, model, tokens_in, tokens_out, tokens_cached, cost_micro_usd (bigint), outcome, idempotency_key = `cost:<run_id>:<call_index>`, `teach:<capture>:asr:<sequence>` or `teach:<capture>:skill:<call_index>` (unique), created_at; append-only |
| `model_prices` (implemented) | owner_id, provider_id, model, input/cached/output micro-USD per 1M tokens, image micro-USD per 1K; unique owner + provider + model |
| `approvals` (implemented TASK-050/073c) | id, owner_id, agent_id (no FK, so history survives deletion), nullable run_id, action_class, site (exact host, `github.com/<owner>/<repo>` for a push, or empty), control_name (page- or push-derived, 1-120 chars), state `pending/allowed_once/always_allowed/denied/expired/stale/auto_allowed`, decided_at, created_at |
| `security_events` (implemented TASK-047/049, append-only) | id, owner_id, agent_id (no FK), kind `canary_leak/scope_blocked`, source `typed_text/proxy_host/proxy_request/scope_host/scope_recipient/scope_page`, nullable run_id, unique nullable source_ref (`typed_text:<run>:<step>` or `<boot>:<seq>`), created_at; no free text |
| `connections` | agent_id, preset, label, bindings, encrypted_token, token_hint, encrypted_refresh_token, token_expires_at, refresh_expires_at, source, status |
| `github_device_flows` | agent_id, label, encrypted_device_code, user_code, verification_uri, interval_seconds, status, error_code, connection_id, expires_at |
| `traveller_profiles` | encrypted_blob, allowed_agents[] |
| `backups` | target, status, size |

The implemented Drizzle schema defines `owner`, authentication `sessions`, `agents`, `agent_policies`, `agent_canaries`, `security_events`, `skills`, `skill_versions`, `chat_sessions`, `messages`, `routines`, `providers`, `model_roles`, `runs`, `run_meta`, `steps`, `step_evidence`, `checkpoints`, `replay_scripts`, `replay_script_versions`, `replay_script_proposals`, `model_prices`, `cost_entries`, `approvals`, `permissions`, `permission_uses`, `audit_log`, `memory_entries`, `memory_versions`, `memory_changes`, `memory_review_state`, `connections`, `github_device_flows`, `mcp_servers`, `composio_keys`, `composio_accounts` and `teach_recordings`. `agents` stores owner scope, name, role, `instructions` (role expertise, up to 4,000 characters; blank saves the role-based default; migration 0037), `soul_md` as the optional Persona (identity and voice, shown as PERSONA.md; 0037 moved the old single persona text into `instructions`), `active`/`paused` status, `astra_mode`, an `avatar_variant` (0-11, migration 0036) selecting one of 12 local voxel avatars — assigned at random on creation (single, custom-crew and starter-crew agents) and changeable via Shuffle in the create/edit forms — integer-cent daily/monthly budgets and a nullable attention reason (`budget_warning`, `budget_paused`, `security_stop` or `approval_pending`) for the workspace's persistent "Needs you" state; `agent_policies` stores default-deny tool, domain, action and memory-scope allowlists, plus `any_public_web` (ADR-036, migration 0037): when true the egress proxy allows any public hostname for that agent and ignores `domains`, while internal, LAN and metadata addresses stay blocked. New agents default to true; existing agents and starter templates stay false. `agent_canaries` holds the encrypted bait secret and its hash; `security_events` is append-only and survives agent deletion. `approvals` records every owner decision, `permissions` holds scoped grants and `permission_uses` is append-only. Chat messages store validated card JSON (including the `approval` card), a source tag and an optional run reference; the runtime has append-only access to both chat tables, while agent deletion cascades through them. `providers` stores owner scope, kind, optional compatible base URL and application-encrypted key plus hint; `model_roles` stores one owner-scoped Main/SAM row, its provider reference, model and same-key/mode flags. `model_prices` holds owner-editable rates and `cost_entries` holds one append-only row per attempted model call. Migrations `0000`-`0033` add these tables and constraints (0032 is the concurrent crew-report/starter-crew change; 0033 adds `run_meta.parent_run_id` and the `subagent` trigger). Runtime and migration connections use separate `DATABASE_URL` and `MIGRATION_DATABASE_URL` values. TASK-064 provisions the separate database roles and private database network; TASK-065 supplies master-key setup and authenticated encryption; TASK-029/031/034 provide signed proof, display evidence and spend history.

`.env.example` documents three separate database passwords and the runtime/migration URLs without supplying credentials. Compose mounts password secrets only into Postgres and gives the app only its runtime URL. Server-only validation rejects incorrect role URLs; database initialization verifies the authenticated role and releases failed initialization attempts so a later call can recover. CLI configuration loads `.env` with shell values taking precedence. No configuration substitutes the bootstrap account for either role. Migration SQL uses LF in Git; provisioning accepts the known migration's LF/CRLF hashes while preserving stored history and rejecting other hashes.

The app renders dynamically. A fresh per-request nonce connects CSP to Next.js scripts and styles; production forbids script eval and inline scripts without a nonce. Redirects, errors and native upgrade refusals retain security headers. Production HSTS follows the configured HTTPS `APP_ORIGIN`, never an untrusted forwarding header. Ingress overwrites forwarding headers and the app trusts only the exact ingress DNS peer. Browser acceptance uses disposable profiles; personal browser access is unnecessary. A real external HTTPS deployment remains unverified.

New artifacts volumes inherit ownership from the image's UID/GID 1000 directory. Existing project-managed local artifacts volumes can be repaired explicitly with `npm run artifacts:repair` while the app is stopped. The helper verifies the selected Compose container, volume labels, local driver and image; it mounts only that volume with no network or secrets and never follows symlinks outside it.

```mermaid
erDiagram
  agents ||--o{ agent_policies : has
  agents ||--o{ agent_canaries : carries
  agents ||--o{ permissions : grants
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
- **[M]** Cost rows are only ever added (`cost_entries`, one per model call), keyed `cost:<run_id>:<call_index>` so a retried job cannot count a call twice. Calls that fail, return invalid output or are cancelled are billed too, because the tokens were spent. Costs are whole millionths of a US dollar, rounded up per call; budgets stored in cents are compared as `cents × 10,000`.
- **[S]** A pre-save estimate on routine cards ("≈ $0.03/run") and a spend dashboard.

TASK-034 implements the agent daily/monthly half of the budget requirement. Before every Main, fallback, visual or SAM call, the runtime reads the live owner-scoped ledger for the owner-timezone day and month, resolves the current price, compares integer micro-USD with `cents × 10,000`, warns once per run at 80%, and at 100% pauses the agent, persists `budget_paused` attention and makes no further call. Two runs that both pass the same pre-call check may each spend one call before the shared total pauses them. Cost rows use the provider/model snapshot and `cost:<run_id>:<call_index>` idempotency; failed calls are recorded with zero usage when the provider reports none, and returned incomplete/invalid/cancelled usage is retained. Each signed step receipt carries the cost added since the previous step, while `GET /api/runs/<id>/cost` is the run-level receipt that also covers finish/invalid calls with no step. Built-in rates match the verified Meta prices in PRD §9; SAM is charged per 1K images; local OpenAI-compatible endpoints are $0; an unpriced hosted model stops with `price_required`. Routine budget enforcement remains for TASK-038/039.

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
- **[M]** A `get_time(timezone?)` tool covers long runs. Built (TASK-026) as a `next_step` action, because the provider layer cannot return tool output yet: the loop answers it in code from the injected clock and shows the answer in the next turn's history. Only validated IANA names are used or echoed. Every agent model call must end its `instructions` with `withClock(...)` from `lib/time/clock.ts`; the clock is rounded to the minute so the text before it stays cacheable.
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
| History tab **[M]** | Built (TASK-031, TASK-043): the selected agent's runs and each run's step timeline with before/after screenshots, the SAM outline, pass/fail, a chain badge, Export, rewind controls and branch badges/links. The original run stays read-only. |
| Expanded desktop view **[M]** | Full screen on the live desktop opens an expanded view inside the app window (the app header stays; no browser fullscreen). The same noVNC stream moves into it without reconnecting; takeover / hand back work there. View-only on phones. See `docs/DESIGN.md` |
| Jobs | Dashboard (§12.5) |
| Security Center | Events, blocked actions, injections |
| Settings → Models | Role cards (§8.2) |
| Mission Control [S] | All agents' live thumbnails, current step, spend |
| PWA [S] | Installable; push for approvals, hand-offs, alerts, reports |

Implemented workspace shell: at ≥1280 px the 260 px agent pane, flexible chat and resizable 380 px–50 vw right panel are separated by borders; at 768–1279 px the agent rail is 56 px and agent/panel sheets overlay chat; below 768 px Agents, Chat and Panel switch through a bottom bar. The center pane loads per-agent history, sends bounded text through the authenticated chat route, renders the four validated card types and polls the visible timeline for server-appended results. The right panel's Desktop tab mounts the existing authenticated noVNC view; the other tabs show honest empty states, and Settings links to the account page. Layout resolves before desktop children mount, so an unknown viewport cannot start a hidden stream.

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
  Proxy->>Proxy: canary match, latch trip + fixed event
  RT->>Proxy: poll /v1/events every 3 s
  RT->>RT: stop desktop, cancel runs, pause, card
  RT->>RT: auto-rewind to pre-compromise checkpoint [S]
  RT-->>RT: list external actions since compromise
```

Implemented (TASK-047): the app also checks every `type` text before execution, including split steps and common encodings. The proxy checks the `CONNECT` host and plain-HTTP request line/headers before DNS or connect. Events and logs carry no host, path or canary text. HTTPS bodies/paths, chat text, owner takeover typing and provider calls are not inspected.

### 23.3 Routine replay with self-heal

```mermaid
flowchart LR
  T[Scheduled tick] --> R[Replay script<br/>no model calls]
  R --> P{Postcondition<br/>matches?}
  P -- yes --> Done[Receipt, $0 model cost]
  P -- no --> SH[Self-heal: visual re-plan<br/>via Main AI + perception]
  SH --> D[Skill diff proposed]
  D --> A[Owner approves on phone]
  A --> U[Replay script v2 active]
```

---

## 24. Non-functional requirements

| Area | Target |
|---|---|
| Resources (estimates) | Min 2 vCPU / 4 GB / 40 GB (1–2 active agents); rec. 4 vCPU / 8 GB / 80 GB (3–5); heavy 8 vCPU / 16 GB / 160 GB. No GPU required. Base stack ~1.5–2 GB RAM; each active Chrome ~0.5–1.5 GB. x86-64 recommended. |
| Latency | UI actions < 400 ms; live desktop visible within 2 s |
| Reliability | Routines resume after restart; catch-up policy; idempotent jobs |
| Setup | `docker compose up` to first agent ≤ 15 min on a clean machine |
| Privacy | All data on the user's disk; no telemetry by default |
| Portability | Same compose file on Windows, macOS and Linux |
| Accessibility | WCAG 2.2 AA |
| Licensing | Chrome for Testing downloaded at build, never redistributed; SAM weights never shipped |

Idle browsers are suspended to save RAM **[S]**.

---

## 25. Open questions

1. Windows volume feasibility verified by TASK-009; desktop image verified by TASK-010; persistent identities/private layouts and Downloads noexec verified by TASK-011; agent screens/profile lifecycle verified by TASK-012; authenticated controller/live view/takeover are verified by TASK-013–015.
2. Computer-use replay cap (reported at 29 pairs) and SAM video billing minimum.
3. Voice Transcribe pricing, rate limits and prompt-caching behaviour.
4. uBlock Origin Lite and Safe Browsing on the Linux Chrome for Testing build.
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


## TASK-071–073 additions (2026-11-02)

Every agent session now runs in its own user and network namespace: `netns-enter.py` maps the agent uid to itself, creates `CLONE_NEWUSER` + `CLONE_NEWNET`, brings `lo` up, drops every capability set, and `execp`s the worker. Only loopback exists inside; `getifaddrs` sees `lo` alone. The supervisor owns `/run/eclipse-ns/` (0711) and `/<agentId>/` (agent, 0700). A supervisor relay listens on `egress.sock` (root, 0600) and injects the per-agent `EGRESS_DESKTOP_SECRET` proxy token outside the namespace; the worker forwards `127.0.0.1:3128` to it, so Chrome never holds the token. VNC is a pathname socket `vnc.sock` relayed to x11vnc's loopback port; the controller connects by path. Sessions fail closed if the namespace, socket or relay is missing. The optional mock vendor and the cookie test fixture run inside the session namespace (`fixture.mock_vendor`; `session-fixture-cookie` with `ECLIPSE_FIXTURES=1`, passed to the worker through an `ECLIPSE_FIXTURES=1`-only `extraEnv` allowlist). TASK-072 adds `mcp_servers` (pinned tool hash + snapshot), an in-house Streamable HTTP MCP client, a code-side risk table and the `tool_call{name,args}` action whose results are `tool`-tagged and never stored. TASK-075 adds owner-level Composio keys, per-agent connected accounts, pinned tool lists, sessions built with `instant:false` and no sandbox, and REST calls through the proxy. TASK-073 M1 adds `shell{command,cwd?,timeout?,expect}`, run as the agent inside its namespace with a 60 s default, bounded output, its own process group and a command hash (never the text) in receipts. M2 is built: git 2.43.0 in the pinned lock, the 4322 gateway and relay preface (073b), and owner approvals for protected pushes (073c) with pending/single-use grants and a fresh push-only retry step after consent.
