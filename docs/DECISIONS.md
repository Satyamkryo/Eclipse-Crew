# Architecture Decisions

Permanent technical decisions for Eclipse Crew. Current project state lives in `docs/MEMORY.md`; full design in `docs/ARCHITECTURE.md`.

<!--
Rules for AI agents:
- Accepted decisions are binding. Do NOT change, work around, or "improve" them in code. If a task seems to need a different choice, stop and ask the owner.
- Never edit or delete an accepted ADR. To change one, the owner approves a NEW ADR that says "Supersedes ADR-NNN"; then set the old one's status to "Superseded by ADR-MMM" (the only allowed edit).
- Add an ADR only for choices that are hard to reverse or affect several parts of the system (stack, storage, security model, protocols). Not for naming, styling or small library picks.
- Format: 4–6 lines per ADR (Status, Decision, Reason, optional Rejected). No essays, no code. Link to docs for detail.
- Numbers are sequential and never reused. Add the ADR to the index in the same edit.
- To save tokens: read the index first; open an ADR only if your task touches its area.
-->

## Index

| ADR | Decision | Status |
|---|---|---|
| 001 | Self-hosted Docker Compose stack, no hosted SaaS | Superseded by ADR-024 |
| 002 | Next.js full-stack + TypeScript, no separate backend | Accepted |
| 003 | PostgreSQL + Drizzle ORM | Accepted |
| 004 | pg-boss for jobs, not Inngest | Accepted |
| 005 | One shared desktop container, OS-level isolation per agent | Accepted |
| 006 | Chromium by default; Chrome optional | Accepted |
| 007 | `playwright-core` as a library; MCP only for external tools | Accepted |
| 008 | Model-agnostic perception layer with intent schema | Accepted |
| 009 | Any model provider; Meta is the default | Superseded by ADR-023 |
| 010 | SAM 3.1 optional, off by default, weights never shipped | Accepted |
| 011 | Egress proxy injects all credentials | Accepted |
| 012 | Hash-chained, Ed25519-signed proof receipts | Accepted |
| 013 | Content-addressed per-step checkpoints | Accepted |
| 014 | Single-owner auth bound to `127.0.0.1` | Accepted |
| 015 | Docker volumes for data, not host bind mounts | Accepted |
| 016 | Postgres is the memory source of truth; Markdown is a mirror | Accepted |
| 017 | Clock block after the cached prompt prefix | Accepted |
| 018 | Deterministic replay of verified routines | Accepted |
| 019 | Astra Mode removes approval prompts only | Accepted (name provisional) |
| 020 | Contributor mode is opt-in only | Accepted |
| 021 | Speech always becomes text before the Main AI | Accepted |
| 022 | Apache-2.0 license | Proposed |
| 023 | Three provider connectors: native Meta, OpenAI-compatible, Anthropic-compatible | Accepted |
| 024 | Self-hosted Compose stack with localhost ingress | Accepted |
| 025 | Desktop Chromium sandbox seccomp profile | Superseded by ADR-026 |
| 026 | Trusted desktop setup and unprivileged agent identities | Accepted |
| 027 | Master encryption key and authenticated AES-256-GCM envelopes | Accepted |
| 028 | Shell action for software development | Accepted |
| 029 | Composio integration, opt-in | Accepted |
| 030 | Screenless subagents | Accepted |
| 031 | Chrome for Testing as the desktop browser | Accepted (supersedes ADR-006 after the TASK-078 spike passes) |
| 032 | Origin-gated memory auto-save | Accepted |
| 033 | GitHub App device sign-in for connections | Accepted |
| 034 | Handoff between agents | Accepted |
| 035 | Owner-created crews with crew-scoped handoff | Accepted |

---

