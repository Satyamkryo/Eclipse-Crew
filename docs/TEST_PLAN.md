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

- [x] Local scaffold: `npm run dev` responds on `127.0.0.1:3000`; placeholder is readable and keyboard usable at desktop and 375 px.
- [x] Apply the initial Drizzle migration twice to a fresh isolated PostgreSQL database; confirm the owner columns, unique login, and rejection when `owner_id` differs from `id`.
- [x] Compose skeleton: five services start on Docker Desktop, Postgres is healthy, and only ingress publishes `127.0.0.1:3000` and serves the placeholder.
- [x] Skeleton isolation: app reaches Postgres; app and desktop cannot reach the tested external address; desktop cannot reach Postgres; ingress cannot reach Postgres or a desktop-network test listener; CONNECT and absolute-form proxy requests are rejected.
- [x] Skeleton persistence: a PostgreSQL test record survives a container restart; disposable test volumes and containers are removed.
- [x] Configuration: PostgreSQL URLs validate on use; missing, invalid or wrong-protocol URLs fail without leaking synthetic credentials; migration CLI respects shell-over-file precedence.
- [x] Configuration: a temporary env file supplies the Compose bootstrap secret only to Postgres; missing or empty values fail; `.env` is ignored by Git and excluded from Docker build context.
- [ ] Database uses distinct least-privilege runtime and migration roles; application queries are owner-scoped and cross-owner access is denied.
- [x] TASK-064: runtime credentials cannot create/alter/drop schema objects, create roles or escalate privileges; migrations use separate credentials; setup preserves existing database data.
- [x] TASK-064: provisioning rejects unexpected roles, grants, default privileges and migration history; mismatched mounted credentials do not rotate existing passwords.
- [x] TASK-064: isolated fresh and bootstrap-owned volumes retain owner rows and migration history across repeat provisioning and migration; Postgres has no published port.
- [x] Foundation audit fixes: failed database initialization releases its cache; concurrent calls share attempts, recovery succeeds, and privileged roles remain denied.
- [x] Foundation audit fixes: LF/CRLF migration histories provision repeatedly without rewriting hashes, rows or timestamps; other histories remain rejected.
- [x] Foundation audit fixes: non-root app writes persist across restart; isolated legacy artifacts repair preserves contents/modes and symlinks, and refuses running apps or mismatched volume labels.
- [x] Foundation audit fixes: all five services start in isolation; production CSP nonces differ per HTML request and match scripts, assets load, and nosniff/referrer/framing headers are present.
- [x] Foundation audit fixes: HTTPS policy unit checks enable HSTS only for production HTTPS; forwarded-scheme spoofing through localhost ingress cannot enable it.
- [x] Foundation audit fixes: owner confirms View project status shows and hides correctly with mouse and keyboard, including a mobile-size viewport.
- [ ] Foundation audit fixes: owner confirms no CSP errors in the browser console.
- [ ] Foundation audit fixes: verify a live HTTPS deployment and trusted TLS forwarding.
- [ ] With required configuration, `docker compose up -d` on a clean machine starts `app`, `postgres`, `desktop`, `egress-proxy` and `ingress`.
- [ ] Clean machine to first agent replying in ≤ 15 minutes
- [ ] All services come back after a host reboot (`restart: unless-stopped`)
- [ ] App answers on `127.0.0.1:3000` and is not reachable from another device on the LAN
- [ ] Postgres, VNC, CDP and desktop-controller ports are not published on the host
- [ ] Works on Windows (Docker Desktop, WSL 2), macOS and a Linux VPS with the same compose file
- [x] TASK-009 feasibility: per-agent file permissions hold in a disposable Docker volume on Windows; two real Linux users retain mode-700 homes and protected markers across container recreation. TASK-011 now verifies the persistent identity/private-layout layer; per-agent sessions are verified by TASK-012; authenticated controller/live view/takeover are verified by TASK-013–015.
- [x] TASK-009: own-file controls pass; 40 cross-user list/read/create/overwrite/delete/chmod/chown/symlink denials pass across initial/recreated containers, with protected contents and ownership unchanged.
- [x] TASK-009: six bounded I/O rounds (1,000 x 4 KiB files and 32 MiB sequential data per round) complete with checksum verification; timings distinguish cached reads, flushed writes and host-command overhead.
- [x] TASK-009: nine offline guard/lifecycle tests pass; real run 68cb4301-90ea-4b9d-b191-3d91327f7447 verifies non-root users, no effective capabilities/sudo, read-only root, no network/ports/host mounts/secrets, scoped cleanup and unchanged existing resources.

