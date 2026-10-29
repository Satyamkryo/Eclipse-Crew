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
| 001 | Self-hosted Docker Compose stack, no hosted SaaS | Accepted |
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

---

## ADR-001: Self-hosted Docker Compose stack
Status: Accepted · 2026-10-28
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