## ADR-001: Self-hosted Docker Compose stack
Status: Superseded by ADR-024 · 2026-10-28
Decision: Ship as one `docker compose up` with four services: `app`, `postgres`, `desktop`, `egress-proxy`. Same file on Windows, macOS and Linux VPS.
Reason: Users own the machine and the data; no hosted infrastructure to run or pay for.
Rejected: Hosted SaaS, Vercel deployment, per-agent cloud sandboxes (E2B).

## ADR-002: Next.js full-stack + TypeScript
Status: Accepted · 2026-10-28
Decision: Next.js (App Router) for UI and API route handlers, plus TypeScript worker processes in the same `app` service. Tailwind CSS, shadcn/ui, Zod at every boundary.
Reason: Chosen in the PRD tech stack (§7.3); no alternative was compared.
Rejected: NextAuth/Vercel (from the earlier Gemini spec).

## ADR-003: PostgreSQL + Drizzle ORM
Status: Accepted · 2026-10-28
Decision: All structured data in a local PostgreSQL accessed through Drizzle. Postgres full-text search for conversation search. Every table carries `owner_id`.
Reason: Postgres holds all structured data and the pg-boss queue (ADR-004). `owner_id` lets team mode come later without a migration. Drizzle is from the PRD tech stack (§7.3).
Rejected: Vector DB for memory.

## ADR-004: pg-boss for jobs
Status: Accepted · 2026-10-28
Decision: pg-boss inside our Postgres, with a one-minute scheduler tick over the `routines` table, idempotency key `routine_id + scheduled_at`, and concurrency 1 per agent.
Reason: MIT license, no extra container; durability comes from our own step checkpoints.
Rejected: Inngest (self-host single-node is beta, SSPL license).

## ADR-005: Shared desktop, OS-level isolation
Status: Accepted · 2026-10-28
Decision: One Linux desktop container. Each agent gets its own Linux user, `700` home, Xvfb screen and Chromium profile. No sudo. The desktop container never mounts the database, `.env` or secrets.
Reason: Grok Bot's bots share cookies, logins and files; here isolation is enforced by the OS, not the prompt.
Rejected: E2B sandbox per agent.

## ADR-006: Chromium by default
Status: Accepted · 2026-10-28
Decision: Bundle Chromium. Google Chrome only as an option downloaded on the user's machine.
Reason: Chromium is BSD-licensed and redistributable; Google Chrome is never redistributed.

## ADR-007: `playwright-core` as a library
Status: Accepted · 2026-10-28
Decision: `playwright-core` (Apache-2.0) runs inside the desktop image, driven by desktop-controller. MCP is used only for external tools (GitHub, Slack, …).
Reason: Decided in planning session 2; the reason wasn't recorded.
Rejected: Playwright MCP for browser control.

## ADR-008: Model-agnostic perception layer
Status: Accepted · 2026-10-28
Decision: Models emit `{action, target, expect}`, never raw coordinates. Grounding cascade: page structure → set-of-marks → SAM → model computer use → user. Irreversible actions need two agreeing methods.
Reason: Same behaviour, receipts and safety for every model; weaker models ask more instead of misclicking.

## ADR-009: Any model provider
Status: Superseded by ADR-023
Decision: Provider layer with an OpenAI-compatible adapter plus a native Meta adapter. Separate role cards (Main AI, SAM, Voice, Images, Background). Tool calling is the minimum.
Reason: Bring-your-own-model; Meta is the default and best supported, not mandatory.

## ADR-010: SAM 3.1 optional
Status: Accepted · 2026-10-28
Decision: SAM is off by default; Meta API or local NVIDIA GPU when enabled. Weights are downloaded by the user under Meta's license, never shipped in our images.
Reason: Everyday websites work well without it; the weights are under Meta's SAM License.

## ADR-011: Egress proxy injects credentials
Status: Accepted · 2026-10-28
Decision: All outbound traffic from desktop and tools goes through `egress-proxy` (default-deny allowlists, credential injection, canary tripwire). Keys are encrypted at rest with the `.env` key.
Reason: The model and the sandbox never see API keys or tokens.