## Owner account

- [x] First visit opens setup; owner account is created with email + Eclipse Crew password
- [x] After setup, `/setup` returns 404 and no second account can be created
- [x] Owner can log in; wrong email or password shows an error
- [x] Repeated failed logins are rate-limited and temporarily locked out
- [x] Logged-out users cannot open any page, API route, SSE stream or the desktop stream
- [x] Change password requires the current password and signs out other sessions while keeping the current one (two real browsers; run `fa384f27-e199-473b-9390-f26ed549efc0`)
- [x] Change email requires the current password, normalizes the login and updates the visible form immediately
- [x] "Sign out everywhere" ends all other sessions and keeps the current browser signed in
- [x] Account routes deny wrong Origin/CSRF, unknown fields, oversized bodies and repeated bad passwords; expired/unrelated sessions are hidden; forced revocation failure rolls back both password and sessions (real browser and database run `fa384f27-e199-473b-9390-f26ed549efc0`)
- [x] `npm run reset-password` reads private stdin, resets the password and atomically revokes only the owner's sessions (fresh disposable database verified)
- [x] Owner singleton migration preserves supported owner/sessions schemas and LF/CRLF history; multiple legacy owners fail without deletion
- [x] Forged/expired/revoked sessions, owner metadata overrides and invalid session-bound CSRF fail before desktop dispatch (behavioral auth tests)
- [x] Changing X-Forwarded-For cannot evade the single-owner login lockout
- [x] Password is stored as an argon2id hash; session cookie is HttpOnly and SameSite

## Workspace shell (TASK-018)

- [x] Real browser at 1280/1440 px shows the 260 px agent pane, flexible chat and 380 px–50% right panel; pointer and keyboard resizing stay in bounds, including after soft navigation
- [x] All six right-panel tabs fit at 380 and 375 px, navigate by Arrow/Home/End, control the existing panel, and expose visible focus
- [x] Tablet keeps a 56 px agent rail and opens accessible agent/panel sheets with trapped focus, Escape/close, and focus return; selecting an agent opens its live panel
- [x] Mobile switches one Agents/Chat/Panel view at a time through the bottom bar with no page overflow; selecting an agent opens its panel
- [x] Invalid agent selection leaves the mobile Agents pane or tablet Agents sheet visible with its error
- [x] Resizing the panel does not reconnect the live desktop; mobile/tablet agent selection opens exactly one stream (run `ee5c00e4-58c8-4ad6-8574-3220e8b242ed`, screenshots in the same evidence directory, cleanup complete)

## Agent management (TASK-019)

- [x] Real browser at 1440/375 px creates two agents with name, role, persona, default-deny permissions and daily/monthly budgets; edits persist after reload and a blank persona receives an editable role-based default
- [x] Focus-trapped create/delete dialogs, modal focus return, mobile no-overflow, duplicate-name confirmation and explicit backup acknowledgement work by keyboard
- [x] Pause stops only the selected desktop and closes its live stream; resume restores the same agent while the peer desktop remains available
- [x] Delete removes the owner-scoped agent/policy rows, Linux account, registry identity, profile, home and Downloads while the peer home survives; registry-only and missing agents are denied
- [x] Create requires CSRF, rejects owner overrides, and browser setup/layout plus the existing live noVNC/takeover checks remain green (run `3e1696fa-fc34-4429-9833-aefc708e637c`, cleanup complete)

## Agents and isolation

- [x] Owner can create, edit, pause and delete an agent (name, role, persona, permissions, budget)
- [x] Each agent gets its own Linux user, `700` home, screen and Chromium profile (TASK-011/012 local administration verified; TASK-019 product CRUD verified)
- [ ] Agent A cannot read Agent B's files, browser profile, cookies or credentials
- [ ] Agents have no sudo and cannot read the database, `.env` or host folders
- [ ] Logins persist in an agent's browser profile across restarts
- [x] Delete removes the agent's Linux user, profile, files and memory after a backup prompt
- [ ] Agent knows its persona, its permissions and the current date/time