## ADR-012: Signed proof receipts
Status: Accepted · 2026-10-28
Decision: One receipt per step, hash-chained per run (`prev_hash`), run signed with an Ed25519 key generated at install. `eclipse-crew verify` checks offline.
Reason: Proof over claims; anyone can verify a run offline.

## ADR-013: Content-addressed checkpoints
Status: Accepted · 2026-10-28
Decision: After every step, store context/task state and changed home files by hash in the `artifacts` volume. Rewind creates a new branch (`runs.branch_of`).
Reason: Cheap incremental storage and rewind without re-running earlier steps.

## ADR-014: Single-owner auth
Status: Accepted · 2026-10-28
Decision: One owner per install, no signup. Email + password (argon2id), server-side sessions, CSRF, rate limits. App bound to `127.0.0.1:3000`; remote access via Tailscale (recommended) or Caddy HTTPS. Reset via host CLI.
Reason: Self-hosted installs have no mail server; binding to localhost avoids accidental exposure.
Rejected: Multi-user in v1, email verification, binding to `0.0.0.0`.

## ADR-015: Docker volumes for data
Status: Accepted · 2026-10-28
Decision: `workspace`, `artifacts` and `postgres` are Docker-managed volumes. Only `./data/memory` (Markdown mirror) is a host folder.
Reason: Much faster on WSL 2 and keeps Linux file ownership, which isolation depends on.
Rejected: Windows/host bind mounts for agent files.

## ADR-016: Memory in Postgres
Status: Accepted · 2026-10-28
Decision: Postgres is the source of truth for `SOUL.md`, `USER.md`, `MEMORY.md` and skills; Markdown mirrored to `./data/memory`. Single-writer queue, versioned, frozen snapshot per session.
Reason: Safe concurrent writes and undo, while staying human-readable.

## ADR-017: Clock block after the cached prefix
Status: Accepted · 2026-10-28
Decision: Inject the current date/time/timezone into every model call after the cached prefix. Relative dates are resolved by code; timestamps stored in UTC + IANA timezone.
Reason: Agents always know "now" without breaking prompt caching.

## ADR-018: Deterministic replay
Status: Accepted · 2026-10-28
Decision: A verified run compiles into a replay script (selectors, crops, coordinates, postconditions). Later runs call the model only on a postcondition mismatch.
Reason: Repeat runs cost $0 in model fees and are more reliable.

## ADR-019: Astra Mode scope
Status: Accepted (name provisional) · 2026-10-28
Decision: Per-agent Astra Mode removes approval prompts only. Receipts, audit log, rewind, budgets, tripwire, key isolation and the post-taint exfiltration block stay on.
Reason: Autonomy for trusted routines without disabling safety layers.
Rejected: Jailbreak-style "godmode".

## ADR-020: Contributor mode opt-in
Status: Accepted · 2026-10-28
Decision: `muse-spark-1.3-contributor` is an explicit setting, never on by default. The hackathon build itself uses it.
Reason: Much cheaper, but Meta may use the data; users must choose it knowingly.

## ADR-021: Speech becomes text first
Status: Accepted · 2026-10-28
Decision: Voice is transcribed (Voice Transcribe, any STT, or local `whisper.cpp`) before the Main AI sees it. Cleanup is a stateless call with no tools, memory or persona.
Reason: Any Main AI works with voice, and spoken words can't trigger actions through the cleaner.

## ADR-022: License
Status: Proposed · 2026-10-28
Decision: Apache-2.0.
Reason: Patent grant and trademark clause. Waiting for owner confirmation.

## ADR-023: Three provider connectors
Status: Accepted · 2026-10-29 · Supersedes ADR-009
Decision: The provider layer has three connectors behind one interface: native Meta (Muse, computer use), OpenAI-compatible (base URL + key), and Anthropic-compatible (Messages API, base URL + key, with prompt-cache markers). Separate role cards (Main AI, SAM, Voice, Images, Background). Tool calling is the minimum. Meta stays the default.
Reason: Owner decision. Claude and other Anthropic-format endpoints need their own request format for tool calling, images, caching and computer use; everything else is covered by the OpenAI-compatible connector.

## ADR-024: Self-hosted Compose stack with localhost ingress
Status: Accepted · 2026-10-30 · Supersedes ADR-001
Decision: Use one self-hosted Docker Compose stack with the four core services `app`, `postgres`, `desktop`, and `egress-proxy`, plus a fixed-purpose `ingress` service bound to `127.0.0.1:3000`. The app remains on internal-only networks.
Reason: Docker does not publish a host port for a container attached only to internal networks. The owner approved separate ingress to preserve app isolation and localhost access.

## ADR-025: Desktop Chromium sandbox seccomp profile
Status: Superseded by ADR-026 · 2026-10-31
Decision: Only desktop uses a pinned profile derived from official Playwright 1.64.1 (upstream SHA256 cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849; applied SHA256 fa1e603f170044c931a103bfbe3bac6cfc6c935bdc72408e01c4cf6425cde627). It permits clone/setns/unshare and Chromium’s namespace-local chroot. Kernel capability checks still deny chroot to the ordinary container process. Other services keep Docker default seccomp. Non-root, no-new-privileges, cap-drop ALL, read-only root, isolated networks and unpublished ports remain mandatory.
Reason: Docker default blocks namespace creation; the unmodified upstream profile also gates chroot on an outer capability that cap-drop ALL removes. Chromium needs that syscall within its private user namespace to narrow its filesystem view.
Rejected: disabling Chromium sandbox, seccomp=unconfined, privileged containers, added SYS_ADMIN capabilities or global host-kernel changes.

## ADR-026: Trusted desktop setup and unprivileged agent identities
Status: Accepted · 2026-10-31 · Owner approved · Supersedes ADR-025
Decision: The shared desktop starts a trusted root bootstrap with only CHOWN/DAC_OVERRIDE/SETUID/SETGID/SETPCAP/SYS_ADMIN to prepare NSS views and persistent noexec Downloads. Before normal operation it permanently drops SYS_ADMIN, applies an inherited restrictive syscall filter, and retains only the five provisioning/UID-switch capabilities. Every agent has a distinct UID/GID, zero capability sets and no-new-privileges. Keep ADR-025’s pinned Chromium sandbox profile, read-only root, isolated networks and unpublished ports; other services keep existing roles/policies.
Reason: An entirely unprivileged shared service cannot provision users, ownership or mounts. Trusted administration must be separate from agent execution. Python PID 1 reaps children after reducing privileges, so a separate init does not retain bootstrap permissions.
Rejected: privileged containers, SYS_ADMIN retained after setup, agent sudo/setuid privileges, host/Docker-socket mounts, writable system root, per-agent containers or disabling browser/Downloads protections.

## ADR-027: Master encryption key and authenticated AES-256-GCM envelopes
Status: Accepted · 2026-11-01 · Owner approved
Decision: Keep one server-only 256-bit `ENCRYPTION_KEY` (64 lowercase hex characters) in `.env` and encrypt sensitive values with AES-256-GCM using a fresh 12-byte nonce and 16-byte tag. Store a versioned canonical base64url envelope `v1.<nonce>.<tag>.<ciphertext>`; reject malformed, tampered, unsupported and wrong-key values with a generic error.
Reason: Node's built-in authenticated encryption covers future provider keys, connection tokens and sensitive blobs without another dependency; the versioned format leaves explicit room for migration.
Rejected: unauthenticated encryption, storing plaintext, exposing the key to browser/desktop/models, and silent key rotation that would make existing ciphertext unreadable.