## Chat and files

- [ ] Replies render as the four card types: message, clarification, tool connection, routine
- [ ] Invalid model output is rejected and never executed
- [ ] Chat history persists per agent; background run results appear in the timeline
- [ ] Files can be attached by button, drag-and-drop and paste; they land in that agent's `inbox/`
- [ ] Files over the size limit (default 250 MB) are rejected
- [ ] Files the agent writes to `outbox/` appear as file cards with Download and Open on the agent's desktop

## Desktop image foundation

- [x] TASK-010 offline guards reject host mounts/ports, credentials, root/capability changes and mismatched image identities; dependency/sandbox constraints are checked.
- [x] TASK-010: approved package lock verifies 379 archives / 218769418 bytes before offline installation; pinned Node/Chromium image builds and every required tool executes. Earlier snapshot outage remains historical.
- [x] TASK-010: run 0d69e5bc-7966-4ef3-8e5f-40035b2e00e0 verifies non-root Xauthority/Openbox, accepted/rejected VNC authentication, noVNC WebSocket, 1024x768 PNG and three-frame video; cleanup complete.
- [x] TASK-010: run c66f0dda-e890-428b-8f58-a1df20c978fa passes genuine Playwright and xdotool clicks in graphical Chromium; chrome://sandbox reports namespace/PID/network and Seccomp-BPF active. Parent has zero capabilities/no-new-privileges and ordinary chroot remains denied.
- [x] TASK-010: desktop Compose health and runtime isolation settings pass; both five-service http-security tests pass after the package and ADR-025 sandbox revisions.

## Persistent agent identities (TASK-011)

- [x] Run d778a3ca-9d63-4786-b1ae-5609581324f0: real distinct NSS identities, UID/GID 20000+, mode-700 home/inbox/outbox/work/profile/Downloads; idempotent owner-scoped creation and actual owner CLI inspection.
- [x] Both agents have zero effective/permitted/inheritable/ambient/bounding capabilities, no supplementary groups, no-new-privileges and no sudo; attempts to set UID 0 or read/write peer files, registry and hidden backing storage fail.
- [x] Downloads direct execution returns EACCES while an identical work executable succeeds; descendants cannot mount even inside a new user namespace. Changed Downloads aliases are rejected.
- [x] Reduced PID 1 loses SYS_ADMIN including bounding; inherited filter is present. Reduced administrator mount and x32 syscall probes are denied. Read-only root, no host mounts, secrets or published desktop ports remain checked.
- [x] Concurrent duplicate creation returns one identity; malformed registry, owner mismatch, invalid paths and stale lock stop without overwriting data. Container recreation preserves UID/NSS mappings, private markers/profile fixtures and Downloads noexec; unrelated volume data survives. Disposable cleanup completes.
- [x] TASK-011 regression: test:desktop-image passes all 6 tests, including graphical sandbox/input/VNC/capture (run 1723128b-490b-4826-ab2d-adb07a7c67af). Both five-service test:http-security checks pass. These are Docker Desktop Windows results; other hosts remain unverified. TASK-012 now verifies the per-agent screen/session layer.

## Per-agent graphical sessions (TASK-012)

- [x] Run b6cbc929-f929-456f-b454-bdef8df04461: two simultaneous UID-isolated Xvfb/Openbox/headed Chromium sessions, independent real windows, synthetic persistent cookies/local storage, idempotent start/status/stop and actual owner CLI.
- [x] Missing/peer Xauthority is rejected; profiles, supervisor socket and peer worker IPC descriptors deny access. Workers/outer browsers have all capability sets zero and no-new-privileges. Inner Chromium helpers have only verified private single-UID mappings and namespace-local capabilities; sandbox status confirms namespace/PID/network and Seccomp-BPF active.
- [x] No X11 or CDP TCP listener/published desktop port; browser control uses private pipes. Conflicting displays and live profile locks are refused without deleting the conflicting artifacts.
- [x] Graceful stop leaves no live agent processes, preserves its peer and reopens saved profile state. Xvfb crash and SIGKILL of the worker trigger session-only cleanup; fixed same-UID fallback removes verified descendants and private runtime files without CAP_KILL.
- [x] Container recreation leaves sessions stopped until explicitly started; synthetic cookies/local storage and unrelated volume data survive. Test cleanup is complete. Real account login/credential handling and the app/controller/streaming/takeover are still separate checks.

- [x] TASK-012 regressions: test:agent-users 4/4 (run 841b4734-699d-4aae-a883-d68e909fa09e), test:desktop-image 6/6 (run bfaa3174-68d6-4938-9816-08555b5fef24), five-service test:http-security 2/2 including production build; lint/typecheck/diff checks pass.

## Live desktop and takeover

- [ ] Desktop view connects within 2 seconds (latency target requires measurement)
- [x] Real authenticated noVNC canvases show two distinct 1024×768 agent desktops (disposable browser run 25ac0609-146f-4109-accd-2f52119ff311)
- [x] Takeover acknowledgment waits for active work and prevents queued agent input/screenshots from dispatching; stale owner/generation/lease fail (behavioral manager tests)
- [x] Owner scaled pointer/text, handback and route-leave release work through the actual browser; remote text and resumed agent capture are verified
- [x] HTTP/WS controller requires service secret and exact app peer; missing/wrong secrets, spoofed source, stale generations and unknown agents fail
- [x] RFB view-only protocol rejects key/pointer/clipboard injection; private VNC challenge authentication and sanitized pixel transport pass synthetic TCP/WS tests
- [x] Revoked/replaced sessions close native streams within five seconds; silent peers and application shutdown release streams (behavioral bridge tests)
- [x] Real browser logout revokes HTTP and the live stream; real takeover blocks agent capture/input until release
- [x] Actual password/OTP controls deny desktop typing and key input, including inside single and nested closed shadow roots; ordinary focused text input still works (TASK-012 run 01331fe8-87b7-4535-b598-375fa9aec997)
- [x] Pinned noVNC package normalization preserves awaited feature detection and fails on changed bytes/version; real x11vnc true-colour flag 255 is accepted with view-only filtering retained
- [x] Interrupted session startup cannot deadlock supervisor shutdown; uncertain sessions can be explicitly stopped
- [ ] Agent stops at login walls, CAPTCHAs, OTPs and payment checks and asks the owner
- [x] Agent screenshot dispatch is blocked during takeover; teach recording/Record integration remains a later task
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

- [x] TASK-008 offline: one fixed SAM image request, actual mask decoding and source-aligned PNG pixels; empty-result, malformed geometry/encoding/confidence, duplicate-ID and decoded-area/object limits fail safely before unbounded allocation.
- [x] TASK-008 offline: consent/key/image preflight, artifact symlink refusal, exclusive writes, credential redaction, bounded HTTP/response handling and simulated deadline abort; no automatic retries or input execution.
- [x] TASK-008 live: b91a98d6-8c75-408b-9b01-bfbba38c92b0 returned one real sam-3.1 button mask in 2122 ms, box (572,456)–(747,487), 5526 foreground pixels, confidence 0.6133. Agent visual inspection confirmed View project status; box IoU is approximately 0.9887 against independently inspected reference (571,456)–(746,487). Exactly one image request; no input execution. Original targetConfirmed:false is request-time state; this review does not rewrite the evidence. Production settings/verification remain unimplemented.