## ADR-028: Shell action for software development
Status: Accepted · 2026-11-01 · Owner approved
Decision: Agents may run shell commands through a `shell` action, as their own Linux user, confined to their home, in a private per-agent network namespace whose only way out is the egress proxy. No sudo, time and output limits, output tagged `tool` and untrusted. Committing, pushing to a new branch and opening a PR need no approval; pushing or force-pushing to the default branch, deploying and deleting remote branches or repositories need approval, enforced at the proxy rather than by parsing commands. Astra Mode may remove those prompts (ADR-019). Extends ADR-008, which covers screen actions only.
Reason: Owner decision to support software development and PR work in v1; containment comes from the OS and the proxy, not the prompt.
Rejected: root or sudo for agents, a shared `localhost` between agents, approval rules based only on command text.

## ADR-029: Composio integration, opt-in
Status: Accepted · 2026-11-01 · Owner approved
Decision: Composio is an opt-in integration using the owner's own Composio key, saved encrypted (ADR-027). Calls go through the egress proxy and accounts are connected per agent. Connected-account tokens are held in Composio's cloud, and the README says so plainly. MCP remains the path that keeps tokens on the owner's machine.
Reason: Owner decision to offer breadth (1,000+ apps) in v1 without writing each integration.
Rejected: making Composio required, hiding where its tokens live.

## ADR-030: Screenless subagents
Status: Accepted · 2026-11-01 · Owner approved
Decision: An agent may spawn up to 3 subagents per run, one level deep. Subagents have no screen, never more permissions than the parent, inherit its taint, and run within step and time limits (20% of the parent's each; budget slices once budgets exist). Their results return to the parent as untrusted data for checking and show as a tree in chat. The run rule becomes one screen run per agent at a time.
Reason: Owner decision to support delegation in v1 without per-agent screen contention.
Rejected: nested subagents, subagents with their own screens in v1 (an [L] item), privilege borrowing.

## ADR-031: Chrome for Testing as the desktop browser
Status: Accepted · 2026-11-01 · Owner approved · Supersedes ADR-006 once the TASK-078 spike passes
Decision: Use a pinned Chrome for Testing build, downloaded on the owner's machine at image build time and checked by SHA-256, as the agents' browser. It is never redistributed. Until the spike confirms codecs, grounding and clicks, the pinned Chromium build stays.
Reason: Owner needs a real browser; Chromium lacks H.264/AAC, which many sites use. Chrome for Testing has fixed versions and permanent download URLs, so it can be pinned.
Rejected: building Chromium with proprietary codecs (hours per build), swapping a third-party codec library into Chromium, an unpinned Google Chrome stable package, browser forks.

## ADR-032: Origin-gated memory auto-save
Status: Accepted · 2026-11-03 · Owner approved with TASK-086
Decision: Memory can save what the owner states, automatically, but only when code proves the origin. A change applies without asking only when the agent's memory mode is `auto`, the change carries a quote of at least 12 characters that is an exact substring of one of the owner's own stored messages, at least 90% of the change's content words appear in that message, the injection scan allows it, and the target entry is not pinned. Everything else goes to the existing approval queue. Auto-saved changes are `trusted` with source label "From your message", have a version and an Undo, and an audit event. New agents start on `auto` with `global` + `agent` scopes; the migration puts existing agents on `ask` and the Memory tab offers one audited upgrade action. Caps rise to USER.md 1,500, MEMORY.md 3,000, private 2,200 and the snapshot 8,000 characters. A background `memory.review` job runs once per agent 120 s after chat activity (cursor per agent, at most 5 changes, Background model or Main) and a `memory.tidy` job runs per document at 03:00 local or at 85% of cap, at most every 6 h, accepting merge/shorten/archive only when 95% of their words come from the sources; one card and one Undo cover a tidy batch. `search_history` uses Postgres full-text search over the agent's own chat. No vector database.
Reason: The owner wants memory that behaves like ChatGPT's and Hermes's without turning a web page or a document into a durable instruction. Code checks provenance; the model's own claim is never trusted.
Rejected: auto-saving facts from web pages, emails, documents or tool output; trusting the model's claimed source; auto-saving into pinned entries; nightly rewrites without a source-coverage check.

## ADR-033: GitHub App device sign-in for connections
Status: Accepted · 2026-11-03 · Owner approved with TASK-088
Decision: A GitHub connection may come from a GitHub App device sign-in instead of a pasted token. The app shows GitHub's short code, the owner approves it on github.com and picks repositories; the access token (`ghu_`) and the refresh token (`ghr_`) are encrypted with ADR-027, refreshed by a pg-boss job 30 minutes before expiry, and injected only by the egress proxy. The device code stays server-side, encrypted and single-use. The proxy exposes one fixed route, `POST /v1/github-device`, with only the two GitHub endpoints (`/login/device/code` and `/login/oauth/access_token`); host, paths, redirects, size and time are pinned. Only the GitHub App's public client ID is configured; no client secret is stored. A rejected refresh token marks the connection `expired`, drops the refresh token and stops injection until the owner reconnects. Disconnect deletes the row; GitHub revocation is a link to the owner's app authorizations, stated in the UI. Pasting a fine-grained token keeps working exactly as before.
Reason: The owner wants one-click GitHub for a self-hosted install without a public callback URL and without creating a token by hand. Device flow needs no callback and a GitHub App limits the token to the installed repositories, matching the least-privilege of a fine-grained token.
Rejected: a plain OAuth app (its token reaches every repository), storing a client secret, a public callback URL, sending either token to the browser, model or desktop, revoking through an endpoint that needs the client secret.

## ADR-034: Handoff between agents
Status: Accepted · 2026-11-03 · Owner approved with TASK-085
Decision: An agent with the `handoff` permission may pass the owner's request to one teammate by exact name with a one-line note of at most 1,000 characters. New agents start with handoff on; existing agents keep their permissions until the owner uses one explicit "Allow handoff for all agents" action. The receiver's task is a copy of the stored owner message (`role = user`), never model text; the sender's note is tagged `agent` as data. The receiver run uses only its own permissions, allowlist, connections and budget. Guards: at most two hops, no return to an agent that already had the request, no self-handoff, and paused, busy or unavailable receivers are refused with `teammate_unavailable`. The sender's run seals `handed_off`; the receiver's run has `run_meta.trigger = 'handoff'` and `run_meta.handoff_of`, and its signed header carries the optional `handoff_of` field only when present. Both events are audited. A leading `@Name ` in a chat message routes the owner's words to that teammate's chat and starts its run there; an unknown name sends nothing; a later `@` is ordinary text. Continue opens the existing rewind dialog at the last complete checkpoint on an interrupted run, with the external-effects notice.
Reason: Crew delegation in v1 without letting one agent borrow another's access, and without pretending a restarted run can resume in place.
Rejected: group chats with shared transcripts, borrowing the sender's permissions or connections, same-run resume, one-click Continue that skips the rewind dialog.

## ADR-035: Owner-created crews with crew-scoped handoff
Status: Accepted · 2026-11-04 · Owner approved (custom crews request)
Decision: The owner may create named crews of up to 6 agents with only names and roles required; persona, budgets, tools and actions fill from safe defaults (role-based persona, $5/$50 budgets, read/deliver files plus the default-deny screen/memory actions including `handoff`, never tool_call/shell/subagents). An agent-initiated handoff is allowed only when sender and receiver share a crew (`different_crew` refusal otherwise, and the model only sees crewmates); a sender in no crew keeps the legacy open behaviour so individual and starter-crew agents are untouched. Owner-typed `@Name` routing stays open to every teammate. Extends ADR-034, which keeps every other guard.
Reason: Owner wants one-click topic crews (e.g. Milly + Lilly) that delegate among themselves without leaking requests to unrelated agents, without a heavyweight create form.
Rejected: global handoff for all agents, crew-wide shared permissions or transcripts, auto-granting tool_call/shell to crew members.