- [x] TASK-007 offline: PNG limits, explicit live consent, private key handling, fixed endpoint/contributor model, clock block and bounded request settings are tested with mocked transport.
- [x] TASK-007 offline: invalid/incomplete responses, unsupported or out-of-bounds actions, pending safety checks, HTTP/network/time-limit errors and oversized responses fail safely without automatic retries.
- [x] TASK-007 offline: evidence is exclusive, labeled mock for mocked transport and excludes canary credentials, screenshots, reasoning and raw model output; unsafe evidence-path symlinks are refused.
- [x] TASK-007 diagnostics: the reason-loss regression fails before the fix and passes after it; private review reasons survive while actions remain blocked, credential-pattern matches are withheld, and existing evidence is never overwritten.
- [x] TASK-007 diagnostics: malformed check metadata is invalid, not a completed review; documented opaque string identifiers do not fail invented local length limits, while review output and response size remain capped.
- [x] TASK-007 diagnostics live: corrected reader accepted an empty valid check list; native screenshot-only action was identified and replayed offline as observation_requested. The historical safety flag did not recur, so its discarded reason remains unknown.
- [x] TASK-007 live transport: owner-selected Contributor model accepts the real screenshot and returns a completed computer call.
- [x] TASK-007 read-only live proof: Contributor returned a single left-click proposal at (659, 471) for the real placeholder PNG; field/bounds checks and owner review confirmed View project status. Evidence remains marked safety_review_required; no input or provider acknowledgement was sent.
- [ ] TASK-007 full acceptance (owner reopened for actual-click test): obtain a genuine validated action with no unresolved provider checks, execute only the authorized local button click and verify closed→open plus visible Project status. No automatic acknowledgements or paid retries.
- [x] TASK-007 actual-click offline: native click and optional unchanged stateless replay, two-request/token/time budgets, unsafe/malformed response stops, private warning redaction and credential-free browser request policy pass.
- [x] TASK-007 actual-click local browser: fresh Firefox (latest continuation; earlier Chromium checks also passed) rejected wrong/stale targets, executed one coordinate click, verified closed→open and visible status, and rejected a second click without using Meta credits.
- [x] TASK-007 reviewed flow offline: 1024/3072 output budget and three-request ceiling; exact check/receipt/history replay after specific approval; wrong-target/denial/stale/timeout paths never input or acknowledge. Nonce-bound stdin review is explicit, abortable and single-use; review wait is excluded from active model time.
- [x] TASK-007 reviewed flow offline: genuine execution/postconditions remain recorded when acknowledgement fails; acknowledgement/new returned actions cannot trigger a second click.
- [x] TASK-007 image contract: original detail on initial/observation/acknowledgement images, unchanged bytes/replay, and geometry mismatch rejection before model usage/input; 22 live-driver tests pass including real isolated Firefox.
- [ ] TASK-007 original-detail live: Original-detail run 3e06d19f-8460-4162-968a-7ea98b134318 verified 1280x800/DPR1 and the unchanged screenshot hash, but returned (359,483), below the button ending y=466. One Contributor request used 3559 input / 670 output tokens (584 reasoning); wrong_target stopped before review/input/acknowledgement. Original detail did not resolve the miss; no token cap was reached.
- [ ] TASK-007 reviewed flow live: d1395501-fc64-4938-bb4e-676bd3e3fef0 completed the genuine observation/replay exchange in Firefox, then returned (359,483), outside the button ending at y=466 on the same reference-image hash. Driver stopped wrong_target before review/input/acknowledgement. Two Contributor requests used 8532 input / 367 output (191 and 176), 229 reasoning; caps were not reached. Actual Meta-driven click remains unverified.
- [ ] TASK-007 actual-click live: dce29060-5365-4bb3-93e8-7b9c5f757350 returned a completed click proposal with computer_action_requires_confirmation; exact sanitized reason retained. Output 369/512, so no token cutoff. Independent no-input Firefox comparison reproduced the exact screenshot hash and measured button x=280..456.35/y=434..466; model point (359,478) misses. No click/acknowledgement executed. TASK-007 remains open.
- [x] TASK-007 bounded loop offline: text-only first turn, unchanged genuine replay/call correlation, static PNG only on matching tool output, strict post-image click acceptance and two-request ceiling. Missing/invalid receipts, premature clicks, repeat observations, safety checks, credential replay and inconsistent/excess usage stop safely.
- [x] TASK-007 deadlines offline: simulated 30-second request timeout aborts a non-cooperating transport without retries; a 45-second total overrun stops before continuation.
- [ ] TASK-007 bounded loop live: latest evidence f4aa6650-f817-4148-8802-bb369129efcc stopped replay_unavailable before a second request (2284 input / 89 output tokens; empty checks). Exact replay subreason was not retained. Still required: one approved invocation, at most two Contributor requests / 512 output tokens each, obtains genuine post-image validated_click and owner target confirmation. No input execution.
- [ ] TASK-065: missing or malformed master keys are rejected; encrypted values round-trip correctly and reject tampering or the wrong key without leaking plaintext or keys.
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
