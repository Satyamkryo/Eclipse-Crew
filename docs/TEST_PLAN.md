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
- [x] Provisioning compares the complete ordered model-role constraint names and definitions; altered same-name role, shape and provider-FK constraints retaining former substrings are rejected.
- [x] 0029 review fix: real PostgreSQL scoped model-role checks pass twice at 0005/0007, and message/model-role/policy checks at 0013/0028/0029/0030/0031; exact card types, background role/shape and search-index definitions are checked; same-name drift is denied; owner/history unchanged (`node --test --test-isolation=none tests/provision-0029.test.mjs`, 5/5 including full provisioning).
- [x] Full current provisioning: fresh-through-0031 disposable database provisions twice with correct `agent_policies` column/type/default positions; owner/history unchanged and runtime DDL denied. Altered policy defaults/constraints fail before changing rows, history, ownership or grants. Live provisioning not rerun.
- [x] TASK-064: isolated fresh and bootstrap-owned volumes retain owner rows and migration history across repeat provisioning and migration; Postgres has no published port.
- [x] Foundation audit fixes: failed database initialization releases its cache; concurrent calls share attempts, recovery succeeds, and privileged roles remain denied.
- [x] Foundation audit fixes: LF/CRLF migration histories provision repeatedly without rewriting hashes, rows or timestamps; other histories remain rejected.
- [x] Foundation audit fixes: non-root app writes persist across restart; isolated legacy artifacts repair preserves contents/modes and symlinks, and refuses running apps or mismatched volume labels.
- [x] Foundation audit fixes: all five services start in isolation; production CSP nonces differ per HTML request and match scripts, assets load, and nosniff/referrer/framing headers are present.
- [x] Foundation audit fixes: HTTPS policy unit checks enable HSTS only for production HTTPS; forwarded-scheme spoofing through localhost ingress cannot enable it.
- [x] Foundation audit fixes: owner confirms View project status shows and hides correctly with mouse and keyboard, including a mobile-size viewport.
- [ ] Foundation audit fixes: owner confirms no CSP errors in the browser console.
- [ ] Foundation audit fixes: verify a live HTTPS deployment and trusted TLS forwarding.
- [ ] TASK-081: judge instance on a separate VM. Owner-run checks: `curl -sI https://<domain>/login` (valid certificate, CSP nonce, nosniff, referrer, framing, HSTS), `curl -sI http://<domain>/` (redirect), external scan shows only 22/80/443, login and live desktop over HTTPS at 1440 and 375 px from a phone on mobile data, one chat run on the mock portal with an exported run verified offline, and Settings shows the agent budget and spend limit. Not run yet: owner has not deployed the VM.
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
- [x] Setup scripts (`npm run desktop:secret`, `npm run encryption-key`) share `scripts/lib/env-secret.mjs`: they create a mode-600 `.env`, are idempotent, never print a value, keep CRLF/LF endings, and never rotate or duplicate a valid key. They refuse duplicate, padded, invalid, `export`ed or symlinked entries without changing the file, and a failed write leaves `.env` intact with no temp file (`test:desktop-secret` 9/9 on Linux, `test:encryption` 9 pass + 1 symlink skip on Windows).

- [ ] **Open, retest later:** the full `npm run test:auth-desktop-e2e` (fresh Compose stack, real Chromium, all phases) must pass again. On 2026-11-04 the setup selectors were fixed for the workspace redesign (`heading 'Eclipse Crew'` → `main 'Eclipse Crew'` + sidebar link; `main 'Eclipse Crew workspace'` → `main 'Eclipse Crew'`; agent/chat/rail/sheet names) and setup now passes 11/11 with cleanup complete. It stops in **agents**: `createAgent` returns `desktopReady:false`, so the agent stays paused and no desktop/Live exists (a fail-fast assertion names the response body). Provisioning (`desktopCreateAgent` + `session.start`) fails in the disposable stack; that needs investigation before the rest of the suite can run. Fresh 2026-11-04 runs: repros (eclipseaudit6654140ff645 64 s, eclipseauditce8038362fb9 282 s, eclipseaudit2b7dc50c6113 216 s, eclipseaudit6af0c14e34d0 218 s) all stopped at 201 `desktopReady:false`; approved temporary probes (all removed, diffs verified empty) traced it to `session.start` failing in `ensure-entry` with `egress-not-configured` (fixture omitted `EGRESS_DESKTOP_SECRET`; agent-sessions sets it). Fix applied (fixture env + guard list; `node --check`/ESLint clean). Verification run eclipseauditda9bb97f26bd (483 s, cleanup complete): provisioning now succeeds — no `desktopReady:false`, agents Running with desktop+browser running — but the suite fails later in the agents phase: the script waits 60 s for `Start desktop` while the UI already offers `Stop desktop`, with desktop-stream WebSocket 403s. Missing-secret blocker resolved; new failure recorded separately; full pass not claimed. Explicit sequence run eclipseaudit0845861e66aa (135 s, cleanup complete): provisioning PASS; Stop-to-stopped NOT observed (Start never appeared in 60 s; no UI dump captured, cause undetermined); rest untested; stream 403s persist. Two later runs never reached lifecycle steps and are recorded separately: eclipseaudit2c6ffd5fac74 failed at image build (transient tree breakage in other sessions' memory files; build passes now), eclipseaudit60c4b292228f failed at setup (/settings/account now redirects to /profile by workstream intent; test updated to /profile + heading Profile with all account checks preserved). Validation run eclipseauditcc83892fc1e0 (145 s, snapshot 5a334bda + 63 modified + 10 untracked, no mid-run change, cleanup complete): Stop POST was sent but never responded within 60 s while 30 backend polls stayed running/running and the UI kept Stop with no error alert - stop hung server-side past worker (15 s) and app (45 s) timeouts; Start-to-running, Pause/Resume, Live untested; stream 403s persist separately. Temp diagnostics removed after use. Stop-path staged run eclipseaudit165b28113820 (322 s, snapshot 5a334bda, no mid-run change, cleanup complete): Stop POST completed every server layer in ~327 ms yet its response never reached the browser in 60 s; backend reached stopped at ~2 s (same generation) and stayed there while the UI correctly kept Stop with no alert - first failing stage is response delivery post-handler-return. Start-to-running, Pause/Resume, Live untested. All temp blocks removed (diffs verified empty). Staged run eclipseauditb91ea3de458f (281 s, no mid-run change, cleanup complete): Stop completed every server layer in ~409 ms and backend reached stopped, but its response never reached the browser in 60 s (UI kept Stop, no alert) - first failing stage is post-handler delivery; Start then failed with HTTP 503 service_unavailable from an unclassified 147 ms failure with no desktop interaction. Start-segmentation run eclipseaudit215c5c11710d (317 s, snapshot 5a334bda + 64 entries, no mid-run change, cleanup complete): failed again at the Stop-to-stopped UI wait (backend state unknown, no observers this round); start-path marks never fired, removed unexercised; stop success 1/3 runs, UI-stall 2/3; stream 403s persist separately. Stop-delivery rounds eclipseauditb91ea3de458f (218 s) and eclipseaudit34138beb6a92 (281 s, cleanup complete): Stop POST completes every server layer in ~409 ms and the backend reaches stopped, but the browser observes only the HTTP 200 status while the body never arrives, so the fetch never completes and the UI stays on Stop with no alert - first failing stage is response-body delivery after headers. The disposable ingress access log never materialized (override did not take effect; merge and nginx syntax verified, runtime mount not proven). All temp code removed and verified. Pause/Resume, Live, and the 503 Start retest remain untested. Earlier: on 2026-11-02 it stopped in its **agents** phase, before the chat, files, models, outbox and desktop phases: resuming a new agent returned 503 (`service_unavailable`) and the live view never reached "Live". The cause was not found and was not traced to TASK-031/032 (the same phase passed five times on 2026-11-01, before TASK-029-035 and the checkpoint/History changes landed). Also confirm that the app image builds (`docker compose build app` failed on `scripts/mock-vendor` type errors at the time). Until this passes, the History phase added for TASK-031 has only run in a trimmed copy of the suite (setup, then History), not inside the full run.

- [ ] 2026-11-04 verified recovery: pricing zero-offset (GMT/GMT+00:00/GMT-00:00 mocked, invalid rejected) and stream auth (graphics running + browser enum, legacy 5-field denied, browser-stopped viewable) pass locally (costs 10/10, live-view 18/18, agents 19/19) and in container; disposable e2e 423s cleanup complete shows RFB frames flowing with no invalid_timezone on Node 24.22.2, but Stop-to-stopped still NOT observed (Start timeout 60s). Live app/desktop rebuild pending.
## Owner account

- [x] First visit opens setup; owner account is created with email + Eclipse Crew password
- [x] After setup, `/setup` returns 404 and no second account can be created
- [x] Owner can log in; wrong email or password shows an error
- [x] Repeated failed logins are rate-limited and temporarily locked out
- [x] Authentication rate-limit slots are reserved synchronously; concurrent admissions cannot exceed five, failures do not double-count, and success/expiry reset the bucket.
- [x] Logged-out users cannot open any page, API route, SSE stream or the desktop stream
- [x] Change password requires the current password and signs out other sessions while keeping the current one (two real browsers; run `fa384f27-e199-473b-9390-f26ed549efc0`)
- [x] Change email requires the current password, normalizes the login and updates the visible form immediately
- [x] "Sign out everywhere" ends all other sessions and keeps the current browser signed in
- [x] Account routes deny wrong Origin/CSRF, unknown fields, oversized bodies and repeated bad passwords; expired/unrelated sessions are hidden; forced revocation failure rolls back both password and sessions (real browser and database run `fa384f27-e199-473b-9390-f26ed549efc0`)
- [x] `npm run reset-password -- --login <email>` reads private stdin, resets that account's password and atomically revokes only its sessions; other accounts keep working (fresh disposable database verified)
- [x] Migration 0039 drops the owner singleton; the history check expects the index only for counts 3–39, and fresh + legacy-upgrade provisioning passes
- [x] Forged/expired/revoked sessions, owner metadata overrides and invalid session-bound CSRF fail before desktop dispatch (behavioral auth tests)
- [x] Changing X-Forwarded-For cannot evade the per-login lockout; unknown emails take a dummy argon2 verify
- [x] Password is stored as an argon2id hash; session cookie is HttpOnly and SameSite
- [x] TASK-092 multi-account (`npm run test:accounts` 8/8): three CLI-created accounts, duplicate login refused; each authenticates, wrong passwords and unknown emails refused alike; five failures lock one login while the others keep signing in; one account's agents, chats, runs, receipts and memory are refused to another (403/404) and missing from its lists; setup 404s while accounts exist; scheduler, memory tidy and check-ins tick all three; the mirror writes one `USER.md` per account and claims the legacy file once

## Workspace shell (TASK-018)

### 2026-11-03 UI reference alignment follow-up (`prompts/2026-11-03-ui-reference-alignment.md`)

These supersede older width-based/right-panel-tab expectations above while their historical evidence stays recorded.

- [ ] Shared app shell: sidebar navigation (Agents, Crew, Mission Control, Evidence, Models, Connections, Schedules, Security), agent list, "Self-hosted · Secure workspace" footer, header search (Ctrl K) and owner chip (links to Profile) render on `/`, `/mission-control`, `/security`, `/crew`, `/schedules`, `/profile` and every settings page at 1280/1440 px.
- [ ] Workspace center: agent heading (avatar, name, role, status chip) with central Chat/Settings/Tools/Routines/History/Memory tabs; Tools/Routines show honest empty states linking to Connections/Schedules; right column shows the single live stream plus Current activity.
- [ ] Chat renders ordinary messages as unboxed rows (avatar, name, time) and keeps action content carded; composer is the compact single-row input with paperclip and send icon.
- [ ] `?panel=` deep links map onto the central tabs (history continue link opens the History tab with the rewind dialog).
- [ ] Screenshots at 1440/1280/768/375 px compared against references 02, 05, 39, 40, 41, 43 for every mapped surface (docs/UI_REFERENCE_MAP.md); remaining per-surface differences recorded.
- [ ] `npm run test:ui-reference` structural checks pass; login (24) and setup (21) match their reference composition.


- [ ] Nov 3 UI follow-up: verify the desktop app header keeps Eclipse Crew, Security and Mission Control clear of pane headings; pane headers align, the resize divider is 1 px with a 24 px pointer target, and all six panel tabs fit without scrollbars at 375/380 px. Check slim dark scrollbars on overflowing panels and keyboard resizing at 1280/1440 px.

- [x] Real browser at 1280/1440 px shows the 260 px agent pane, flexible chat and 380 px–50% right panel; pointer and keyboard resizing stay in bounds, including after soft navigation
- [x] All six right-panel tabs fit at 380 and 375 px, navigate by Arrow/Home/End, control the existing panel, and expose visible focus
- [x] Tablet keeps a 56 px agent rail and opens accessible agent/panel sheets with trapped focus, Escape/close, and focus return; selecting an agent opens its live panel
- [x] Mobile switches one Agents/Chat/Panel view at a time through the bottom bar with no page overflow; selecting an agent opens its panel
- [x] Invalid agent selection leaves the mobile Agents pane or tablet Agents sheet visible with its error
- [x] Resizing the panel does not reconnect the live desktop; mobile/tablet agent selection opens exactly one stream (run `ee5c00e4-58c8-4ad6-8574-3220e8b242ed`, screenshots in the same evidence directory, cleanup complete)

## Agent management (TASK-019)

- [x] Real browser at 1440/375 px creates two agents with name, role, persona, default-deny permissions and daily/monthly budgets; edits persist after reload and a blank persona receives an editable role-based default
- [ ] A new agent and each new crew member show a random avatar with Shuffle ("Avatar N of 12"); the kept avatar persists after reload in the agent list, center heading, chat rows and expanded desktop view
- [ ] In agent Settings, Shuffle shows "not saved yet" with Undo and Save avatar beside it; Save avatar persists the new avatar after reload. Avatars load once and stay put across navigation (signed-in `/avatars/voxel/*.svg` answers `private, max-age=31536000, immutable`); the Profile page header shows the owner avatar
- [ ] ADR-036 create form: only Name and Role are required; Instructions and Persona are optional; Advanced (closed by default) holds budgets (blank = $5/$50), Websites (Any public website by default, or Only these sites), Tools, Actions and Memory. Creating with just a name and role works, the saved agent shows the role-based expert instructions, and an error inside Advanced opens it. The crew form has the same optional fields under "More options"
- [ ] ADR-036 websites: a new agent with Any public website reaches a public site; every agent is still refused `127.0.0.1`, `10.x`, `169.254.169.254` and other internal addresses; switching to Only these sites with a list blocks other sites; existing agents keep their list after migration 0037
- [ ] ADR-036 handoff: a standard agent is never offered handoff (`not_in_crew` if forced); crewmates hand off only inside their crew; the Crew handoff card shows only on crew agents with Turn on/Turn off, and owner `@Name` still reaches any agent. The sidebar groups agents under each crew name, then "Standard agents"
- [ ] Memory tab shows PERSONA.md (editable, may be empty); Profile has Sign out (this browser) and Sign out everywhere (all browsers); the notification toast is a dark card with a neutral border
- [ ] Full-screen desktop shows the Start/Stop desktop and browser controls (side panel at ≥1024 px, under the screen below that); during takeover a double-click on a desktop folder opens it
- [x] Focus-trapped create/delete dialogs, modal focus return, mobile no-overflow, duplicate-name confirmation and explicit backup acknowledgement work by keyboard
- [x] Pause stops only the selected desktop and closes its live stream; resume restores the same agent while the peer desktop remains available
- [x] Delete removes the owner-scoped agent/policy rows, Linux account, registry identity, profile, home and Downloads while the peer home survives; registry-only and missing agents are denied
- [x] Create requires CSRF, rejects owner overrides, and browser setup/layout plus the existing live noVNC/takeover checks remain green (run `3e1696fa-fc34-4429-9833-aefc708e637c`, cleanup complete)
- [x] Lifecycle hardening: pause/resume/delete serialize under an owner-scoped row lock and require final DB writes; process-scan errors fail closed; registry writes retry after failure; real routes deny wrong Origin/CSRF/cross-owner/confirmation; per-field blur/submit errors focus the first invalid field; altered agent/policy constraints fail preflight

## Agents and isolation

- [x] Owner can create, edit, pause and delete an agent (name, role, persona, permissions, budget)
- [x] Each agent gets its own Linux user, `700` home, screen and Chromium profile (TASK-011/012 local administration verified; TASK-019 product CRUD verified)
- [x] Agent A cannot read Agent B's files, browser profile or cookies (TASK-011/012 files and profile denials; run `7b47dde4-ffbe-476e-9a66-05b9307ef705` adds: each agent's window shows only its own persistent and session cookie, and the peer's `Cookies`/`Login Data` paths return EACCES; TASK-048 run `2d73f472-1af7-4f0d-9c72-4dd7a0e0ab25` extends this in both directions: peer home/Downloads/`.system` and checkpoint paths denied, `/proc` environ/mem/maps/fd/cwd/root return EACCES, no readable command line or environment carries a secret, `kill`/SIGTERM/ptrace/`process_vm_readv` return EPERM, peer `/tmp` runtime and X lock/socket cannot be listed, opened, unlinked or renamed, and a peer-created display lock refuses start without being removed)
- [ ] Agent A cannot read Agent B's saved credentials: no credential store exists yet; test it when one is built (TASK-048 recorded this as not testable; TASK-070)
- [x] Agents have no sudo and cannot read the database, `.env` or host folders (run `7b47dde4-ffbe-476e-9a66-05b9307ef705`, both agent users: `sudo` not installed and `su` refused, no secret-like environment variables, `/proc/1/environ` unreadable, a real Postgres in the stack unreachable by IP and DNS, no outbound internet, loopback control works, no `.env*` file in the desktop filesystem, only the `/workspace` volume mounted; TASK-048 run `2d73f472-1af7-4f0d-9c72-4dd7a0e0ab25` re-runs the boundary with two live agents: no direct public, Docker-gateway or egress-proxy-IP egress, and the proxy is unreachable by name from the desktop network)
- [x] Compose posture: only `ingress` publishes `127.0.0.1:3000`; no privileged/host-network/Docker-socket/`.env` mounts; desktop mounts only `workspace`; secrets stay in their owning services; `app` drops all capabilities and sets no-new-privileges (`npm run test:posture`, including negative fixture configs and live non-root identities)
- Known limit (TASK-048): shared desktop loopback is authenticated, not network-isolated until TASK-071. A peer's x11vnc is reachable to the RFB handshake but refuses an empty password, and the controller/file listeners answer `403 source_denied`; `/proc/*/cmdline` and process names are visible to peers. Per-agent egress-proxy tokens cannot be tested until TASK-045.
- Known issue (TASK-048): a peer-created display lock refuses the start and is retained, but the refusal is reported as `session_cleanup_failed` instead of `display_conflict`; fixing the error masking is outside TASK-048.
- [x] Logins stored as persistent cookies persist in an agent's browser profile across session restart and container recreation (same run)
- [x] Logins stored as session cookies (no expiry, the common case for real sites) also survive pause/resume, container recreation and a killed worker: the worker snapshots them to a private file and restores them after launch (run `ce7251bc-68b9-4a1e-a7f5-6119e5ef8252`: graceful stop/start, a cookie deleted before stop stays deleted, killed worker after the 30 s periodic save, container recreation, peer agent denied, snapshot mode 600 and exact contents; corrupt, oversized, symlinked and group-readable snapshots are ignored without blocking start; a killed display keeps the last saved cookies; `test:cookie-snapshot` 9/9 on Linux)
- Known limit: a crash loses at most the session-cookie changes made since the last 30 s save
- [x] Delete removes the agent's Linux user, profile, files and memory after a backup prompt
- [ ] Agent knows its persona, its permissions and the current date/time

## Chat and files

- [x] Replies render as the four card types: message, clarification, tool connection, routine (TASK-022 real browser plus escaped card rendering)
- [x] Invalid model output is rejected and never executed (TASK-022 schema and append-boundary checks)
- [x] Chat history persists per agent; background run results appear in the timeline (TASK-022 reload, polling, isolation and background-append checks)
- [x] Files can be attached by button, drag-and-drop and paste; they land in that agent's `inbox/` (browser run: all three paths; stored as the agent's own Linux user, mode 600, byte-identical for a 12 MB file through nginx and Next, no partial file left, the peer agent cannot read or list them; unit suites `test:inbox-writer`, `test:files-route`)
- [x] Files over the size limit (default 250 MB) are rejected (browser run with `MAX_UPLOAD_MB=16`: refused in the browser without a request, and 413 from the route when sent directly)
- [x] Denied paths: anonymous 401, wrong CSRF or Origin 403, paused agent 409, unowned agent 404, program or shell script renamed to `.txt` 415, path parts in a name dropped, leading-dot and reserved names refused
- [x] Files the agent writes to `outbox/` appear as file cards with Download and Open on the agent's desktop (browser run: one card per file with no duplicates over repeat polls; scripts, symlinks and unknown binaries are not carded; a real 12 MB browser download is byte-identical; attachment, sandbox and nosniff headers; Open shows the file in a new tab of the agent's own browser, confirmed in its tab list)
- [x] Open in the agent's real Chromium (run `712cabe0-4208-4820-b608-e4ea905f469c`, screenshots `open-*.png`): PNG, WebM and PDF open as a tab with no stray download and display (PDF in the built-in viewer); an H.264 MP4 opened a blank player, so MP4, MOV and MKV are download-only by design (card shows Download and no Open; the desktop refuses a direct Open)
- [x] Denied paths: anonymous 401, wrong CSRF 403, an inbox card, another agent's card or an unknown id 404, an archive or HTML cannot be opened (415), Open with a stopped desktop 409 `session_not_running`, a file changed after carding 409 `file_changed` with no bytes sent, a symlink swapped in for a carded file 404 (unit suites `test:outbox-reader`, `test:inbox-writer`, `test:files-route`)
- [x] TASK-082 document search: a PDF page-2 term returns page 2 with a usable read offset; stop-word-only and absent terms return `no_match` and the run continues; xlsx sheet names/cells and pptx slide text are found with their sheet/slide numbers; windows are at most 20,000 characters; images return `unsupported_type` (`test:doc-search` 7, `test:agent-files` 12 + 1 skipped without unzip, `test:agent-step-loop` 70)
- [x] TASK-082 proof and bounds: search results are `document`-tagged and only the newest two stay in request; receipts keep name, query length and hit count, never text; replay refuses `search_document`; checkpoints accept `hits`; the index cache is reused for an unchanged file, rebuilt after a change, capped at 20 files, and never listed or delivered (`test:receipts` 23, `test:replay` 35, `test:checkpoints` 9). Denied paths: a query over 200 characters or with control characters, an unknown field, a path in the name and `files/index` over HTTP are refused before any launch (`test:agent-files` route test; `test:inbox-writer`/`test:files-route` baseline)
- [ ] TASK-082 live browser check: attach a 100+ page PDF, ask about a clause deep inside it, confirm the answer cites a page and History shows "Searched document"; attach `.xlsx` and `.pptx` and ask for a named sheet value and slide 3. Owner-run after a desktop image rebuild (not yet run)
- [x] TASK-084 extract/value reuse: the value is saved only when the page shows the exact text, `{{name}}` types it, an unknown or branch-carried name is invalid, and a canary or out-of-task host in a value is refused before saving (`test:agent-step-loop` 82/82, `test:receipts` 24/24)
- [x] TASK-084 navigate/select: navigate opens an allowed `http(s)` page and refuses another host (schema refuses `javascript:`, `file:`, `data:` and credentials); select grounds the dropdown and chooses the option; extract/navigate/select add no permission name and are default-deny through `click`/`type` (`test:agent-step-loop`, `test:desktop-controller` 15/15)
- [x] TASK-084 proof and bounds: receipts keep `extract{name,chars}`, `navigate{host}`, `select{target,option_chars}` and `type.values` (names only), never the value, host path or option text; checkpoints keep value names only; replay refuses the three kinds; snapshot results carry `frame`, `shadow` and `paymentFrames` (`test:receipts`, `test:checkpoints` 10/10, `test:replay` 35/35, `test:page-snapshot` 3 + 1 skipped)
- [x] TASK-084 real-browser fixture pass 2026-11-03: all 7 spike fixtures (open-shadow/frames/cross-site/sensitive/payment/obstruction/heavy) listed expected controls and omitted sensitive/covered ones with the production scanner inside the live desktop image (`ECLIPSE_PAGE_SNAPSHOT=1`, headed Chromium on an isolated :99 Xvfb, test run as `nobody`; `test:page-snapshot` 4/4). Fixtures staged under a disposable /tmp path and removed afterwards with the display; no agent screen, home or volume touched.
- [ ] Live owner tasks: HN headline into a mock note; click a field inside an iframe form. Still needs a real owner session.

- [x] TASK-083 conversation: the last 10 messages from 24 hours, each cut to 1,500 and 6,000 total, keep the newest; the current message is excluded; owner text is `user`, agent replies `agent`, other cards become one code line; a clarification and its answer reach the next run; routines get none and a branch uses messages before its source run (`test:conversation` 3, `test:chat-run` wiring).
- [x] TASK-083 scope: a host or email in earlier owner text is in scope; one that appears only in an agent reply is still refused (`test:agent-scope` 9).
- [x] TASK-083 limits: 60 steps, 30 minutes and 400,000 weighted tokens (uncached input + output + a tenth of cached); a 90 % cached 60-step run is not stopped early; shell agents keep 1.5M/60 min; heal's 8 is respected (`test:agent-step-loop` 97).
- [x] TASK-083 live route/card: owner-scoped, no-store, null when idle, newest 20 compact steps and cost when running, another owner is 404; the card polls 2 s while active, shows elapsed time/cost, Cancel posts the existing cancel route, and the live card is never stored (`test:live-run` 2; route/UI wiring checked; browser pass pending).
- [ ] TASK-083 live browser check at 1440/375: ask a page question, then a follow-up using "it"; watch the live card steps/cost, press Cancel, and confirm the reply card replaces it. Needs the owner model key.

## Desktop image foundation

- [x] TASK-010 offline guards reject host mounts/ports, credentials, root/capability changes and mismatched image identities; dependency/sandbox constraints are checked.
- [x] TASK-010: approved package lock verifies 445 archives / 250231110 bytes before offline installation; pinned Node/Chromium image builds and every required tool executes. Earlier snapshot outage remains historical. TASK-087 adds venv/pip, ripgrep, jq, patch, procps, zip and file to the same locked closure; `check-tools` runs each version.
- [x] TASK-010: run 0d69e5bc-7966-4ef3-8e5f-40035b2e00e0 verifies non-root Xauthority/Openbox, accepted/rejected VNC authentication, noVNC WebSocket, 1024x768 PNG and three-frame video; cleanup complete.
- [x] TASK-010: run c66f0dda-e890-428b-8f58-a1df20c978fa passes genuine Playwright and xdotool clicks in graphical Chromium; chrome://sandbox reports namespace/PID/network and Seccomp-BPF active. Parent has zero capabilities/no-new-privileges and ordinary chroot remains denied.
- [x] TASK-010: desktop Compose health and runtime isolation settings pass; both five-service http-security tests pass after the package and ADR-025 sandbox revisions.
- Fixed 2026-11-03: `npm run test:http-security`'s fresh-database stack returned 500 for the authenticated home page; the app role lacked `SELECT` on `teach_recordings` (`42501`) because `scripts/db-migrate.mjs` never granted it (provision-only parity gap also covered `memory_review_state`). `db-migrate.mjs` now mirrors `db/provision.sql` for both tables; grant sets verified identical. Independent of TASK-048; the app's cap-drop/no-new-privileges posture does not change the result.

## Persistent agent identities (TASK-011)

- [x] Run d778a3ca-9d63-4786-b1ae-5609581324f0: real distinct NSS identities, UID/GID 20000+, mode-700 home/inbox/outbox/work/profile/Downloads; idempotent owner-scoped creation and actual owner CLI inspection.
- [x] Both agents have zero effective/permitted/inheritable/ambient/bounding capabilities, no supplementary groups, no-new-privileges and no sudo; attempts to set UID 0 or read/write peer files, registry and hidden backing storage fail.
- [x] Downloads direct execution returns EACCES while an identical work executable succeeds; descendants cannot mount even inside a new user namespace. Changed Downloads aliases are rejected.
- [x] Reduced PID 1 loses SYS_ADMIN including bounding; inherited filter is present. Reduced administrator mount and x32 syscall probes are denied on x86-64 (the aarch64 path uses its own mount number and has no x32 step; native run pending). Read-only root, no host mounts, secrets or published desktop ports remain checked.
- [x] Concurrent duplicate creation returns one identity; malformed registry, owner mismatch, invalid paths and stale lock stop without overwriting data. Container recreation preserves UID/NSS mappings, private markers/profile fixtures and Downloads noexec; unrelated volume data survives. Disposable cleanup completes.
- [x] TASK-011 regression: test:desktop-image passes all 6 tests, including graphical sandbox/input/VNC/capture (run 1723128b-490b-4826-ab2d-adb07a7c67af). Both five-service test:http-security checks pass. These are Docker Desktop Windows results; other hosts remain unverified. TASK-012 now verifies the per-agent screen/session layer.

## Per-agent graphical sessions (TASK-012)

- [x] Run b6cbc929-f929-456f-b454-bdef8df04461: two simultaneous UID-isolated Xvfb/Openbox/headed Chromium sessions, independent real windows, synthetic persistent cookies/local storage, idempotent start/status/stop and actual owner CLI.
- [x] Missing/peer Xauthority is rejected; profiles, supervisor socket and peer worker IPC descriptors deny access. Workers/outer browsers have all capability sets zero and no-new-privileges. Inner Chromium helpers have only verified private single-UID mappings and namespace-local capabilities; sandbox status confirms namespace/PID/network and Seccomp-BPF active.
- [x] No X11 or CDP TCP listener/published desktop port; browser control uses private pipes. Conflicting displays and live profile locks are refused without deleting the conflicting artifacts.
- [x] Graceful stop leaves no live agent processes, preserves its peer and reopens saved profile state. Xvfb crash and SIGKILL of the worker trigger session-only cleanup; fixed same-UID fallback removes verified descendants and private runtime files without CAP_KILL.
- [x] Container recreation leaves sessions stopped until explicitly started; synthetic cookies/local storage and unrelated volume data survive. Test cleanup is complete. Real account login/credential handling and the app/controller/streaming/takeover are still separate checks.

- [x] TASK-012 regressions: test:agent-users 4/4 (run 841b4734-699d-4aae-a883-d68e909fa09e), test:desktop-image 6/6 (run bfaa3174-68d6-4938-9816-08555b5fef24), five-service test:http-security 2/2 including production build; lint/typecheck/diff checks pass. Re-verified 2026-11-03 2/2 after the fs.read workaround (direct pre-build + `--no-build`), the `teach_recordings`/`memory_review_state` migrate-grant fix, and the cap-drop-aware legacy fixture (unprivileged file plant + minimal-cap chown helper).

## Independent desktop, browser and headless work (2026-11-03)

- [x] `session-sandbox` starts the agent worker with no Xvfb, Chromium or VNC; `session-status` reports `sandbox=running, graphics=stopped, browser=stopped`. Real headless worker: `shell.run` returns its output, `capture.screenshot` and `file.open` return `visual_unavailable`, and no agent process is left after close (disposable Linux run).
- [x] Closing the managed Chromium leaves `state=running`, `sandbox=running`, `graphics=running`, `browser=stopped`, and the VNC stream/peer stay up. `session-browser-start` restores `browser=running` with the same generation and profile; repeated close/start does not orphan processes (disposable Linux run).
- [x] `session-desktop-stop` stops graphics and browser but keeps `sandbox=running`; the worker remains for shell/files and no Xvfb/Chromium is left. `session-desktop-start` restores graphics and browser. A peer session is unaffected throughout (disposable Linux run).
- [x] `npm run test:agent-sessions` live 6/6 includes the browser-close/restart and graphics-crash regressions, profile/cookie persistence, peer isolation, no X11/CDP TCP listener and real sandbox checks.
- [x] Offline no-screen: `test:agent-step-loop` 75/75 covers a shell run with no screenshot/after hash, a stopped-desktop click that acquires graphics and re-grounds, `start_desktop` success and denial, and graphics closing mid-run continuing headlessly.
- [x] Lifecycle seam: `test:desktop-lifecycle` 6/6 and `test:desktop-controller` 14/14 cover browser-close independence, explicit browser restart, graphics stop, sandbox-only failure, strict lifecycle schema/result validation and authenticated controller dispatch.
- [x] Route/security: the desktop lifecycle GET/POST require owner auth; POST requires exact Origin/CSRF and a bounded action body. Offline route tests cover unauthenticated denial and fixed error mapping (`agent_paused`, `crew_stopped`, `security_stopped`, `budget_exhausted` → 409; desktop/browser failures → 503).
- [ ] Stop/Start update the UI: after a successful action the button frees at once and the state settles within 20 s, or an alert says the desktop didn't confirm; a stalled request times out (75 s action, 10 s refresh) with an alert, never a stuck button. Later Stop→Start→Stop success is reported in `docs/MEMORY.md`; retain pending until the complete check is recorded.
- [ ] Phones/tablets open exactly one live stream, only once the real viewport is known (no stream from the guessed 1440 px first render). Later phone/tablet success is reported; retain pending until the run evidence is recorded.
- [ ] Browser UI at 1440/375: separate Desktop/Browser labels, Start/Stop controls, browser-closed banner, desktop-stopped empty state, chat remains usable, and keyboard/mobile access (needs the owner login; pausing/resuming the agent remains a separate control).
- [ ] Live denied paths for the owner routes: paused agent, security stop, stopped crew, exhausted budget, cross-owner and CSRF-invalid requests leave safety state unchanged (offline mapping covered; live exercise pending).

## Desktop polish (TASK-077)

- [x] Generated agent-local tint2 dock (Browser, Files, Terminal, clock) and pcmanfm desktop with Home, Trash, Downloads, outbox and work; File System/mounts hidden; automount/autorun off; fixed launchers and private session D-Bus.
- [x] `npm run test:agent-sessions` live 6/6: two agents have independent dock/desktop/bus; Browser focus keeps one managed process and tabs; Files opens a window; xterm is the agent UID in `work` with zero capabilities and its private namespace; stop/crash leaves no orphans.
- [x] `npm run test:desktop-polish` 4/4 covers generated config, path/uid denials, launcher identity checks and the image/lock pins.
- [ ] Wallpaper: owner asset not supplied yet; verify the actual image on both sessions without covering the dock or icons. TASK-077 stays unticked until then.

## Agent hearing (TASK-079)

- [x] Disposable Linux run: one private PulseAudio null sink per agent; a 440/660 Hz marker reaches only its own monitor (agent RMS ~2.7k), a peer capture at the same time stays at the ~314 noise floor, and peer runtime/cookie reads return `EACCES`.
- [x] Controller path: `audio.capture{seconds:3}` through the manager and app-network source returns HTTP 200 `audio/wav`, ~2.9 s and non-silent samples; the capture-specific channel timeout applies; `audio.capture` is refused without a browser.
- [x] `npm run test:agent-audio` 5/5 covers the 1-30 s schema, canonical WAV/chunk/size checks, path/uid denials, opt-in action, replay refusal and wiring; `test:audio-transcribe` covers Meta-only pricing, budget, one pre-dispatch charge, silence and no-retry uncertainty.
- [ ] Paid live check: transcribe one non-sensitive known spoken fixture through Voice Transcribe with the owner's Meta key; verify text, one audio charge and cleanup. TASK-079 stays unticked until then.

## Crash-safe runs (TASK-085 core)

- [x] Migration 0031 adds `runs.heartbeat_at`, `runs.cancel_requested_at`, `runs_heartbeat_idx`, `run_meta.handoff_of` and the expanded trigger/audit checks; applied to the live database after a backup. Migrations 0032 (crew reports/starter crew) and 0033 (`run_meta.parent_run_id`, `subagent` trigger) also applied live after a verified backup, followed by a full `db:provision` pass.
- [x] `test:run-sweeper` 3/3: a heartbeat updates the row, stops on a missing (already sealed) row, reports a database cancel, ignores database errors, and `sealExisting` derives count/head/summed usage and signs once.
- [x] `test:jobs` 16/16: heartbeat younger than 90 s is Running, an old heartbeat is Not sealed, rows without a heartbeat keep the 15-minute rule, and the Interrupted label maps correctly.
- [ ] Live restart: start a long run, restart `app`, confirm the run shows Interrupted within four minutes, export verifies, and Continue works. Live app image rebuilt from the current tree and recreated 2026-11-03 (`main-app` `c5638cb…`, CSP nonce headers verified on `/login`). Still needs a saved Main model (no provider/key is configured; paid calls need explicit authorization).
- [x] Handoff, @mentions and Continue are built (2026-11-03): the new permission is on for new agents and has one explicit bulk enable for existing ones; `handoff{agent,note}` copies the stored owner message, tags the note `agent`, enforces two hops/no-return/self/paused/busy, seals `handed_off`, writes `handoff_of` to the receiver header and audits both sides. A leading `@Name ` routes and unknown names send nothing; the interrupted card and History open the existing rewind dialog at the last complete checkpoint. `test:handoff` 4/4.
- [ ] Live handoff and mention acceptance with two real agents (web search, then `@Scout check my calendar`) and cross-process Cancel ≤20 s remains owner/model-gated.

## Screenless helpers (TASK-076)

- [x] Migration 0033 adds `run_meta.parent_run_id` and the `subagent` trigger. `test:subagents` 6/6 covers the 20% step/time/token slices, `no_tools`/`tool_not_granted`/`duplicate_task`/`subagent_limit`/`nested_spawn` refusals, concurrent helpers, data-only results, cancel cascading to every helper, and finish waiting then stopping.
- [x] Helpers never receive `ask_owner`, desktop, memory, handoff or nested spawn; risky calls use the parent identity with a `Helper N` card; each helper has its own signed run with `parent_run`/`parent_step`, heartbeat and checkpoint; Jobs counts helpers and History shows the tree.
- [ ] Live behavior with a real model: "What's my latest email?" and "Download the invoice from the vendor portal" spawn no helper; the parallel form/lookup task spawns helpers. Needs a saved Main model and paid authorization.

## Chrome for Testing (TASK-078)

- [x] Spike run: the measured Chrome for Testing 156.0.8078.80 archive (201329937 bytes / SHA-256 b711c720…) launches under the production read-only root, zero capabilities, seccomp and `--network none`; namespace/PID/network and Seccomp-BPF are active; real H.264+AAC MP4 frames and audio decode; page-structure grounding finds Save; Playwright and xdotool clicks work; screenshot, multiple tabs, download, session-cookie restart and two isolated profiles pass.
- [x] `npm run test:chrome-for-testing` 4/4 covers the per-CPU lock rows, exact byte/SHA validation, downloader rejection paths, image wiring and the no-publish check. `npm run spike:chrome-for-testing` writes the sanitized report under `test-results/chrome-for-testing/`.
- [x] Production image builds with the pinned archive; `check-tools` reports `chromium 156.0.8078.80`; the existing desktop smoke and two-agent session suites pass (see the run logs).
- [x] ARM64 row: `browser-build.lock.json.browsers.arm64` pins the same version, 200722708 bytes, SHA-256 1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724; the downloaded ELF is aarch64 and the archive root is normalized to `chrome-linux64`. This is artifact evidence, not a native run; `test:desktop-architectures` checks the target/pin/refusal paths.

## Native ARM64 (TASK-066)

- [x] Pinned inputs resolved to ARM: `ubuntu:24.04@sha256:fe81560…` → linux/arm64 `sha256:19cad596…`; `node:24-alpine@sha256:8a32c8c…` → linux/arm64 `sha256:e6439844…`. Artifacts measured locally (not a native run): Node v24.22.2 `linux-arm64` 30968168 bytes / `eb187837…` matches the signed `SHASUMS256.txt` (key fingerprint 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356); CfT 156.0.8078.80 `linux-arm64` 200722708 bytes / `1f496a82…`, ELF aarch64.
- [x] `npm run test:desktop-architectures` covers the 18 names/numbers on both ABIs against Linux v6.8 fixtures, foreign-ABI kill, x32-only-on-x86, per-CPU lock/host/ABI refusals, resolver parsing, browser target/normalization and preflight refusal. The resolver's amd64 pipeline produced 445 entries / 250231110 bytes with the same package names as the pinned lock.
- [x] amd64 pins unchanged: manifest `6d0b4072…`, 445 / 250231110; Node/CFT amd64 hashes unchanged. Native Oracle resolution (2026-11-04, host/daemon aarch64, kernel 6.17.0-1011-oracle) produced `ubuntu-packages.arm64.lock.json`: 442 archives / 242101668 bytes, SHA-256 `acc7f512e07138ff80fb3fb68be4021e7002ed5f1f9b8494014889d6593bc0e2`. Signed apt metadata supplies package hashes; the downloader independently verified all 442 archives in a disposable native container. `procps` is already present in the pinned ARM Ubuntu base. Wrong-CPU and tampered-manifest denials pass.
- [x] Native Oracle image build and standalone smoke (2026-11-04): `eclipse-arm-verify:20261104`, image ID `sha256:3b42927fd084db759fd341c7b376882615c502001301d8c1b9a08bb46461e213`, image/marker `arm64`, no QEMU registered. Tool inventory passed (Node 24.22.2, Playwright 1.64.1, CfT 156.0.8078.80, Openbox, file manager, dock, audio/development tools). All five smoke checks passed: nonroot tools, authenticated Xvfb/Openbox, authenticated VNC/noVNC WebSocket, PNG/video capture, sandboxed Chrome/Playwright/xdotool; namespace and Seccomp-BPF true. The exact owner wallpaper is in the image (SHA-256 `b1da503eeb3da066e5664e523a5e40b30b808fe27d4c1cddb518cfd1fe8472a2`). Native Node/Undici crashed during Ubuntu downloads; build-time HTTPS streaming plus bounded socket retries resolved it without relaxing integrity checks. Evidence: `data/acceptance/task-066/2026-11-04-flQrIpV8/`. Verification containers removed; no app deployed or public port opened. Local architecture 8/8, focused package/security checks 6/6, focused ESLint and syntax checks passed.
- [ ] Native Oracle (`node scripts/acceptance/arm64.mjs --preflight`): host/daemon arm64, then `resolve-package-lock.mjs --arch arm64`, review the lock, build/start/ps, `check-tools` shows arm64 and every tool version, only `127.0.0.1:3000` published.
- [ ] Native filter/users/isolation/sessions: 18 safe-argument probes EPERM, `unshare --user --net` works, two-agent peer/loopback/audio/file denials, cookies across restart.
- [ ] Native browser: `chrome://sandbox` namespace/PID/network/Seccomp-BPF, H.264/AAC fixture, structure-grounded clicks, no testing bar, smoke passes.
- [ ] Native app/E2E: argon2 positive/negative in the ARM app image, fresh DB roles/migrations, auth, stream/takeover, signed export/offline verify, SSH tunnel `ssh -L 3000:127.0.0.1:3000` with no public Oracle port.
- [ ] Apple Silicon through its own native ARM64 Linux VM: independent run, not inferred from Oracle.
- [x] amd64 regression: lint/typecheck/build pass; `test:agent-users` 4/4, `test:desktop-image` 6/6 incl. Compose smoke, `test:agent-isolation` 1/1, `test:agent-sessions` 6/6; direct image build, tool inventory, seccomp probe and marker refusals pass. `test:db-roles` full run and `test:auth-desktop-e2e` in progress after the fs.read workaround (pre-build images directly with unique tags, `compose up --no-build`; engine policy unchanged, documented in `.github/README.md`).

## Live desktop and takeover

### 2026-11-03 takeover input policy (supersedes width-based "view-only on phones"; older evidence stays recorded)

- [ ] `npm run test:takeover-eligibility` 8/8: trusted mouse + trusted non-composing keyboard required; touch/pen, synthetic, IME-composing, modifier-only, and mouse-only/keyboard-only never eligible; reset clears.
- [ ] Touch-only viewport (375 and 1280 px emulation): Take over shows "Connect a keyboard and mouse to take over"; remote input impossible; app navigation stays usable.
- [ ] Mouse-only, then keyboard-only, interaction each leave the stream view-only.
- [ ] Click Take over (mouse) then press Enter (keyboard) enables takeover at 1440, 1280 and 375 px; the two-step check forwards nothing to the desktop (no `/input` requests during the check).
- [ ] After takeover: clicks, drag, wheel, right-click, typing and paste forward; touch/pen pointer events are ignored; a touch long-press context menu never reaches the desktop.
- [ ] Loss paths: stream disconnect, page hide/resume and capability change reset evidence, block queued input and release the lease; a failed release keeps Hand back and the error visible.
- [ ] Resizing the panel or window never revokes eligibility, never reconnects the stream, and an active takeover stays active.

- [ ] Desktop view connects within 2 seconds (latency target requires measurement)
- [x] Real authenticated noVNC canvases show two distinct 1024×768 agent desktops (disposable browser run 25ac0609-146f-4109-accd-2f52119ff311)
- [x] Takeover acknowledgment waits for active work and prevents queued agent input/screenshots from dispatching; stale owner/generation/lease fail (behavioral manager tests)
- [x] Owner scaled pointer/text, handback and route-leave release work through the actual browser; remote text and resumed agent capture are verified
- [x] HTTP/WS controller requires service secret and exact app peer; missing/wrong secrets, spoofed source, stale generations and unknown agents fail
- [x] RFB view-only protocol rejects key/pointer/clipboard injection; private VNC challenge authentication and sanitized pixel transport pass synthetic TCP/WS tests
- [x] Revoked/replaced sessions close native streams within five seconds; silent peers and application shutdown release streams (behavioral bridge tests)
- [x] Real browser logout revokes HTTP and the live stream; real takeover blocks agent capture/input until release
- [x] Agent-directed typing/key input is denied on actual password/OTP controls, including inside single and nested closed shadow roots; ordinary focused text input still works (TASK-012 run 01331fe8-87b7-4535-b598-375fa9aec997)
- [x] Trusted owner takeover marker is manager-generated, rejected on browser input, and allows manual type/key input on a synthetic sensitive field; recording stays off until the owner presses Record (TASK-036).
- [x] Pinned noVNC package normalization preserves awaited feature detection and fails on changed bytes/version; real x11vnc true-colour flag 255 is accepted with view-only filtering retained
- [x] Interrupted session startup cannot deadlock supervisor shutdown; uncertain sessions can be explicitly stopped
- [ ] Agent stops at login walls, CAPTCHAs, OTPs and payment checks and asks the owner
- [x] Agent screenshot dispatch is blocked during takeover; teach Record now opts in separately (TASK-036 managed browser)
- [x] Full screen opens the expanded view inside the app window: the app header stays and the browser does not enter fullscreen (TASK-068; real browser at 1440 px, `document.fullscreenElement` stays null, workspace behind is inert)
- [x] Opening and closing Full screen does not reconnect the stream, and an active takeover stays active; Esc goes to the desktop during a takeover (same single WebSocket count before and after, Esc exits only without a takeover, Tab stays inside, focus returns to the Full screen button)
- [x] On phones (375 px) the expanded view is view-only (no Take over, no horizontal overflow, no reconnect)
- [x] Default Actions: the create form pre-fills the seven known actions (browser run), API creates without actions still have none, the stop text names the action and where to change it, and migration 0008 on a throwaway Postgres adds the file actions to non-empty lists only and is idempotent (`npm run test:actions-migration`); provisioning and upgrade tests pass with 9 migrations.
- [x] TASK-027 mocked: 4 routing unit tests and 4 loop tests pass (Fixed never escalates; Auto escalates after a failed or repeated turn; capped at 5; hard-model error falls back to Main and ends escalation; each step carries model, label and route); settings round trip and validation; browser: Routing defaults to Fixed, Auto persists after reload, key never returned; database upgrade tests pass with migration 0007.
- [ ] Every step shows the model that did it (data recorded by TASK-027; visible label needs TASK-031)

## Perception and proof receipts

- [ ] Model output is an intent `{action, target, expect}`, never raw coordinates
- [x] TASK-024 mocked: strict intent schema rejects coordinates, selectors and unknown fields; exactly one `next_step` call is accepted; two invalid or non-completed outputs in a row stop the run with nothing executed.
- [x] TASK-024 mocked: valid steps run in order through the guarded desktop port; one card per run; the model's `finish` is shown as its own unverified report; default-deny action allowlist, takeover (`takeover_active`), 20-step cap, 3x repeat stop, provider errors and cancellation all stop without further input.
- [x] TASK-026 mocked (`test:clock`, `test:agent-step-loop`): clock block in the §19 format, rounded to the minute, correct across zones and daylight saving; invalid owner timezone falls back to UTC; exactly one clock block, last in `instructions`, stable text before it identical across calls; `get_time` for the owner zone and another zone, unknown or hostile zones never echoed, no desktop call, no run step, repeat limit applies.
- [x] TASK-024 mocked: owner task is the only `user`-tagged content, screenshot is `web`, history is `agent`; typed text is never replayed; clock block follows the persona; one run per agent, other agents in parallel, lock released after a failed card post. 13 tests.
- [x] TASK-025 real Chromium (`test:agent-sessions`): the snapshot lists only visible, unobstructed controls; password, one-time-code and field values, off-screen, covered and iframe controls are left out; clicking the returned point hits the control at the default window position, after moving the window, and after scrolling.
- [x] TASK-025 mocked (`test:agent-grounding`, `test:agent-step-loop`): exact, partial, role-word, tie, weak and injection-named controls; no coordinates reach the model; the control list is `web`-tagged; the first miss gives one correction turn with visible names, a second miss or an unreadable page hands off with one card; the frames hint appears only when frames exist.
- [x] TASK-091 mocked (`test:agent-confidence-gate`, 14 in `agent-visual-grounding`): after two page-structure misses a click is grounded by one confident SAM mask (centroid or nearest set pixel), else by native computer use (screenshot first, exactly one left click in bounds; premature clicks, other actions and any pending safety check refused, never auto-acknowledged); irreversible visual clicks need SAM + computer use to agree, ordinary ones may use the model's pixel check; payment-frame pages and a changed page refuse; re-grounding after approval may drift ≤16 px; no grounder still hands off.
- [ ] TASK-091 live: with SAM on and `muse-spark-1.3-contributor` as Main, a canvas or unlabeled control is clicked through the visual rungs and the receipt lists both methods
- [ ] TASK-024 live: a real model produces valid steps and a click lands on a grounded target. TASK-046 transport exists; authorized real-provider acceptance remains pending.
- [ ] Targets are found from page structure on normal websites (live run with a real model; not yet verified)
- [ ] With SAM on, targets are located and verified with SAM masks; with SAM off, receipts say "SAM off"
- [ ] Irreversible actions (send, delete, purchase, payment hand-off) ask when two methods don't agree
- [ ] Adding a model detects its capabilities (tool calling, vision, computer use)
- [ ] Every step writes a receipt (before/after hashes, target, method, confidence, result, cost, `prev_hash`). TASK-029: mocked step-loop tests (`test:receipts`, 23) and a real Postgres container pass; a live run with your saved model key is still to be done.
- [x] TASK-029: the chain, signature and seal are canonical, deterministic and match the RFC 8032 Ed25519 test vector; typed text, file contents and credentials never appear in a receipt; SAM off/on/unavailable is stated per receipt
- [x] TASK-029 (cannot): no signing key means no run (fixed card naming `npm run receipt-key`); a failed start or a failed receipt write stops the run with `receipt_error` and no further input; the app role cannot UPDATE or DELETE `steps` or DELETE `runs`; a seal rewritten through the app role fails verification; another owner's run exports as 404
- [x] `eclipse-crew verify run.json` passes on an untouched export (TASK-030: `test:verify-cli` 9 pass + 1 skipped symlink on Windows; `test:run-export-route` against a disposable Compose stack passes, including the `docker exec` stdin form, a symlink launcher and `key-id` inside the app container)
- [x] `verify` fails if any step is altered, removed or reordered (also swapped signature, other key under a pin, unsealed, changed header, wrong step count; unreadable or oversized input exits 2; a crafted file cannot print escape codes; a receipt edited in the real database is caught)
- [x] History shows before/after thumbnails and pass/fail per step (TASK-031: real Chromium on a signed run seeded through the production recorders, 1440 and 375 px; screenshots `data/spikes/audit-repairs/fec106dc-76fc-45e2-b985-fc7046afc5dd/task031-history-{1440,375}.png`)
- [x] TASK-031: the SAM outline appears only on the "after" image and only when SAM passed (scaled from the stored box); with SAM off the step says "Page structure (SAM off)" and has no outline; the outline is labelled a display annotation
- [x] TASK-031: "Chain verified" comes from re-checking the stored receipts on load; editing one stored receipt shows `receipt_hash_mismatch` at the right step; an open run shows "not sealed yet" (`test:history` against Postgres, and in the browser)
- [x] TASK-031 (cannot): the evidence route needs the owner session (401 otherwise); a hash that is not before/after evidence of that owner's run, an unknown run and a malformed hash are refused (404/400); served bytes re-hash to the signed receipt hash; the peer agent lists no runs; the app role cannot UPDATE or DELETE `step_evidence` (`db-roles`)
- [x] TASK-031: a stored receipt that cannot be read becomes a placeholder row; a missing screenshot shows "screenshot not stored"; a failing evidence store never stops a run (`test:history`, `test:agent-step-loop`)
- [ ] Evidence retention (32 days): step Download saves the PNG; Export run.json still verifies after its screenshots age out (purged steps show "expired" copy); Mission Control Runs warns at 80% of `ARTIFACTS_CAP_BYTES` and purges oldest early at 100% (receipts never purged)
- [ ] ≥ 95% of steps on the demo routine are verified

### TASK-028 verification acceptance

- [x] Mocked: closed expectation grammar; supported DOM failure cannot be overridden; bounded local polling; model fallback only when needed; SAM off makes zero SAM requests; unavailable and missing-confidence states remain explicit.
- [x] Mocked: independent target agreement before click/type/Enter; mismatch, changed target, unreadable page and missing focus stop before input; takeover during verification pauses without another action. No model coordinates or selectors execute.
- [x] Mocked: strict visual verdicts reject invalid/incomplete/safety-review output; source tags and clock included; 512-token caps, no retries; token usage includes verification. SAM decoder validates allocations, dimensions, actual masks and confidence.
- [x] Disposable Chromium (`test:agent-verification-desktop`): consecutive page.verify reads, exact visible controls, missing/covered/off-screen/sensitive/iframe exclusions, duplicate-name unknown, focused-control metadata without field values, and calibrated/repeated clicks after window movement/scroll. Evidence: `data/spikes/task-028/3ca5ba56-9a78-4982-83f7-2b7cafe195c1/result.json`; disposable resources cleaned.
- [x] Full desktop/session lifecycle regression (`test:agent-sessions`): 5/5, including page verification checks; evidence `data/spikes/task-012/17bf5160-809c-4360-b7a7-3af447db7399/result.json`, cleanup complete. Controller/takeover tests: 25/25. Mocked provider/runtime/settings/clock suites: 108/108. Existing SAM spike tests: 10/10.
- [ ] Real Main/SAM provider acceptance and end-to-end chat verification, including cost/latency on the demo routine (not run automatically; requires separately authorized usage).
- Receipt-specific SAM-off labels, signatures and persisted proof are TASK-029 (done; see above). Earlier TASK-024 unverified execution tests are superseded by the conservative TASK-028 gate and injected verification fixtures; pure chat summaries remain model reports.

## Teach from video

- [x] TASK-036 (managed browser) Take over → Record → do a task → Stop captures video, events, targets, before/after shots and narration. Disposable run `caf2116a449bfa36`: 59 frames, 4 accepted events, synthetic mic narration, ordinary takeover recorded zero events/bytes, and disconnect aborts. Privacy pauses covered password, OTP, CAPTCHA, iframe/shadow-root and unsupported-scheme surfaces. Native desktop/terminal capture is owner-deferred for v1.
- [x] TASK-036 (managed browser, cannot): stale leases, cross-owner IDs, arbitrary artifacts, oversized uploads, bad WAV/turns, duplicate sequences and encoder/storage failures fail closed with no raw capture retained. Fresh Postgres run `624d57b01c1fdf2f` passed 16 migrations, owner-only routes, cross-owner 404s, idempotent Stop, append-only audio ledger and discard cleanup; artifact symlink/hard-link cases pass in the disposable Linux container.
- [x] TASK-036 (managed browser) Passwords and OTPs are masked in the capture: sentinel text/pixels are absent from decoded video, shots, manifest/events, audio/transcript fixtures, API/error/log responses and encoder inputs across sensitive transitions. Exclusion from the generated skill is covered by TASK-037.
- [x] TASK-036 (live owner stack): rebuilt/recreated app+desktop, created one temporary owner-scoped session and agent, and recorded the mock invoice page through a real takeover lease. Stop returned `complete` with 1 event and 5.474 s active; the saved-recording list returned the capture, review returned 200, the 36,959-byte WebM artifact returned 200, and Discard emptied the list. Cleanup removed the agent, session, capture row, artifacts and vendor process. Narration stayed off (`narrationAllowed:false`) and ASR was not called because the live DB has no Meta provider with a stored key.
- [x] A draft `SKILL.md` is generated with steps, inputs and a check per step (TASK-037: structured model output, deterministic renderer, validation/route/retention tests; real-provider generation pending)
- [x] The skill shows how it was learned (TASK-037: "Learned from steps + screenshots"; video path pending)
- [x] After approval the skill enters later chat context and can be referenced by a routine confirmation (execution awaits TASK-039)
- [x] After approval the recording is deleted and one reference screenshot per step is kept (copy/cleanup invariants tested; live approval with a real capture pending)

## Rewind and branch

- [x] Rewinding to step N restores the agent's state and files at that step (`test:rewind`, real Postgres: changed/missing files written back, later files moved to `.rewound`, unchanged files kept)
- [x] TASK-032: a checkpoint is saved before the first step and after every receipt; state and file manifest are content-addressed blobs; an unchanged file is fetched and stored once across the run, a changed file gets a new blob (`test:checkpoints` against Postgres)
- [x] TASK-032: the stored state never holds typed text, screenshots, document contents, keys or tokens, and a state with unknown fields or over 256 KiB is refused on read (`test:checkpoints`)
- [x] TASK-032 (cannot): the desktop tool refuses `..`, absolute paths, symlinked files and directories, FIFOs, hard-linked and hidden files, wrong hashes and files over 4 MiB, and never reads a peer agent's home (`test:checkpoint-tools`, the real desktop image as root, and the real listener with two agents in `test:inbox-writer`)
- [x] TASK-032: a transient failure is retried once and the checkpoint stays complete; a persistent failure, a body that does not match its hash, a port without file support and a capture over the time bound each give a `partial` checkpoint with a fixed reason, the state is still saved, and the run continues; History shows "Can't rewind to this step"
- [x] TASK-032 (cannot): the app role cannot UPDATE or DELETE `checkpoints`; a checkpoint index cannot repeat in a run; provisioning rejects an altered `checkpoints` schema or an extra grant (`db-roles`)
- [x] A correction continues the run as a new branch without re-running earlier steps (`test:rewind`: saved history/documents and the correction reach the first model call, step numbers continue, new steps start at 1; no earlier desktop action is executed)
- [x] The original branch stays visible in History (`test:rewind`: the original export is byte-identical and still verifies; History lists the branch and the branch reads `branch_of`/`branch_at` from the signed header)
- [x] TASK-043 (cannot): a partial checkpoint, missing/tampered blob, unsealed or chain-failed run, another owner's run, a step above `step_count`, a paused agent, takeover, a missing model/key and a busy agent are refused with nothing written and no run; a mid-restore failure starts no run and a second request finishes the restore (`test:rewind`)
- [x] TASK-043 (cannot): the restore tool refuses `..`, absolute, hidden and odd paths, symlinked files/directories, hard links, wrong hashes, bodies over the limit and a non-UUID bucket; `aside` never overwrites (`test:checkpoint-restore` 10/10 in the rebuilt desktop image as root; the two authenticated listener routes are covered by `test:inbox-writer`)
- [x] TASK-043: an ordinary run header stays byte-identical; a branch export verifies offline and carries signed `branch_of`/`branch_at` (`test:rewind`)
- [ ] The UI states that external side effects (sent emails, orders) are not undone (text is in the rewind dialog; live browser check pending)
- [ ] TASK-043 live browser at 1440/375: seed a signed run, open the rewind dialog, create a branch on a real desktop, and verify both exports

## Routines and jobs

- [x] Scheduler startup failure logs that scheduled routines are paused without preventing app registration; normal startup and runtime/build guards remain intact (`tests/instrumentation.test.mjs`, 2 tests).
- [x] A routine created in chat shows a routine card; confirming saves it (TASK-038: live browser confirmation, reload persistence and duplicate-row check at 1440/375 px)
- [x] Skill-only routine records and confirmation responses accept zero steps; routines without a skill require steps, and all steps retain their length and count limits (`test:routines`).
- [x] Scheduled and Run Now executions pass canary, approvals, allowed hosts and security/scope hooks into the step loop, with the run ID on security stops (`test:scheduler`, mocked wiring; `test:agent-step-loop` covers denied paths).
- [ ] Once, daily, weekly, monthly, custom weekdays and cron schedules fire at the right local time
- [ ] Run Now starts it immediately with live step status
- [x] A duplicate scheduler tick does not run a routine twice (TASK-039: live pg-boss duplicate enqueue returned `false`; real second tick queued zero jobs; deterministic execution id + `SKIP LOCKED`)
- [x] One agent runs one job at a time; different agents run in parallel (TASK-039: queue `groupConcurrency: 1`, worker `localConcurrency: 4`, existing agent lock tests)
- [x] After the stack was down, missed runs follow the catch-up policy (run once / skip / run all) (TASK-039: policy matrix tests plus live run-once catch-up advanced `next_run_at`; live full-stack outage check pending)
- [ ] Second run of a verified routine with no site change makes no model calls ($0.00 model cost)
- [x] TASK-044: on a site-change mismatch the agent self-heals and proposes a diff (`test:heal`: scripted repair run with real signed receipts/Postgres; live mock-portal repair pending)
- [x] Self-heal repair preparation supplies the `heal` trigger and `Self-heal repair` label for Jobs metadata (`tests/heal-ports.test.mjs`: mocked production wiring).
- [x] TASK-044: approving the diff updates the saved replay; the next run uses it (`test:heal`: approval appends v2 and `getScript`/`listScripts` resolve it)
- [x] TASK-042 Part A: Jobs dashboard lists runs with status, agent, trigger, duration and cost (`test:jobs`: owner scope, all outcome filters, 24h/7d/30d/all ranges, agent filter, cost, keyset paging)
- [x] TASK-042 Part A: Run detail shows the step timeline, receipts, errors and retry history (`test:jobs`: summary, signed input, final output, delivered files, failed step codes, retry chain, existing timeline route)
- [x] Run now, Cancel, Retry and Pause/Resume work from the dashboard (Part A: Cancel, Retry for chat and routine Pause/Resume pass in `test:jobs`; Part B: Upcoming and Crew actions mount TASK-040's Run now with live execution status, a scheduled run retries through the routine queue with `retry_of`, and runs with no routine or replay/branch/heal triggers are refused; a live signed model/desktop step remains TASK-040's pending item)
- [x] TASK-039: pg-boss starts under the runtime role, duplicate enqueue is idempotent, and the worker settles jobs (`test:scheduler`; live app-role queue/idempotency/settlement pass)
- [x] TASK-040: Run Now is owner/CSRF/rate limited and returns a pollable execution (`test:scheduler`; live 401/403/404/202 and queued→retrying status pass)
- [ ] TASK-040: a signed Run Now step appears live in the routine card (no disposable provisioned desktop was used; synthetic agent correctly retried `unavailable`)
- [x] TASK-042 Part A: search treats `%` and `_` literally; cursor paging returns every run once; another owner's runs never appear (`test:jobs`)
- [x] TASK-042 Part A: outcomes map every `runs.status`, and an unsealed run is Running only inside 15 minutes (`test:jobs`)
- [x] TASK-042 Part A: Cancel aborts a live run, seals it `aborted`, and refuses a finished run with 409; Retry refuses Verified, Running, already-retried, replay and busy-agent runs (`test:jobs`)
- [x] TASK-042 Part A: Upcoming runs are correct for Asia/Kolkata and across the America/New_York DST change; paused routines and the agent filter behave (`test:jobs`)
- [x] TASK-042 Part B: a routine job exposes its `routineId`; a scheduled retry queues `run_now` with `retry_of` and the routine id; a scheduled run without a routine is refused (`test:jobs`)
- [x] TASK-042 Part A (cannot): anonymous calls are 401; wrong Origin and CSRF are 403; bad ids, unknown query keys and an oversized body are 400/413; `run_meta` is insert-only for the app role (`test:jobs`)
- [x] TASK-042 Part A live browser at 1440 and 375 px on a disposable Postgres and local production build: 8 seeded runs, list/detail with a chain-verified timeline, search `100%`, agent filter, Failed tab, Upcoming runs with schedule details, routine Pause/Resume, and the cancel confirmation plus its 409 message; no horizontal overflow at either width

## Demo extras: starter crew and Mission Control (TASK-058) + custom crews (TASK-089)

The morning report was removed 2026-11-04 (replaced by Schedules); its checks and `test:crew-report` were deleted. `test:crew-routes` now asserts the report files and scheduler tick are gone.

- [x] The six preview roles are the only source of policies and budgets; a same-named agent is never adopted, and a repeat or concurrent create never duplicates members (`test:starter-crew`: six preallocated UUIDs, one setup row, six agent/policy rows, same ids on retry).
- [x] One failed desktop keeps the completed agents and the failed identity paused; Retry reuses the same UUID and completes the set (`test:starter-crew`).
- [x] A crashed `creating` member is resumed only after its claim is stale (`test:starter-crew`).
- [x] Mission Control returns only the owner's agents, a run only while its heartbeat is fresh, real step/cost totals, local-day spend and pending approvals; a desktop error becomes `unavailable`, and only `session.status` is called (`test:crew-status`).
- [x] A Mission Control thumbnail revalidates the desktop stream state before opening its socket and shows the stopped placeholder on denial (`test:crew-routes`).
- [x] A stored `crew_report` card from before the removal stays validated text and never becomes a URL or HTML (`test:crew-routes`).
- [x] Crew routes require the owner session, exact Origin and CSRF for mutations; bodies are strict and bounded (`test:crew-routes`).
- [ ] Live browser at 1440 and 375 px: preview/edit/create the crew, a partial setup retry, two live frames plus a stopped placeholder on Mission Control.
- [ ] Live core demo rechecked after the crew extras; five-take and four-Meta-model acceptance are recorded separately.
- [x] Custom crews (`test:crews`): up to 6 members with only names + roles required; persona/budgets/tools/actions/defaults fill server-side; migration 0035 + provision grants allowlisted; a sender outside any crew keeps open handoff while a crew member can only hand to crewmates (`different_crew`).
- [x] Custom crew Retry (`test:crews`, real Postgres): only failed members are set up again, under the same agent UUID and with the persona/budget saved at create; a live `creating` claim is never taken over; a claim older than 3 minutes (app restart mid-setup) offers Retry and is reclaimed; another owner id gets 404/null; `POST /api/crews/[crewId]` needs the owner session, CSRF and an empty body.
- [ ] Live browser: stop the app while a crew is being created, restart, and confirm Retry appears after 3 minutes and finishes the remaining members.
- [ ] Live browser: create a 2-agent crew, watch both reach Ready, hand a task from one to the other in chat and confirm the second receives it; an outsider handoff attempt is refused.

## Sundance / Moondance check-ins (TASK-090)

- [x] Day/night windows incl. the overnight wrap and half-hour zones; 15 → 30 → 60 back-off after 4/8 quiet checks, 12 h cap; ±10% jitter; a check never lands outside its hours (`node --import tsx --test tests/check-ins.test.mjs`)
- [x] (cannot) Only plain https URLs: http, file, credentials, localhost, quotes, `# Test Plan

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
- [x] Provisioning compares the complete ordered model-role constraint names and definitions; altered same-name role, shape and provider-FK constraints retaining former substrings are rejected.
- [x] 0029 review fix: real PostgreSQL scoped model-role checks pass twice at 0005/0007, and message/model-role/policy checks at 0013/0028/0029/0030/0031; exact card types, background role/shape and search-index definitions are checked; same-name drift is denied; owner/history unchanged (`node --test --test-isolation=none tests/provision-0029.test.mjs`, 5/5 including full provisioning).
- [x] Full current provisioning: fresh-through-0031 disposable database provisions twice with correct `agent_policies` column/type/default positions; owner/history unchanged and runtime DDL denied. Altered policy defaults/constraints fail before changing rows, history, ownership or grants. Live provisioning not rerun.
- [x] TASK-064: isolated fresh and bootstrap-owned volumes retain owner rows and migration history across repeat provisioning and migration; Postgres has no published port.
- [x] Foundation audit fixes: failed database initialization releases its cache; concurrent calls share attempts, recovery succeeds, and privileged roles remain denied.
- [x] Foundation audit fixes: LF/CRLF migration histories provision repeatedly without rewriting hashes, rows or timestamps; other histories remain rejected.
- [x] Foundation audit fixes: non-root app writes persist across restart; isolated legacy artifacts repair preserves contents/modes and symlinks, and refuses running apps or mismatched volume labels.
- [x] Foundation audit fixes: all five services start in isolation; production CSP nonces differ per HTML request and match scripts, assets load, and nosniff/referrer/framing headers are present.
- [x] Foundation audit fixes: HTTPS policy unit checks enable HSTS only for production HTTPS; forwarded-scheme spoofing through localhost ingress cannot enable it.
- [x] Foundation audit fixes: owner confirms View project status shows and hides correctly with mouse and keyboard, including a mobile-size viewport.
- [ ] Foundation audit fixes: owner confirms no CSP errors in the browser console.
- [ ] Foundation audit fixes: verify a live HTTPS deployment and trusted TLS forwarding.
- [ ] TASK-081: judge instance on a separate VM. Owner-run checks: `curl -sI https://<domain>/login` (valid certificate, CSP nonce, nosniff, referrer, framing, HSTS), `curl -sI http://<domain>/` (redirect), external scan shows only 22/80/443, login and live desktop over HTTPS at 1440 and 375 px from a phone on mobile data, one chat run on the mock portal with an exported run verified offline, and Settings shows the agent budget and spend limit. Not run yet: owner has not deployed the VM.
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
- [x] Setup scripts (`npm run desktop:secret`, `npm run encryption-key`) share `scripts/lib/env-secret.mjs`: they create a mode-600 `.env`, are idempotent, never print a value, keep CRLF/LF endings, and never rotate or duplicate a valid key. They refuse duplicate, padded, invalid, `export`ed or symlinked entries without changing the file, and a failed write leaves `.env` intact with no temp file (`test:desktop-secret` 9/9 on Linux, `test:encryption` 9 pass + 1 symlink skip on Windows).

- [ ] **Open, retest later:** the full `npm run test:auth-desktop-e2e` (fresh Compose stack, real Chromium, all phases) must pass again. On 2026-11-04 the setup selectors were fixed for the workspace redesign (`heading 'Eclipse Crew'` → `main 'Eclipse Crew'` + sidebar link; `main 'Eclipse Crew workspace'` → `main 'Eclipse Crew'`; agent/chat/rail/sheet names) and setup now passes 11/11 with cleanup complete. It stops in **agents**: `createAgent` returns `desktopReady:false`, so the agent stays paused and no desktop/Live exists (a fail-fast assertion names the response body). Provisioning (`desktopCreateAgent` + `session.start`) fails in the disposable stack; that needs investigation before the rest of the suite can run. Fresh 2026-11-04 runs: repros (eclipseaudit6654140ff645 64 s, eclipseauditce8038362fb9 282 s, eclipseaudit2b7dc50c6113 216 s, eclipseaudit6af0c14e34d0 218 s) all stopped at 201 `desktopReady:false`; approved temporary probes (all removed, diffs verified empty) traced it to `session.start` failing in `ensure-entry` with `egress-not-configured` (fixture omitted `EGRESS_DESKTOP_SECRET`; agent-sessions sets it). Fix applied (fixture env + guard list; `node --check`/ESLint clean). Verification run eclipseauditda9bb97f26bd (483 s, cleanup complete): provisioning now succeeds — no `desktopReady:false`, agents Running with desktop+browser running — but the suite fails later in the agents phase: the script waits 60 s for `Start desktop` while the UI already offers `Stop desktop`, with desktop-stream WebSocket 403s. Missing-secret blocker resolved; new failure recorded separately; full pass not claimed. Explicit sequence run eclipseaudit0845861e66aa (135 s, cleanup complete): provisioning PASS; Stop-to-stopped NOT observed (Start never appeared in 60 s; no UI dump captured, cause undetermined); rest untested; stream 403s persist. Two later runs never reached lifecycle steps and are recorded separately: eclipseaudit2c6ffd5fac74 failed at image build (transient tree breakage in other sessions' memory files; build passes now), eclipseaudit60c4b292228f failed at setup (/settings/account now redirects to /profile by workstream intent; test updated to /profile + heading Profile with all account checks preserved). Validation run eclipseauditcc83892fc1e0 (145 s, snapshot 5a334bda + 63 modified + 10 untracked, no mid-run change, cleanup complete): Stop POST was sent but never responded within 60 s while 30 backend polls stayed running/running and the UI kept Stop with no error alert - stop hung server-side past worker (15 s) and app (45 s) timeouts; Start-to-running, Pause/Resume, Live untested; stream 403s persist separately. Temp diagnostics removed after use. Stop-path staged run eclipseaudit165b28113820 (322 s, snapshot 5a334bda, no mid-run change, cleanup complete): Stop POST completed every server layer in ~327 ms yet its response never reached the browser in 60 s; backend reached stopped at ~2 s (same generation) and stayed there while the UI correctly kept Stop with no alert - first failing stage is response delivery post-handler-return. Start-to-running, Pause/Resume, Live untested. All temp blocks removed (diffs verified empty). Staged run eclipseauditb91ea3de458f (281 s, no mid-run change, cleanup complete): Stop completed every server layer in ~409 ms and backend reached stopped, but its response never reached the browser in 60 s (UI kept Stop, no alert) - first failing stage is post-handler delivery; Start then failed with HTTP 503 service_unavailable from an unclassified 147 ms failure with no desktop interaction. Start-segmentation run eclipseaudit215c5c11710d (317 s, snapshot 5a334bda + 64 entries, no mid-run change, cleanup complete): failed again at the Stop-to-stopped UI wait (backend state unknown, no observers this round); start-path marks never fired, removed unexercised; stop success 1/3 runs, UI-stall 2/3; stream 403s persist separately. Stop-delivery rounds eclipseauditb91ea3de458f (218 s) and eclipseaudit34138beb6a92 (281 s, cleanup complete): Stop POST completes every server layer in ~409 ms and the backend reaches stopped, but the browser observes only the HTTP 200 status while the body never arrives, so the fetch never completes and the UI stays on Stop with no alert - first failing stage is response-body delivery after headers. The disposable ingress access log never materialized (override did not take effect; merge and nginx syntax verified, runtime mount not proven). All temp code removed and verified. Pause/Resume, Live, and the 503 Start retest remain untested. Earlier: on 2026-11-02 it stopped in its **agents** phase, before the chat, files, models, outbox and desktop phases: resuming a new agent returned 503 (`service_unavailable`) and the live view never reached "Live". The cause was not found and was not traced to TASK-031/032 (the same phase passed five times on 2026-11-01, before TASK-029-035 and the checkpoint/History changes landed). Also confirm that the app image builds (`docker compose build app` failed on `scripts/mock-vendor` type errors at the time). Until this passes, the History phase added for TASK-031 has only run in a trimmed copy of the suite (setup, then History), not inside the full run.

- [ ] 2026-11-04 verified recovery: pricing zero-offset (GMT/GMT+00:00/GMT-00:00 mocked, invalid rejected) and stream auth (graphics running + browser enum, legacy 5-field denied, browser-stopped viewable) pass locally (costs 10/10, live-view 18/18, agents 19/19) and in container; disposable e2e 423s cleanup complete shows RFB frames flowing with no invalid_timezone on Node 24.22.2, but Stop-to-stopped still NOT observed (Start timeout 60s). Live app/desktop rebuild pending.
## Owner account

- [x] First visit opens setup; owner account is created with email + Eclipse Crew password
- [x] After setup, `/setup` returns 404 and no second account can be created
- [x] Owner can log in; wrong email or password shows an error
- [x] Repeated failed logins are rate-limited and temporarily locked out
- [x] Authentication rate-limit slots are reserved synchronously; concurrent admissions cannot exceed five, failures do not double-count, and success/expiry reset the bucket.
- [x] Logged-out users cannot open any page, API route, SSE stream or the desktop stream
- [x] Change password requires the current password and signs out other sessions while keeping the current one (two real browsers; run `fa384f27-e199-473b-9390-f26ed549efc0`)
- [x] Change email requires the current password, normalizes the login and updates the visible form immediately
- [x] "Sign out everywhere" ends all other sessions and keeps the current browser signed in
- [x] Account routes deny wrong Origin/CSRF, unknown fields, oversized bodies and repeated bad passwords; expired/unrelated sessions are hidden; forced revocation failure rolls back both password and sessions (real browser and database run `fa384f27-e199-473b-9390-f26ed549efc0`)
- [x] `npm run reset-password -- --login <email>` reads private stdin, resets that account's password and atomically revokes only its sessions; other accounts keep working (fresh disposable database verified)
- [x] Migration 0039 drops the owner singleton; the history check expects the index only for counts 3–39, and fresh + legacy-upgrade provisioning passes
- [x] Forged/expired/revoked sessions, owner metadata overrides and invalid session-bound CSRF fail before desktop dispatch (behavioral auth tests)
- [x] Changing X-Forwarded-For cannot evade the per-login lockout; unknown emails take a dummy argon2 verify
- [x] Password is stored as an argon2id hash; session cookie is HttpOnly and SameSite
- [x] TASK-092 multi-account (`npm run test:accounts` 8/8): three CLI-created accounts, duplicate login refused; each authenticates, wrong passwords and unknown emails refused alike; five failures lock one login while the others keep signing in; one account's agents, chats, runs, receipts and memory are refused to another (403/404) and missing from its lists; setup 404s while accounts exist; scheduler, memory tidy and check-ins tick all three; the mirror writes one `USER.md` per account and claims the legacy file once

## Workspace shell (TASK-018)

### 2026-11-03 UI reference alignment follow-up (`prompts/2026-11-03-ui-reference-alignment.md`)

These supersede older width-based/right-panel-tab expectations above while their historical evidence stays recorded.

- [ ] Shared app shell: sidebar navigation (Agents, Crew, Mission Control, Evidence, Models, Connections, Schedules, Security), agent list, "Self-hosted · Secure workspace" footer, header search (Ctrl K) and owner chip (links to Profile) render on `/`, `/mission-control`, `/security`, `/crew`, `/schedules`, `/profile` and every settings page at 1280/1440 px.
- [ ] Workspace center: agent heading (avatar, name, role, status chip) with central Chat/Settings/Tools/Routines/History/Memory tabs; Tools/Routines show honest empty states linking to Connections/Schedules; right column shows the single live stream plus Current activity.
- [ ] Chat renders ordinary messages as unboxed rows (avatar, name, time) and keeps action content carded; composer is the compact single-row input with paperclip and send icon.
- [ ] `?panel=` deep links map onto the central tabs (history continue link opens the History tab with the rewind dialog).
- [ ] Screenshots at 1440/1280/768/375 px compared against references 02, 05, 39, 40, 41, 43 for every mapped surface (docs/UI_REFERENCE_MAP.md); remaining per-surface differences recorded.
- [ ] `npm run test:ui-reference` structural checks pass; login (24) and setup (21) match their reference composition.


- [ ] Nov 3 UI follow-up: verify the desktop app header keeps Eclipse Crew, Security and Mission Control clear of pane headings; pane headers align, the resize divider is 1 px with a 24 px pointer target, and all six panel tabs fit without scrollbars at 375/380 px. Check slim dark scrollbars on overflowing panels and keyboard resizing at 1280/1440 px.

- [x] Real browser at 1280/1440 px shows the 260 px agent pane, flexible chat and 380 px–50% right panel; pointer and keyboard resizing stay in bounds, including after soft navigation
- [x] All six right-panel tabs fit at 380 and 375 px, navigate by Arrow/Home/End, control the existing panel, and expose visible focus
- [x] Tablet keeps a 56 px agent rail and opens accessible agent/panel sheets with trapped focus, Escape/close, and focus return; selecting an agent opens its live panel
- [x] Mobile switches one Agents/Chat/Panel view at a time through the bottom bar with no page overflow; selecting an agent opens its panel
- [x] Invalid agent selection leaves the mobile Agents pane or tablet Agents sheet visible with its error
- [x] Resizing the panel does not reconnect the live desktop; mobile/tablet agent selection opens exactly one stream (run `ee5c00e4-58c8-4ad6-8574-3220e8b242ed`, screenshots in the same evidence directory, cleanup complete)

## Agent management (TASK-019)

- [x] Real browser at 1440/375 px creates two agents with name, role, persona, default-deny permissions and daily/monthly budgets; edits persist after reload and a blank persona receives an editable role-based default
- [ ] A new agent and each new crew member show a random avatar with Shuffle ("Avatar N of 12"); the kept avatar persists after reload in the agent list, center heading, chat rows and expanded desktop view
- [ ] In agent Settings, Shuffle shows "not saved yet" with Undo and Save avatar beside it; Save avatar persists the new avatar after reload. Avatars load once and stay put across navigation (signed-in `/avatars/voxel/*.svg` answers `private, max-age=31536000, immutable`); the Profile page header shows the owner avatar
- [ ] ADR-036 create form: only Name and Role are required; Instructions and Persona are optional; Advanced (closed by default) holds budgets (blank = $5/$50), Websites (Any public website by default, or Only these sites), Tools, Actions and Memory. Creating with just a name and role works, the saved agent shows the role-based expert instructions, and an error inside Advanced opens it. The crew form has the same optional fields under "More options"
- [ ] ADR-036 websites: a new agent with Any public website reaches a public site; every agent is still refused `127.0.0.1`, `10.x`, `169.254.169.254` and other internal addresses; switching to Only these sites with a list blocks other sites; existing agents keep their list after migration 0037
- [ ] ADR-036 handoff: a standard agent is never offered handoff (`not_in_crew` if forced); crewmates hand off only inside their crew; the Crew handoff card shows only on crew agents with Turn on/Turn off, and owner `@Name` still reaches any agent. The sidebar groups agents under each crew name, then "Standard agents"
- [ ] Memory tab shows PERSONA.md (editable, may be empty); Profile has Sign out (this browser) and Sign out everywhere (all browsers); the notification toast is a dark card with a neutral border
- [ ] Full-screen desktop shows the Start/Stop desktop and browser controls (side panel at ≥1024 px, under the screen below that); during takeover a double-click on a desktop folder opens it
- [x] Focus-trapped create/delete dialogs, modal focus return, mobile no-overflow, duplicate-name confirmation and explicit backup acknowledgement work by keyboard
- [x] Pause stops only the selected desktop and closes its live stream; resume restores the same agent while the peer desktop remains available
- [x] Delete removes the owner-scoped agent/policy rows, Linux account, registry identity, profile, home and Downloads while the peer home survives; registry-only and missing agents are denied
- [x] Create requires CSRF, rejects owner overrides, and browser setup/layout plus the existing live noVNC/takeover checks remain green (run `3e1696fa-fc34-4429-9833-aefc708e637c`, cleanup complete)
- [x] Lifecycle hardening: pause/resume/delete serialize under an owner-scoped row lock and require final DB writes; process-scan errors fail closed; registry writes retry after failure; real routes deny wrong Origin/CSRF/cross-owner/confirmation; per-field blur/submit errors focus the first invalid field; altered agent/policy constraints fail preflight

## Agents and isolation

- [x] Owner can create, edit, pause and delete an agent (name, role, persona, permissions, budget)
- [x] Each agent gets its own Linux user, `700` home, screen and Chromium profile (TASK-011/012 local administration verified; TASK-019 product CRUD verified)
- [x] Agent A cannot read Agent B's files, browser profile or cookies (TASK-011/012 files and profile denials; run `7b47dde4-ffbe-476e-9a66-05b9307ef705` adds: each agent's window shows only its own persistent and session cookie, and the peer's `Cookies`/`Login Data` paths return EACCES; TASK-048 run `2d73f472-1af7-4f0d-9c72-4dd7a0e0ab25` extends this in both directions: peer home/Downloads/`.system` and checkpoint paths denied, `/proc` environ/mem/maps/fd/cwd/root return EACCES, no readable command line or environment carries a secret, `kill`/SIGTERM/ptrace/`process_vm_readv` return EPERM, peer `/tmp` runtime and X lock/socket cannot be listed, opened, unlinked or renamed, and a peer-created display lock refuses start without being removed)
- [ ] Agent A cannot read Agent B's saved credentials: no credential store exists yet; test it when one is built (TASK-048 recorded this as not testable; TASK-070)
- [x] Agents have no sudo and cannot read the database, `.env` or host folders (run `7b47dde4-ffbe-476e-9a66-05b9307ef705`, both agent users: `sudo` not installed and `su` refused, no secret-like environment variables, `/proc/1/environ` unreadable, a real Postgres in the stack unreachable by IP and DNS, no outbound internet, loopback control works, no `.env*` file in the desktop filesystem, only the `/workspace` volume mounted; TASK-048 run `2d73f472-1af7-4f0d-9c72-4dd7a0e0ab25` re-runs the boundary with two live agents: no direct public, Docker-gateway or egress-proxy-IP egress, and the proxy is unreachable by name from the desktop network)
- [x] Compose posture: only `ingress` publishes `127.0.0.1:3000`; no privileged/host-network/Docker-socket/`.env` mounts; desktop mounts only `workspace`; secrets stay in their owning services; `app` drops all capabilities and sets no-new-privileges (`npm run test:posture`, including negative fixture configs and live non-root identities)
- Known limit (TASK-048): shared desktop loopback is authenticated, not network-isolated until TASK-071. A peer's x11vnc is reachable to the RFB handshake but refuses an empty password, and the controller/file listeners answer `403 source_denied`; `/proc/*/cmdline` and process names are visible to peers. Per-agent egress-proxy tokens cannot be tested until TASK-045.
- Known issue (TASK-048): a peer-created display lock refuses the start and is retained, but the refusal is reported as `session_cleanup_failed` instead of `display_conflict`; fixing the error masking is outside TASK-048.
- [x] Logins stored as persistent cookies persist in an agent's browser profile across session restart and container recreation (same run)
- [x] Logins stored as session cookies (no expiry, the common case for real sites) also survive pause/resume, container recreation and a killed worker: the worker snapshots them to a private file and restores them after launch (run `ce7251bc-68b9-4a1e-a7f5-6119e5ef8252`: graceful stop/start, a cookie deleted before stop stays deleted, killed worker after the 30 s periodic save, container recreation, peer agent denied, snapshot mode 600 and exact contents; corrupt, oversized, symlinked and group-readable snapshots are ignored without blocking start; a killed display keeps the last saved cookies; `test:cookie-snapshot` 9/9 on Linux)
- Known limit: a crash loses at most the session-cookie changes made since the last 30 s save
- [x] Delete removes the agent's Linux user, profile, files and memory after a backup prompt
- [ ] Agent knows its persona, its permissions and the current date/time

## Chat and files

- [x] Replies render as the four card types: message, clarification, tool connection, routine (TASK-022 real browser plus escaped card rendering)
- [x] Invalid model output is rejected and never executed (TASK-022 schema and append-boundary checks)
- [x] Chat history persists per agent; background run results appear in the timeline (TASK-022 reload, polling, isolation and background-append checks)
- [x] Files can be attached by button, drag-and-drop and paste; they land in that agent's `inbox/` (browser run: all three paths; stored as the agent's own Linux user, mode 600, byte-identical for a 12 MB file through nginx and Next, no partial file left, the peer agent cannot read or list them; unit suites `test:inbox-writer`, `test:files-route`)
- [x] Files over the size limit (default 250 MB) are rejected (browser run with `MAX_UPLOAD_MB=16`: refused in the browser without a request, and 413 from the route when sent directly)
- [x] Denied paths: anonymous 401, wrong CSRF or Origin 403, paused agent 409, unowned agent 404, program or shell script renamed to `.txt` 415, path parts in a name dropped, leading-dot and reserved names refused
- [x] Files the agent writes to `outbox/` appear as file cards with Download and Open on the agent's desktop (browser run: one card per file with no duplicates over repeat polls; scripts, symlinks and unknown binaries are not carded; a real 12 MB browser download is byte-identical; attachment, sandbox and nosniff headers; Open shows the file in a new tab of the agent's own browser, confirmed in its tab list)
- [x] Open in the agent's real Chromium (run `712cabe0-4208-4820-b608-e4ea905f469c`, screenshots `open-*.png`): PNG, WebM and PDF open as a tab with no stray download and display (PDF in the built-in viewer); an H.264 MP4 opened a blank player, so MP4, MOV and MKV are download-only by design (card shows Download and no Open; the desktop refuses a direct Open)
- [x] Denied paths: anonymous 401, wrong CSRF 403, an inbox card, another agent's card or an unknown id 404, an archive or HTML cannot be opened (415), Open with a stopped desktop 409 `session_not_running`, a file changed after carding 409 `file_changed` with no bytes sent, a symlink swapped in for a carded file 404 (unit suites `test:outbox-reader`, `test:inbox-writer`, `test:files-route`)
- [x] TASK-082 document search: a PDF page-2 term returns page 2 with a usable read offset; stop-word-only and absent terms return `no_match` and the run continues; xlsx sheet names/cells and pptx slide text are found with their sheet/slide numbers; windows are at most 20,000 characters; images return `unsupported_type` (`test:doc-search` 7, `test:agent-files` 12 + 1 skipped without unzip, `test:agent-step-loop` 70)
- [x] TASK-082 proof and bounds: search results are `document`-tagged and only the newest two stay in request; receipts keep name, query length and hit count, never text; replay refuses `search_document`; checkpoints accept `hits`; the index cache is reused for an unchanged file, rebuilt after a change, capped at 20 files, and never listed or delivered (`test:receipts` 23, `test:replay` 35, `test:checkpoints` 9). Denied paths: a query over 200 characters or with control characters, an unknown field, a path in the name and `files/index` over HTTP are refused before any launch (`test:agent-files` route test; `test:inbox-writer`/`test:files-route` baseline)
- [ ] TASK-082 live browser check: attach a 100+ page PDF, ask about a clause deep inside it, confirm the answer cites a page and History shows "Searched document"; attach `.xlsx` and `.pptx` and ask for a named sheet value and slide 3. Owner-run after a desktop image rebuild (not yet run)
- [x] TASK-084 extract/value reuse: the value is saved only when the page shows the exact text, `{{name}}` types it, an unknown or branch-carried name is invalid, and a canary or out-of-task host in a value is refused before saving (`test:agent-step-loop` 82/82, `test:receipts` 24/24)
- [x] TASK-084 navigate/select: navigate opens an allowed `http(s)` page and refuses another host (schema refuses `javascript:`, `file:`, `data:` and credentials); select grounds the dropdown and chooses the option; extract/navigate/select add no permission name and are default-deny through `click`/`type` (`test:agent-step-loop`, `test:desktop-controller` 15/15)
- [x] TASK-084 proof and bounds: receipts keep `extract{name,chars}`, `navigate{host}`, `select{target,option_chars}` and `type.values` (names only), never the value, host path or option text; checkpoints keep value names only; replay refuses the three kinds; snapshot results carry `frame`, `shadow` and `paymentFrames` (`test:receipts`, `test:checkpoints` 10/10, `test:replay` 35/35, `test:page-snapshot` 3 + 1 skipped)
- [x] TASK-084 real-browser fixture pass 2026-11-03: all 7 spike fixtures (open-shadow/frames/cross-site/sensitive/payment/obstruction/heavy) listed expected controls and omitted sensitive/covered ones with the production scanner inside the live desktop image (`ECLIPSE_PAGE_SNAPSHOT=1`, headed Chromium on an isolated :99 Xvfb, test run as `nobody`; `test:page-snapshot` 4/4). Fixtures staged under a disposable /tmp path and removed afterwards with the display; no agent screen, home or volume touched.
- [ ] Live owner tasks: HN headline into a mock note; click a field inside an iframe form. Still needs a real owner session.

- [x] TASK-083 conversation: the last 10 messages from 24 hours, each cut to 1,500 and 6,000 total, keep the newest; the current message is excluded; owner text is `user`, agent replies `agent`, other cards become one code line; a clarification and its answer reach the next run; routines get none and a branch uses messages before its source run (`test:conversation` 3, `test:chat-run` wiring).
- [x] TASK-083 scope: a host or email in earlier owner text is in scope; one that appears only in an agent reply is still refused (`test:agent-scope` 9).
- [x] TASK-083 limits: 60 steps, 30 minutes and 400,000 weighted tokens (uncached input + output + a tenth of cached); a 90 % cached 60-step run is not stopped early; shell agents keep 1.5M/60 min; heal's 8 is respected (`test:agent-step-loop` 97).
- [x] TASK-083 live route/card: owner-scoped, no-store, null when idle, newest 20 compact steps and cost when running, another owner is 404; the card polls 2 s while active, shows elapsed time/cost, Cancel posts the existing cancel route, and the live card is never stored (`test:live-run` 2; route/UI wiring checked; browser pass pending).
- [ ] TASK-083 live browser check at 1440/375: ask a page question, then a follow-up using "it"; watch the live card steps/cost, press Cancel, and confirm the reply card replaces it. Needs the owner model key.

## Desktop image foundation

- [x] TASK-010 offline guards reject host mounts/ports, credentials, root/capability changes and mismatched image identities; dependency/sandbox constraints are checked.
- [x] TASK-010: approved package lock verifies 445 archives / 250231110 bytes before offline installation; pinned Node/Chromium image builds and every required tool executes. Earlier snapshot outage remains historical. TASK-087 adds venv/pip, ripgrep, jq, patch, procps, zip and file to the same locked closure; `check-tools` runs each version.
- [x] TASK-010: run 0d69e5bc-7966-4ef3-8e5f-40035b2e00e0 verifies non-root Xauthority/Openbox, accepted/rejected VNC authentication, noVNC WebSocket, 1024x768 PNG and three-frame video; cleanup complete.
- [x] TASK-010: run c66f0dda-e890-428b-8f58-a1df20c978fa passes genuine Playwright and xdotool clicks in graphical Chromium; chrome://sandbox reports namespace/PID/network and Seccomp-BPF active. Parent has zero capabilities/no-new-privileges and ordinary chroot remains denied.
- [x] TASK-010: desktop Compose health and runtime isolation settings pass; both five-service http-security tests pass after the package and ADR-025 sandbox revisions.
- Fixed 2026-11-03: `npm run test:http-security`'s fresh-database stack returned 500 for the authenticated home page; the app role lacked `SELECT` on `teach_recordings` (`42501`) because `scripts/db-migrate.mjs` never granted it (provision-only parity gap also covered `memory_review_state`). `db-migrate.mjs` now mirrors `db/provision.sql` for both tables; grant sets verified identical. Independent of TASK-048; the app's cap-drop/no-new-privileges posture does not change the result.

## Persistent agent identities (TASK-011)

- [x] Run d778a3ca-9d63-4786-b1ae-5609581324f0: real distinct NSS identities, UID/GID 20000+, mode-700 home/inbox/outbox/work/profile/Downloads; idempotent owner-scoped creation and actual owner CLI inspection.
- [x] Both agents have zero effective/permitted/inheritable/ambient/bounding capabilities, no supplementary groups, no-new-privileges and no sudo; attempts to set UID 0 or read/write peer files, registry and hidden backing storage fail.
- [x] Downloads direct execution returns EACCES while an identical work executable succeeds; descendants cannot mount even inside a new user namespace. Changed Downloads aliases are rejected.
- [x] Reduced PID 1 loses SYS_ADMIN including bounding; inherited filter is present. Reduced administrator mount and x32 syscall probes are denied on x86-64 (the aarch64 path uses its own mount number and has no x32 step; native run pending). Read-only root, no host mounts, secrets or published desktop ports remain checked.
- [x] Concurrent duplicate creation returns one identity; malformed registry, owner mismatch, invalid paths and stale lock stop without overwriting data. Container recreation preserves UID/NSS mappings, private markers/profile fixtures and Downloads noexec; unrelated volume data survives. Disposable cleanup completes.
- [x] TASK-011 regression: test:desktop-image passes all 6 tests, including graphical sandbox/input/VNC/capture (run 1723128b-490b-4826-ab2d-adb07a7c67af). Both five-service test:http-security checks pass. These are Docker Desktop Windows results; other hosts remain unverified. TASK-012 now verifies the per-agent screen/session layer.

## Per-agent graphical sessions (TASK-012)

- [x] Run b6cbc929-f929-456f-b454-bdef8df04461: two simultaneous UID-isolated Xvfb/Openbox/headed Chromium sessions, independent real windows, synthetic persistent cookies/local storage, idempotent start/status/stop and actual owner CLI.
- [x] Missing/peer Xauthority is rejected; profiles, supervisor socket and peer worker IPC descriptors deny access. Workers/outer browsers have all capability sets zero and no-new-privileges. Inner Chromium helpers have only verified private single-UID mappings and namespace-local capabilities; sandbox status confirms namespace/PID/network and Seccomp-BPF active.
- [x] No X11 or CDP TCP listener/published desktop port; browser control uses private pipes. Conflicting displays and live profile locks are refused without deleting the conflicting artifacts.
- [x] Graceful stop leaves no live agent processes, preserves its peer and reopens saved profile state. Xvfb crash and SIGKILL of the worker trigger session-only cleanup; fixed same-UID fallback removes verified descendants and private runtime files without CAP_KILL.
- [x] Container recreation leaves sessions stopped until explicitly started; synthetic cookies/local storage and unrelated volume data survive. Test cleanup is complete. Real account login/credential handling and the app/controller/streaming/takeover are still separate checks.

- [x] TASK-012 regressions: test:agent-users 4/4 (run 841b4734-699d-4aae-a883-d68e909fa09e), test:desktop-image 6/6 (run bfaa3174-68d6-4938-9816-08555b5fef24), five-service test:http-security 2/2 including production build; lint/typecheck/diff checks pass. Re-verified 2026-11-03 2/2 after the fs.read workaround (direct pre-build + `--no-build`), the `teach_recordings`/`memory_review_state` migrate-grant fix, and the cap-drop-aware legacy fixture (unprivileged file plant + minimal-cap chown helper).

## Independent desktop, browser and headless work (2026-11-03)

- [x] `session-sandbox` starts the agent worker with no Xvfb, Chromium or VNC; `session-status` reports `sandbox=running, graphics=stopped, browser=stopped`. Real headless worker: `shell.run` returns its output, `capture.screenshot` and `file.open` return `visual_unavailable`, and no agent process is left after close (disposable Linux run).
- [x] Closing the managed Chromium leaves `state=running`, `sandbox=running`, `graphics=running`, `browser=stopped`, and the VNC stream/peer stay up. `session-browser-start` restores `browser=running` with the same generation and profile; repeated close/start does not orphan processes (disposable Linux run).
- [x] `session-desktop-stop` stops graphics and browser but keeps `sandbox=running`; the worker remains for shell/files and no Xvfb/Chromium is left. `session-desktop-start` restores graphics and browser. A peer session is unaffected throughout (disposable Linux run).
- [x] `npm run test:agent-sessions` live 6/6 includes the browser-close/restart and graphics-crash regressions, profile/cookie persistence, peer isolation, no X11/CDP TCP listener and real sandbox checks.
- [x] Offline no-screen: `test:agent-step-loop` 75/75 covers a shell run with no screenshot/after hash, a stopped-desktop click that acquires graphics and re-grounds, `start_desktop` success and denial, and graphics closing mid-run continuing headlessly.
- [x] Lifecycle seam: `test:desktop-lifecycle` 6/6 and `test:desktop-controller` 14/14 cover browser-close independence, explicit browser restart, graphics stop, sandbox-only failure, strict lifecycle schema/result validation and authenticated controller dispatch.
- [x] Route/security: the desktop lifecycle GET/POST require owner auth; POST requires exact Origin/CSRF and a bounded action body. Offline route tests cover unauthenticated denial and fixed error mapping (`agent_paused`, `crew_stopped`, `security_stopped`, `budget_exhausted` → 409; desktop/browser failures → 503).
- [ ] Stop/Start update the UI: after a successful action the button frees at once and the state settles within 20 s, or an alert says the desktop didn't confirm; a stalled request times out (75 s action, 10 s refresh) with an alert, never a stuck button. Later Stop→Start→Stop success is reported in `docs/MEMORY.md`; retain pending until the complete check is recorded.
- [ ] Phones/tablets open exactly one live stream, only once the real viewport is known (no stream from the guessed 1440 px first render). Later phone/tablet success is reported; retain pending until the run evidence is recorded.
- [ ] Browser UI at 1440/375: separate Desktop/Browser labels, Start/Stop controls, browser-closed banner, desktop-stopped empty state, chat remains usable, and keyboard/mobile access (needs the owner login; pausing/resuming the agent remains a separate control).
- [ ] Live denied paths for the owner routes: paused agent, security stop, stopped crew, exhausted budget, cross-owner and CSRF-invalid requests leave safety state unchanged (offline mapping covered; live exercise pending).

## Desktop polish (TASK-077)

- [x] Generated agent-local tint2 dock (Browser, Files, Terminal, clock) and pcmanfm desktop with Home, Trash, Downloads, outbox and work; File System/mounts hidden; automount/autorun off; fixed launchers and private session D-Bus.
- [x] `npm run test:agent-sessions` live 6/6: two agents have independent dock/desktop/bus; Browser focus keeps one managed process and tabs; Files opens a window; xterm is the agent UID in `work` with zero capabilities and its private namespace; stop/crash leaves no orphans.
- [x] `npm run test:desktop-polish` 4/4 covers generated config, path/uid denials, launcher identity checks and the image/lock pins.
- [ ] Wallpaper: owner asset not supplied yet; verify the actual image on both sessions without covering the dock or icons. TASK-077 stays unticked until then.

## Agent hearing (TASK-079)

- [x] Disposable Linux run: one private PulseAudio null sink per agent; a 440/660 Hz marker reaches only its own monitor (agent RMS ~2.7k), a peer capture at the same time stays at the ~314 noise floor, and peer runtime/cookie reads return `EACCES`.
- [x] Controller path: `audio.capture{seconds:3}` through the manager and app-network source returns HTTP 200 `audio/wav`, ~2.9 s and non-silent samples; the capture-specific channel timeout applies; `audio.capture` is refused without a browser.
- [x] `npm run test:agent-audio` 5/5 covers the 1-30 s schema, canonical WAV/chunk/size checks, path/uid denials, opt-in action, replay refusal and wiring; `test:audio-transcribe` covers Meta-only pricing, budget, one pre-dispatch charge, silence and no-retry uncertainty.
- [ ] Paid live check: transcribe one non-sensitive known spoken fixture through Voice Transcribe with the owner's Meta key; verify text, one audio charge and cleanup. TASK-079 stays unticked until then.

## Crash-safe runs (TASK-085 core)

- [x] Migration 0031 adds `runs.heartbeat_at`, `runs.cancel_requested_at`, `runs_heartbeat_idx`, `run_meta.handoff_of` and the expanded trigger/audit checks; applied to the live database after a backup. Migrations 0032 (crew reports/starter crew) and 0033 (`run_meta.parent_run_id`, `subagent` trigger) also applied live after a verified backup, followed by a full `db:provision` pass.
- [x] `test:run-sweeper` 3/3: a heartbeat updates the row, stops on a missing (already sealed) row, reports a database cancel, ignores database errors, and `sealExisting` derives count/head/summed usage and signs once.
- [x] `test:jobs` 16/16: heartbeat younger than 90 s is Running, an old heartbeat is Not sealed, rows without a heartbeat keep the 15-minute rule, and the Interrupted label maps correctly.
- [ ] Live restart: start a long run, restart `app`, confirm the run shows Interrupted within four minutes, export verifies, and Continue works. Live app image rebuilt from the current tree and recreated 2026-11-03 (`main-app` `c5638cb…`, CSP nonce headers verified on `/login`). Still needs a saved Main model (no provider/key is configured; paid calls need explicit authorization).
- [x] Handoff, @mentions and Continue are built (2026-11-03): the new permission is on for new agents and has one explicit bulk enable for existing ones; `handoff{agent,note}` copies the stored owner message, tags the note `agent`, enforces two hops/no-return/self/paused/busy, seals `handed_off`, writes `handoff_of` to the receiver header and audits both sides. A leading `@Name ` routes and unknown names send nothing; the interrupted card and History open the existing rewind dialog at the last complete checkpoint. `test:handoff` 4/4.
- [ ] Live handoff and mention acceptance with two real agents (web search, then `@Scout check my calendar`) and cross-process Cancel ≤20 s remains owner/model-gated.

## Screenless helpers (TASK-076)

- [x] Migration 0033 adds `run_meta.parent_run_id` and the `subagent` trigger. `test:subagents` 6/6 covers the 20% step/time/token slices, `no_tools`/`tool_not_granted`/`duplicate_task`/`subagent_limit`/`nested_spawn` refusals, concurrent helpers, data-only results, cancel cascading to every helper, and finish waiting then stopping.
- [x] Helpers never receive `ask_owner`, desktop, memory, handoff or nested spawn; risky calls use the parent identity with a `Helper N` card; each helper has its own signed run with `parent_run`/`parent_step`, heartbeat and checkpoint; Jobs counts helpers and History shows the tree.
- [ ] Live behavior with a real model: "What's my latest email?" and "Download the invoice from the vendor portal" spawn no helper; the parallel form/lookup task spawns helpers. Needs a saved Main model and paid authorization.

## Chrome for Testing (TASK-078)

- [x] Spike run: the measured Chrome for Testing 156.0.8078.80 archive (201329937 bytes / SHA-256 b711c720…) launches under the production read-only root, zero capabilities, seccomp and `--network none`; namespace/PID/network and Seccomp-BPF are active; real H.264+AAC MP4 frames and audio decode; page-structure grounding finds Save; Playwright and xdotool clicks work; screenshot, multiple tabs, download, session-cookie restart and two isolated profiles pass.
- [x] `npm run test:chrome-for-testing` 4/4 covers the per-CPU lock rows, exact byte/SHA validation, downloader rejection paths, image wiring and the no-publish check. `npm run spike:chrome-for-testing` writes the sanitized report under `test-results/chrome-for-testing/`.
- [x] Production image builds with the pinned archive; `check-tools` reports `chromium 156.0.8078.80`; the existing desktop smoke and two-agent session suites pass (see the run logs).
- [x] ARM64 row: `browser-build.lock.json.browsers.arm64` pins the same version, 200722708 bytes, SHA-256 1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724; the downloaded ELF is aarch64 and the archive root is normalized to `chrome-linux64`. This is artifact evidence, not a native run; `test:desktop-architectures` checks the target/pin/refusal paths.

## Native ARM64 (TASK-066)

- [x] Pinned inputs resolved to ARM: `ubuntu:24.04@sha256:fe81560…` → linux/arm64 `sha256:19cad596…`; `node:24-alpine@sha256:8a32c8c…` → linux/arm64 `sha256:e6439844…`. Artifacts measured locally (not a native run): Node v24.22.2 `linux-arm64` 30968168 bytes / `eb187837…` matches the signed `SHASUMS256.txt` (key fingerprint 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356); CfT 156.0.8078.80 `linux-arm64` 200722708 bytes / `1f496a82…`, ELF aarch64.
- [x] `npm run test:desktop-architectures` covers the 18 names/numbers on both ABIs against Linux v6.8 fixtures, foreign-ABI kill, x32-only-on-x86, per-CPU lock/host/ABI refusals, resolver parsing, browser target/normalization and preflight refusal. The resolver's amd64 pipeline produced 445 entries / 250231110 bytes with the same package names as the pinned lock.
- [x] amd64 pins unchanged: manifest `6d0b4072…`, 445 / 250231110; Node/CFT amd64 hashes unchanged. Native Oracle resolution (2026-11-04, host/daemon aarch64, kernel 6.17.0-1011-oracle) produced `ubuntu-packages.arm64.lock.json`: 442 archives / 242101668 bytes, SHA-256 `acc7f512e07138ff80fb3fb68be4021e7002ed5f1f9b8494014889d6593bc0e2`. Signed apt metadata supplies package hashes; the downloader independently verified all 442 archives in a disposable native container. `procps` is already present in the pinned ARM Ubuntu base. Wrong-CPU and tampered-manifest denials pass.
- [x] Native Oracle image build and standalone smoke (2026-11-04): `eclipse-arm-verify:20261104`, image ID `sha256:3b42927fd084db759fd341c7b376882615c502001301d8c1b9a08bb46461e213`, image/marker `arm64`, no QEMU registered. Tool inventory passed (Node 24.22.2, Playwright 1.64.1, CfT 156.0.8078.80, Openbox, file manager, dock, audio/development tools). All five smoke checks passed: nonroot tools, authenticated Xvfb/Openbox, authenticated VNC/noVNC WebSocket, PNG/video capture, sandboxed Chrome/Playwright/xdotool; namespace and Seccomp-BPF true. The exact owner wallpaper is in the image (SHA-256 `b1da503eeb3da066e5664e523a5e40b30b808fe27d4c1cddb518cfd1fe8472a2`). Native Node/Undici crashed during Ubuntu downloads; build-time HTTPS streaming plus bounded socket retries resolved it without relaxing integrity checks. Evidence: `data/acceptance/task-066/2026-11-04-flQrIpV8/`. Verification containers removed; no app deployed or public port opened. Local architecture 8/8, focused package/security checks 6/6, focused ESLint and syntax checks passed.
- [ ] Native Oracle (`node scripts/acceptance/arm64.mjs --preflight`): host/daemon arm64, then `resolve-package-lock.mjs --arch arm64`, review the lock, build/start/ps, `check-tools` shows arm64 and every tool version, only `127.0.0.1:3000` published.
- [ ] Native filter/users/isolation/sessions: 18 safe-argument probes EPERM, `unshare --user --net` works, two-agent peer/loopback/audio/file denials, cookies across restart.
- [ ] Native browser: `chrome://sandbox` namespace/PID/network/Seccomp-BPF, H.264/AAC fixture, structure-grounded clicks, no testing bar, smoke passes.
- [ ] Native app/E2E: argon2 positive/negative in the ARM app image, fresh DB roles/migrations, auth, stream/takeover, signed export/offline verify, SSH tunnel `ssh -L 3000:127.0.0.1:3000` with no public Oracle port.
- [ ] Apple Silicon through its own native ARM64 Linux VM: independent run, not inferred from Oracle.
- [x] amd64 regression: lint/typecheck/build pass; `test:agent-users` 4/4, `test:desktop-image` 6/6 incl. Compose smoke, `test:agent-isolation` 1/1, `test:agent-sessions` 6/6; direct image build, tool inventory, seccomp probe and marker refusals pass. `test:db-roles` full run and `test:auth-desktop-e2e` in progress after the fs.read workaround (pre-build images directly with unique tags, `compose up --no-build`; engine policy unchanged, documented in `.github/README.md`).

## Live desktop and takeover

### 2026-11-03 takeover input policy (supersedes width-based "view-only on phones"; older evidence stays recorded)

- [ ] `npm run test:takeover-eligibility` 8/8: trusted mouse + trusted non-composing keyboard required; touch/pen, synthetic, IME-composing, modifier-only, and mouse-only/keyboard-only never eligible; reset clears.
- [ ] Touch-only viewport (375 and 1280 px emulation): Take over shows "Connect a keyboard and mouse to take over"; remote input impossible; app navigation stays usable.
- [ ] Mouse-only, then keyboard-only, interaction each leave the stream view-only.
- [ ] Click Take over (mouse) then press Enter (keyboard) enables takeover at 1440, 1280 and 375 px; the two-step check forwards nothing to the desktop (no `/input` requests during the check).
- [ ] After takeover: clicks, drag, wheel, right-click, typing and paste forward; touch/pen pointer events are ignored; a touch long-press context menu never reaches the desktop.
- [ ] Loss paths: stream disconnect, page hide/resume and capability change reset evidence, block queued input and release the lease; a failed release keeps Hand back and the error visible.
- [ ] Resizing the panel or window never revokes eligibility, never reconnects the stream, and an active takeover stays active.

- [ ] Desktop view connects within 2 seconds (latency target requires measurement)
- [x] Real authenticated noVNC canvases show two distinct 1024×768 agent desktops (disposable browser run 25ac0609-146f-4109-accd-2f52119ff311)
- [x] Takeover acknowledgment waits for active work and prevents queued agent input/screenshots from dispatching; stale owner/generation/lease fail (behavioral manager tests)
- [x] Owner scaled pointer/text, handback and route-leave release work through the actual browser; remote text and resumed agent capture are verified
- [x] HTTP/WS controller requires service secret and exact app peer; missing/wrong secrets, spoofed source, stale generations and unknown agents fail
- [x] RFB view-only protocol rejects key/pointer/clipboard injection; private VNC challenge authentication and sanitized pixel transport pass synthetic TCP/WS tests
- [x] Revoked/replaced sessions close native streams within five seconds; silent peers and application shutdown release streams (behavioral bridge tests)
- [x] Real browser logout revokes HTTP and the live stream; real takeover blocks agent capture/input until release
- [x] Agent-directed typing/key input is denied on actual password/OTP controls, including inside single and nested closed shadow roots; ordinary focused text input still works (TASK-012 run 01331fe8-87b7-4535-b598-375fa9aec997)
- [x] Trusted owner takeover marker is manager-generated, rejected on browser input, and allows manual type/key input on a synthetic sensitive field; recording stays off until the owner presses Record (TASK-036).
- [x] Pinned noVNC package normalization preserves awaited feature detection and fails on changed bytes/version; real x11vnc true-colour flag 255 is accepted with view-only filtering retained
- [x] Interrupted session startup cannot deadlock supervisor shutdown; uncertain sessions can be explicitly stopped
- [ ] Agent stops at login walls, CAPTCHAs, OTPs and payment checks and asks the owner
- [x] Agent screenshot dispatch is blocked during takeover; teach Record now opts in separately (TASK-036 managed browser)
- [x] Full screen opens the expanded view inside the app window: the app header stays and the browser does not enter fullscreen (TASK-068; real browser at 1440 px, `document.fullscreenElement` stays null, workspace behind is inert)
- [x] Opening and closing Full screen does not reconnect the stream, and an active takeover stays active; Esc goes to the desktop during a takeover (same single WebSocket count before and after, Esc exits only without a takeover, Tab stays inside, focus returns to the Full screen button)
- [x] On phones (375 px) the expanded view is view-only (no Take over, no horizontal overflow, no reconnect)
- [x] Default Actions: the create form pre-fills the seven known actions (browser run), API creates without actions still have none, the stop text names the action and where to change it, and migration 0008 on a throwaway Postgres adds the file actions to non-empty lists only and is idempotent (`npm run test:actions-migration`); provisioning and upgrade tests pass with 9 migrations.
- [x] TASK-027 mocked: 4 routing unit tests and 4 loop tests pass (Fixed never escalates; Auto escalates after a failed or repeated turn; capped at 5; hard-model error falls back to Main and ends escalation; each step carries model, label and route); settings round trip and validation; browser: Routing defaults to Fixed, Auto persists after reload, key never returned; database upgrade tests pass with migration 0007.
- [ ] Every step shows the model that did it (data recorded by TASK-027; visible label needs TASK-031)

## Perception and proof receipts

- [ ] Model output is an intent `{action, target, expect}`, never raw coordinates
- [x] TASK-024 mocked: strict intent schema rejects coordinates, selectors and unknown fields; exactly one `next_step` call is accepted; two invalid or non-completed outputs in a row stop the run with nothing executed.
- [x] TASK-024 mocked: valid steps run in order through the guarded desktop port; one card per run; the model's `finish` is shown as its own unverified report; default-deny action allowlist, takeover (`takeover_active`), 20-step cap, 3x repeat stop, provider errors and cancellation all stop without further input.
- [x] TASK-026 mocked (`test:clock`, `test:agent-step-loop`): clock block in the §19 format, rounded to the minute, correct across zones and daylight saving; invalid owner timezone falls back to UTC; exactly one clock block, last in `instructions`, stable text before it identical across calls; `get_time` for the owner zone and another zone, unknown or hostile zones never echoed, no desktop call, no run step, repeat limit applies.
- [x] TASK-024 mocked: owner task is the only `user`-tagged content, screenshot is `web`, history is `agent`; typed text is never replayed; clock block follows the persona; one run per agent, other agents in parallel, lock released after a failed card post. 13 tests.
- [x] TASK-025 real Chromium (`test:agent-sessions`): the snapshot lists only visible, unobstructed controls; password, one-time-code and field values, off-screen, covered and iframe controls are left out; clicking the returned point hits the control at the default window position, after moving the window, and after scrolling.
- [x] TASK-025 mocked (`test:agent-grounding`, `test:agent-step-loop`): exact, partial, role-word, tie, weak and injection-named controls; no coordinates reach the model; the control list is `web`-tagged; the first miss gives one correction turn with visible names, a second miss or an unreadable page hands off with one card; the frames hint appears only when frames exist.
- [ ] TASK-024 live: a real model produces valid steps and a click lands on a grounded target. TASK-046 transport exists; authorized real-provider acceptance remains pending.
- [ ] Targets are found from page structure on normal websites (live run with a real model; not yet verified)
- [ ] With SAM on, targets are located and verified with SAM masks; with SAM off, receipts say "SAM off"
- [ ] Irreversible actions (send, delete, purchase, payment hand-off) ask when two methods don't agree
- [ ] Adding a model detects its capabilities (tool calling, vision, computer use)
- [ ] Every step writes a receipt (before/after hashes, target, method, confidence, result, cost, `prev_hash`). TASK-029: mocked step-loop tests (`test:receipts`, 23) and a real Postgres container pass; a live run with your saved model key is still to be done.
- [x] TASK-029: the chain, signature and seal are canonical, deterministic and match the RFC 8032 Ed25519 test vector; typed text, file contents and credentials never appear in a receipt; SAM off/on/unavailable is stated per receipt
- [x] TASK-029 (cannot): no signing key means no run (fixed card naming `npm run receipt-key`); a failed start or a failed receipt write stops the run with `receipt_error` and no further input; the app role cannot UPDATE or DELETE `steps` or DELETE `runs`; a seal rewritten through the app role fails verification; another owner's run exports as 404
- [x] `eclipse-crew verify run.json` passes on an untouched export (TASK-030: `test:verify-cli` 9 pass + 1 skipped symlink on Windows; `test:run-export-route` against a disposable Compose stack passes, including the `docker exec` stdin form, a symlink launcher and `key-id` inside the app container)
- [x] `verify` fails if any step is altered, removed or reordered (also swapped signature, other key under a pin, unsealed, changed header, wrong step count; unreadable or oversized input exits 2; a crafted file cannot print escape codes; a receipt edited in the real database is caught)
- [x] History shows before/after thumbnails and pass/fail per step (TASK-031: real Chromium on a signed run seeded through the production recorders, 1440 and 375 px; screenshots `data/spikes/audit-repairs/fec106dc-76fc-45e2-b985-fc7046afc5dd/task031-history-{1440,375}.png`)
- [x] TASK-031: the SAM outline appears only on the "after" image and only when SAM passed (scaled from the stored box); with SAM off the step says "Page structure (SAM off)" and has no outline; the outline is labelled a display annotation
- [x] TASK-031: "Chain verified" comes from re-checking the stored receipts on load; editing one stored receipt shows `receipt_hash_mismatch` at the right step; an open run shows "not sealed yet" (`test:history` against Postgres, and in the browser)
- [x] TASK-031 (cannot): the evidence route needs the owner session (401 otherwise); a hash that is not before/after evidence of that owner's run, an unknown run and a malformed hash are refused (404/400); served bytes re-hash to the signed receipt hash; the peer agent lists no runs; the app role cannot UPDATE or DELETE `step_evidence` (`db-roles`)
- [x] TASK-031: a stored receipt that cannot be read becomes a placeholder row; a missing screenshot shows "screenshot not stored"; a failing evidence store never stops a run (`test:history`, `test:agent-step-loop`)
- [ ] Evidence retention (32 days): step Download saves the PNG; Export run.json still verifies after its screenshots age out (purged steps show "expired" copy); Mission Control Runs warns at 80% of `ARTIFACTS_CAP_BYTES` and purges oldest early at 100% (receipts never purged)
- [ ] ≥ 95% of steps on the demo routine are verified

### TASK-028 verification acceptance

- [x] Mocked: closed expectation grammar; supported DOM failure cannot be overridden; bounded local polling; model fallback only when needed; SAM off makes zero SAM requests; unavailable and missing-confidence states remain explicit.
- [x] Mocked: independent target agreement before click/type/Enter; mismatch, changed target, unreadable page and missing focus stop before input; takeover during verification pauses without another action. No model coordinates or selectors execute.
- [x] Mocked: strict visual verdicts reject invalid/incomplete/safety-review output; source tags and clock included; 512-token caps, no retries; token usage includes verification. SAM decoder validates allocations, dimensions, actual masks and confidence.
- [x] Disposable Chromium (`test:agent-verification-desktop`): consecutive page.verify reads, exact visible controls, missing/covered/off-screen/sensitive/iframe exclusions, duplicate-name unknown, focused-control metadata without field values, and calibrated/repeated clicks after window movement/scroll. Evidence: `data/spikes/task-028/3ca5ba56-9a78-4982-83f7-2b7cafe195c1/result.json`; disposable resources cleaned.
- [x] Full desktop/session lifecycle regression (`test:agent-sessions`): 5/5, including page verification checks; evidence `data/spikes/task-012/17bf5160-809c-4360-b7a7-3af447db7399/result.json`, cleanup complete. Controller/takeover tests: 25/25. Mocked provider/runtime/settings/clock suites: 108/108. Existing SAM spike tests: 10/10.
- [ ] Real Main/SAM provider acceptance and end-to-end chat verification, including cost/latency on the demo routine (not run automatically; requires separately authorized usage).
- Receipt-specific SAM-off labels, signatures and persisted proof are TASK-029 (done; see above). Earlier TASK-024 unverified execution tests are superseded by the conservative TASK-028 gate and injected verification fixtures; pure chat summaries remain model reports.

## Teach from video

- [x] TASK-036 (managed browser) Take over → Record → do a task → Stop captures video, events, targets, before/after shots and narration. Disposable run `caf2116a449bfa36`: 59 frames, 4 accepted events, synthetic mic narration, ordinary takeover recorded zero events/bytes, and disconnect aborts. Privacy pauses covered password, OTP, CAPTCHA, iframe/shadow-root and unsupported-scheme surfaces. Native desktop/terminal capture is owner-deferred for v1.
- [x] TASK-036 (managed browser, cannot): stale leases, cross-owner IDs, arbitrary artifacts, oversized uploads, bad WAV/turns, duplicate sequences and encoder/storage failures fail closed with no raw capture retained. Fresh Postgres run `624d57b01c1fdf2f` passed 16 migrations, owner-only routes, cross-owner 404s, idempotent Stop, append-only audio ledger and discard cleanup; artifact symlink/hard-link cases pass in the disposable Linux container.
- [x] TASK-036 (managed browser) Passwords and OTPs are masked in the capture: sentinel text/pixels are absent from decoded video, shots, manifest/events, audio/transcript fixtures, API/error/log responses and encoder inputs across sensitive transitions. Exclusion from the generated skill is covered by TASK-037.
- [x] TASK-036 (live owner stack): rebuilt/recreated app+desktop, created one temporary owner-scoped session and agent, and recorded the mock invoice page through a real takeover lease. Stop returned `complete` with 1 event and 5.474 s active; the saved-recording list returned the capture, review returned 200, the 36,959-byte WebM artifact returned 200, and Discard emptied the list. Cleanup removed the agent, session, capture row, artifacts and vendor process. Narration stayed off (`narrationAllowed:false`) and ASR was not called because the live DB has no Meta provider with a stored key.
- [x] A draft `SKILL.md` is generated with steps, inputs and a check per step (TASK-037: structured model output, deterministic renderer, validation/route/retention tests; real-provider generation pending)
- [x] The skill shows how it was learned (TASK-037: "Learned from steps + screenshots"; video path pending)
- [x] After approval the skill enters later chat context and can be referenced by a routine confirmation (execution awaits TASK-039)
- [x] After approval the recording is deleted and one reference screenshot per step is kept (copy/cleanup invariants tested; live approval with a real capture pending)

## Rewind and branch

- [x] Rewinding to step N restores the agent's state and files at that step (`test:rewind`, real Postgres: changed/missing files written back, later files moved to `.rewound`, unchanged files kept)
- [x] TASK-032: a checkpoint is saved before the first step and after every receipt; state and file manifest are content-addressed blobs; an unchanged file is fetched and stored once across the run, a changed file gets a new blob (`test:checkpoints` against Postgres)
- [x] TASK-032: the stored state never holds typed text, screenshots, document contents, keys or tokens, and a state with unknown fields or over 256 KiB is refused on read (`test:checkpoints`)
- [x] TASK-032 (cannot): the desktop tool refuses `..`, absolute paths, symlinked files and directories, FIFOs, hard-linked and hidden files, wrong hashes and files over 4 MiB, and never reads a peer agent's home (`test:checkpoint-tools`, the real desktop image as root, and the real listener with two agents in `test:inbox-writer`)
- [x] TASK-032: a transient failure is retried once and the checkpoint stays complete; a persistent failure, a body that does not match its hash, a port without file support and a capture over the time bound each give a `partial` checkpoint with a fixed reason, the state is still saved, and the run continues; History shows "Can't rewind to this step"
- [x] TASK-032 (cannot): the app role cannot UPDATE or DELETE `checkpoints`; a checkpoint index cannot repeat in a run; provisioning rejects an altered `checkpoints` schema or an extra grant (`db-roles`)
- [x] A correction continues the run as a new branch without re-running earlier steps (`test:rewind`: saved history/documents and the correction reach the first model call, step numbers continue, new steps start at 1; no earlier desktop action is executed)
- [x] The original branch stays visible in History (`test:rewind`: the original export is byte-identical and still verifies; History lists the branch and the branch reads `branch_of`/`branch_at` from the signed header)
- [x] TASK-043 (cannot): a partial checkpoint, missing/tampered blob, unsealed or chain-failed run, another owner's run, a step above `step_count`, a paused agent, takeover, a missing model/key and a busy agent are refused with nothing written and no run; a mid-restore failure starts no run and a second request finishes the restore (`test:rewind`)
- [x] TASK-043 (cannot): the restore tool refuses `..`, absolute, hidden and odd paths, symlinked files/directories, hard links, wrong hashes, bodies over the limit and a non-UUID bucket; `aside` never overwrites (`test:checkpoint-restore` 10/10 in the rebuilt desktop image as root; the two authenticated listener routes are covered by `test:inbox-writer`)
- [x] TASK-043: an ordinary run header stays byte-identical; a branch export verifies offline and carries signed `branch_of`/`branch_at` (`test:rewind`)
- [ ] The UI states that external side effects (sent emails, orders) are not undone (text is in the rewind dialog; live browser check pending)
- [ ] TASK-043 live browser at 1440/375: seed a signed run, open the rewind dialog, create a branch on a real desktop, and verify both exports

## Routines and jobs

- [x] Scheduler startup failure logs that scheduled routines are paused without preventing app registration; normal startup and runtime/build guards remain intact (`tests/instrumentation.test.mjs`, 2 tests).
- [x] A routine created in chat shows a routine card; confirming saves it (TASK-038: live browser confirmation, reload persistence and duplicate-row check at 1440/375 px)
- [x] Skill-only routine records and confirmation responses accept zero steps; routines without a skill require steps, and all steps retain their length and count limits (`test:routines`).
- [x] Scheduled and Run Now executions pass canary, approvals, allowed hosts and security/scope hooks into the step loop, with the run ID on security stops (`test:scheduler`, mocked wiring; `test:agent-step-loop` covers denied paths).
- [ ] Once, daily, weekly, monthly, custom weekdays and cron schedules fire at the right local time
- [ ] Run Now starts it immediately with live step status
- [x] A duplicate scheduler tick does not run a routine twice (TASK-039: live pg-boss duplicate enqueue returned `false`; real second tick queued zero jobs; deterministic execution id + `SKIP LOCKED`)
- [x] One agent runs one job at a time; different agents run in parallel (TASK-039: queue `groupConcurrency: 1`, worker `localConcurrency: 4`, existing agent lock tests)
- [x] After the stack was down, missed runs follow the catch-up policy (run once / skip / run all) (TASK-039: policy matrix tests plus live run-once catch-up advanced `next_run_at`; live full-stack outage check pending)
- [ ] Second run of a verified routine with no site change makes no model calls ($0.00 model cost)
- [x] TASK-044: on a site-change mismatch the agent self-heals and proposes a diff (`test:heal`: scripted repair run with real signed receipts/Postgres; live mock-portal repair pending)
- [x] Self-heal repair preparation supplies the `heal` trigger and `Self-heal repair` label for Jobs metadata (`tests/heal-ports.test.mjs`: mocked production wiring).
- [x] TASK-044: approving the diff updates the saved replay; the next run uses it (`test:heal`: approval appends v2 and `getScript`/`listScripts` resolve it)
- [x] TASK-042 Part A: Jobs dashboard lists runs with status, agent, trigger, duration and cost (`test:jobs`: owner scope, all outcome filters, 24h/7d/30d/all ranges, agent filter, cost, keyset paging)
- [x] TASK-042 Part A: Run detail shows the step timeline, receipts, errors and retry history (`test:jobs`: summary, signed input, final output, delivered files, failed step codes, retry chain, existing timeline route)
- [x] Run now, Cancel, Retry and Pause/Resume work from the dashboard (Part A: Cancel, Retry for chat and routine Pause/Resume pass in `test:jobs`; Part B: Upcoming and Crew actions mount TASK-040's Run now with live execution status, a scheduled run retries through the routine queue with `retry_of`, and runs with no routine or replay/branch/heal triggers are refused; a live signed model/desktop step remains TASK-040's pending item)
- [x] TASK-039: pg-boss starts under the runtime role, duplicate enqueue is idempotent, and the worker settles jobs (`test:scheduler`; live app-role queue/idempotency/settlement pass)
- [x] TASK-040: Run Now is owner/CSRF/rate limited and returns a pollable execution (`test:scheduler`; live 401/403/404/202 and queued→retrying status pass)
- [ ] TASK-040: a signed Run Now step appears live in the routine card (no disposable provisioned desktop was used; synthetic agent correctly retried `unavailable`)
- [x] TASK-042 Part A: search treats `%` and `_` literally; cursor paging returns every run once; another owner's runs never appear (`test:jobs`)
- [x] TASK-042 Part A: outcomes map every `runs.status`, and an unsealed run is Running only inside 15 minutes (`test:jobs`)
- [x] TASK-042 Part A: Cancel aborts a live run, seals it `aborted`, and refuses a finished run with 409; Retry refuses Verified, Running, already-retried, replay and busy-agent runs (`test:jobs`)
- [x] TASK-042 Part A: Upcoming runs are correct for Asia/Kolkata and across the America/New_York DST change; paused routines and the agent filter behave (`test:jobs`)
- [x] TASK-042 Part B: a routine job exposes its `routineId`; a scheduled retry queues `run_now` with `retry_of` and the routine id; a scheduled run without a routine is refused (`test:jobs`)
- [x] TASK-042 Part A (cannot): anonymous calls are 401; wrong Origin and CSRF are 403; bad ids, unknown query keys and an oversized body are 400/413; `run_meta` is insert-only for the app role (`test:jobs`)
- [x] TASK-042 Part A live browser at 1440 and 375 px on a disposable Postgres and local production build: 8 seeded runs, list/detail with a chain-verified timeline, search `100%`, agent filter, Failed tab, Upcoming runs with schedule details, routine Pause/Resume, and the cancel confirmation plus its 409 message; no horizontal overflow at either width

## Demo extras: starter crew and Mission Control (TASK-058) + custom crews (TASK-089)

The morning report was removed 2026-11-04 (replaced by Schedules); its checks and `test:crew-report` were deleted. `test:crew-routes` now asserts the report files and scheduler tick are gone.

- [x] The six preview roles are the only source of policies and budgets; a same-named agent is never adopted, and a repeat or concurrent create never duplicates members (`test:starter-crew`: six preallocated UUIDs, one setup row, six agent/policy rows, same ids on retry).
- [x] One failed desktop keeps the completed agents and the failed identity paused; Retry reuses the same UUID and completes the set (`test:starter-crew`).
- [x] A crashed `creating` member is resumed only after its claim is stale (`test:starter-crew`).
- [x] Mission Control returns only the owner's agents, a run only while its heartbeat is fresh, real step/cost totals, local-day spend and pending approvals; a desktop error becomes `unavailable`, and only `session.status` is called (`test:crew-status`).
- [x] A Mission Control thumbnail revalidates the desktop stream state before opening its socket and shows the stopped placeholder on denial (`test:crew-routes`).
- [x] A stored `crew_report` card from before the removal stays validated text and never becomes a URL or HTML (`test:crew-routes`).
- [x] Crew routes require the owner session, exact Origin and CSRF for mutations; bodies are strict and bounded (`test:crew-routes`).
- [ ] Live browser at 1440 and 375 px: preview/edit/create the crew, a partial setup retry, two live frames plus a stopped placeholder on Mission Control.
- [ ] Live core demo rechecked after the crew extras; five-take and four-Meta-model acceptance are recorded separately.
- [x] Custom crews (`test:crews`): up to 6 members with only names + roles required; persona/budgets/tools/actions/defaults fill server-side; migration 0035 + provision grants allowlisted; a sender outside any crew keeps open handoff while a crew member can only hand to crewmates (`different_crew`).
- [x] Custom crew Retry (`test:crews`, real Postgres): only failed members are set up again, under the same agent UUID and with the persona/budget saved at create; a live `creating` claim is never taken over; a claim older than 3 minutes (app restart mid-setup) offers Retry and is reclaimed; another owner id gets 404/null; `POST /api/crews/[crewId]` needs the owner session, CSRF and an empty body.
- [ ] Live browser: stop the app while a crew is being created, restart, and confirm Retry appears after 3 minutes and finishes the remaining members.
- [ ] Live browser: create a 2-agent crew, watch both reach Ready, hand a task from one to the other in chat and confirm the second receives it; an outsider handoff attempt is refused.

, backticks, spaces, backslashes and newlines are refused, not escaped; the probe program contains no single quote and fits the 4,000-character shell limit (`check-ins.test.mjs`)
- [x] Probe output fails closed: no `EC-FP <sha256>` header → not a result; a failed fetch exits non-zero under `pipefail` (desktop container, real python3 normalization of a sample page)
- [x] Changed lines are counted only; the wake task is the owner goal plus counts, never page text (`check-ins.test.mjs`)
- [x] Migration 0038 + provision.sql pins (columns, types, defaults, constraints, indexes, grants, history) match a fresh Postgres 17
- [x] Live 2026-11-04: app image rebuilt, `db:provision` + `db:migrate` (0038, 39 migrations) applied, app recreated; a due check-in on a paused agent was picked up by the live tick and skipped with no probe (row removed)
- [ ] Live: add a Sundance check-in on an allowlisted page, Check now → Baseline saved; change the page → Changed card and (with a goal) one agent run labelled `Sundance · <name>`
- [ ] Live (cannot): a site not on the agent website list → one "couldn’t read" card, no repeat while it keeps failing; paused agent / stopped crew → Skipped, no probe
- [ ] Live: Moondance changes produce no card overnight and one summary after the window closes; urgent Moondance alerts at once
- [x] Login walls: HTTP 401/403 or a password field → `login`; 404/500 → unreachable; in browser mode a login-style path or a near-empty sign-in page → login, a full page with a header "Sign in" link is not (`check-ins.test.mjs`; python run in the desktop container on a real login form)
- [ ] Live: a login-protected page → one "needs you to sign in" card, status Needs you, `via` switches to browser; take over, sign in, hand back, Check now → Baseline saved; later checks keep the login; the check never runs while the agent is busy or taken over
- [ ] Routes deny anonymous, wrong Origin/CSRF, another owner’s agent (404), extra fields, 11th check-in (409), Check now twice in 30 s (429)

## Deterministic replay (TASK-041)

- [x] A run that is sealed, `finished`, chain-verified and has only pass/executed steps compiles to numbered steps (click, type, key, scroll, wait, deliver_file); a click stores the grounded control's role and exact name, never the model's wording, a coordinate or typed text; compiling the same run again returns the same script (`test:replay`: script, store)
- [x] Refused with a step number and a fixed code: a run that stopped or is unsealed, a tampered chain, a failed or unknown step, `read_document`, a prose or `object_visible` postcondition, a click with no recorded control, no steps, more than 20 steps (`test:replay`)
- [x] Replaying a script makes no model call: the deps have no provider, every receipt says model `none`, zero usage and 0 micro-USD, the run cost receipt shows 0 calls and `cost_entries` has no rows, the run is sealed, appears in History as Verified and `verifyRunExport` passes with the pinned key (`test:replay` against Postgres with the real recorders)
- [x] Same order as the step loop: checkpoint 0, then receipt, evidence and checkpoint per step, then the seal; a failed receipt stops the run, a failed evidence or checkpoint write does not (`test:replay`: runner)
- [x] Each click, type and key step needs exactly one visible control with the recorded role and name (or exactly one focused text field), read again before input; a type step into a button or with two focused fields is refused; scroll and wait have no target (`test:replay`: runner)
- [x] A postcondition is retried three times (500 ms apart) and then stops the run before the next step; `unknown`, a missing verifier and a non-structural check are mismatches, never passes (`test:replay`: runner)
- [x] (cannot) On a changed site (mock-portal layout B has no "Download PDF") the first click stops with no input, a `blocked` receipt, a "Needs you" run and a fixed card; that run can't be saved as a replay (`test:replay`: Postgres)
- [x] (cannot) Takeover (`paused_by_owner`), an action removed from the agent's allowlist, abort, the wall clock (also a hung desktop call), a missing typed value and a busy agent all stop without further input; a chat run and a replay on one agent can't overlap in either order (`test:replay`: runner)
- [x] Typed text reaches the desktop once and appears in no receipt, checkpoint, card, evidence row or database row (`test:replay`)
- [x] (cannot) Routes deny anonymous calls, a wrong Origin, a wrong CSRF token, bad ids, extra or oversized fields and a missing or extra input value, and a paused agent gets 409; another owner's run or script looks like "not found"; nothing is created by a denied call (`test:replay`: store)
- [x] (cannot) The app role can insert, read and delete `replay_scripts`, never update or truncate them; a second script for one run is refused; deleting a script leaves its run and receipts; a damaged stored script is never replayed (`test:replay`: store)
- [x] With no `RECEIPT_SIGNING_KEY` a replay explains itself in chat instead of acting (`test:replay`: store)
- [ ] Live: save a verified mock-portal run in a browser at 1440 and 375 px, replay it on the real desktop, change the layout and replay again (needs the owner stack rebuilt and a live agent run)

## Self-healing (TASK-044)

- [x] Only site-change codes heal (`target_missing`, `ambiguous_target`, `target_changed`, `unsupported_focus`, `postcondition_failed`, `postcondition_unknown`); typed remaining steps, a pending proposal, no Main model, a busy agent, a stale version, takeover and limits never start a repair (`test:heal`)
- [x] The repair instruction is fixed; saved step labels are quoted, bounded and sent only in a `web`-tagged block; typed text never enters the task, header or proposal (`test:heal`)
- [x] A sealed, finished, chain-verified repair compiles into a pending proposal; the diff is computed against the base version, approval appends v2 and the next replay resolves it; reject leaves v1 (`test:heal`)
- [x] A second decision, a stale base, another owner, wrong Origin/CSRF, extra body keys and bad ids are denied; versions are insert-only and the app role cannot delete proposals (`test:heal`)
- [x] Deleting a script cascades versions and proposals without touching runs or receipts; a damaged version is never replayed (`test:heal`)
- [ ] Live: mock portal A → B, replay, repair with a real model, review at 1440/375 and approve; a replay on B then makes zero model calls

## Mock vendor portal (TASK-035)

- [x] `node --test tests/mock-vendor.test.mjs`: five HTTP/PDF/lifecycle guard tests. Month filters, empty/clear, A/B/reset, identical PDF bytes, text/byte-correct xref and fixed names verified. Wrong Host/Origin/CSRF/method/content type, unknown/duplicate fields (including escaped duplicate JSON keys), invalid month/ID and oversized body are denied without mutation; no external resource URLs or raw file access.
- [x] Final disposable desktop run `99f43513539b2b87`, `node --test tests/mock-vendor-desktop.test.mjs`: rebuilt image, Compose up/healthy ps, real unprivileged Chromium and a downloaded sample invoice. PDF.js extracts matching ID/amount and renders it in Chromium; page/PDF screenshots inspected. Evidence: `data/spikes/task035/99f43513539b2b87/report.json` and sibling PNG/PDF files.
- [x] A-specific Download PDF links disappear in B; Get invoice succeeds with unchanged data. Keyboard Tab/Shift+Tab/Enter, visible focus, reset, filter-empty, clear, injected failed-control request and recovery pass. Both layouts fit 375/768/1280/1440 px without page overflow. Browser observed no external requests.
- [x] Start is idempotent; status/start/stop/restart succeed, stopped URL refuses connections and restart resets A. Symlinked state is refused. A peer UID receives EACCES on a live fixture's private state; UID/birth/executable/argument guards reject foreign process identities. Original profiles/downloads are not used. Test container, network, volume and image cleanup is independently checked.
- [x] `npm run mock-vendor:check`: eleven generated assets match source. Five offline desktop image/package/privilege regressions pass. TASK-035 file lint and whitespace checks pass.
- Final global checks: typecheck reports unrelated BigInt/ES2017 errors in concurrent `lib/costs/pricing.ts`; lint reports two set-state-in-effect errors in concurrent `components/workspace/agent-pane.tsx` (31, 78). TASK-035 file-scoped lint passes. These files were not changed for TASK-035; refresh global checks as concurrent work lands.
- [ ] Actual owner-stack fixture launch after rebuilding/recreating its desktop image (not performed; disposable acceptance is complete). Agent teaching/replay/self-healing remains in its existing unchecked acceptance items.

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
- [x] TASK-007 full acceptance (owner reopened for actual-click test; met by the fixture live run below): obtain a genuine validated action with no unresolved provider checks, execute only the authorized local button click and verify closed→open plus visible Project status. No automatic acknowledgements or paid retries.
- [x] TASK-007 actual-click offline: native click and optional unchanged stateless replay, two-request/token/time budgets, unsafe/malformed response stops, private warning redaction and credential-free browser request policy pass.
- [x] TASK-007 actual-click local browser: fresh Firefox (latest continuation; earlier Chromium checks also passed) rejected wrong/stale targets, executed one coordinate click, verified closed→open and visible status, and rejected a second click without using Meta credits.
- [x] TASK-007 reviewed flow offline: 1024/3072 output budget and three-request ceiling; exact check/receipt/history replay after specific approval; wrong-target/denial/stale/timeout paths never input or acknowledge. Nonce-bound stdin review is explicit, abortable and single-use; review wait is excluded from active model time.
- [x] TASK-007 reviewed flow offline: genuine execution/postconditions remain recorded when acknowledgement fails; acknowledgement/new returned actions cannot trigger a second click.
- [x] TASK-007 image contract: original detail on initial/observation/acknowledgement images, unchanged bytes/replay, and geometry mismatch rejection before model usage/input; 22 live-driver tests pass including real isolated Firefox.
- [ ] TASK-007 original-detail live: Original-detail run 3e06d19f-8460-4162-968a-7ea98b134318 verified 1280x800/DPR1 and the unchanged screenshot hash, but returned (359,483), below the button ending y=466. One Contributor request used 3559 input / 670 output tokens (584 reasoning); wrong_target stopped before review/input/acknowledgement. Original detail did not resolve the miss; no token cap was reached.
- [ ] TASK-007 reviewed flow live: d1395501-fc64-4938-bb4e-676bd3e3fef0 completed the genuine observation/replay exchange in Firefox, then returned (359,483), outside the button ending at y=466 on the same reference-image hash. Driver stopped wrong_target before review/input/acknowledgement. Two Contributor requests used 8532 input / 367 output (191 and 176), 229 reasoning; caps were not reached. Actual Meta-driven click remains unverified.
- [x] TASK-007 fixture: the driver serves a self-contained loopback fixture (GET `/` only, favicon 204, everything else 404/405), no longer needs the app, and closes the server on exit; 23 live-driver tests pass including real headless Firefox at 1862x946/DPR1. Fixture button box (571,456)-(746,488) matches the earlier hit screenshot.
- [x] TASK-007 fixture live: Run 21c0933d-7e35-4ec4-be42-a784ab4ec56d (fixture, 1862x946/DPR1): after one screenshot observation the model proposed (657,471) inside the button (571,456)-(746,488); owner approved the specific point; one Firefox click opened the section (closed->open, Project status visible, after.png inspected); the reviewed acknowledgement was accepted and no further action executed. 3 Contributor requests, 21354 input / 527 output tokens (338 reasoning), 15.9 s model time, no caps reached. The earlier 1280x800 misses at (359,483) are historical; the viewport size, not original detail, is the likely cause (one run, not proven).
- [ ] TASK-007 actual-click live: dce29060-5365-4bb3-93e8-7b9c5f757350 returned a completed click proposal with computer_action_requires_confirmation; exact sanitized reason retained. Output 369/512, so no token cutoff. Independent no-input Firefox comparison reproduced the exact screenshot hash and measured button x=280..456.35/y=434..466; model point (359,478) misses. No click/acknowledgement executed. TASK-007 remains open.
- [x] TASK-007 bounded loop offline: text-only first turn, unchanged genuine replay/call correlation, static PNG only on matching tool output, strict post-image click acceptance and two-request ceiling. Missing/invalid receipts, premature clicks, repeat observations, safety checks, credential replay and inconsistent/excess usage stop safely.
- [x] TASK-007 deadlines offline: simulated 30-second request timeout aborts a non-cooperating transport without retries; a 45-second total overrun stops before continuation.
- [ ] TASK-007 bounded loop live: latest evidence f4aa6650-f817-4148-8802-bb369129efcc stopped replay_unavailable before a second request (2284 input / 89 output tokens; empty checks). Exact replay subreason was not retained. Still required: one approved invocation, at most two Contributor requests / 512 output tokens each, obtains genuine post-image validated_click and owner target confirmation. No input execution.
- [x] TASK-065: missing or malformed master keys are rejected; encrypted values round-trip correctly and reject tampering or the wrong key without leaking plaintext or keys (AES-256-GCM, private idempotent setup, app-only Compose exposure and Linux symlink refusal pass).
- [x] TASK-021 offline: 16 mocked-transport tests pass for keyless Meta/OpenAI requests, bounded safe failures, model lists, text/image/tool normalization, exact source-tag framing, Meta safety/replay binding, no automatic acknowledgement, hybrid capability probes and unknown-versus-unsupported handling.
- [x] TASK-021 offline: a model that returns a valid completion without the forced probe tool is rejected with `tool_calling_unsupported`; failed, rejected or incomplete probes remain `tool_calling_unknown`.
- [x] TASK-046 proxy: 12 tests pass (blocklist, target rules, single key injection, redaction, limits, auth, transport, Test button). Compose: proxy healthy; from `app` a fake key gets the real upstream 401 through the proxy; metadata IP, `http://` and `localhost` targets and a wrong secret are refused; desktop cannot reach the proxy or the internet; `app` has no direct internet.
- [x] TASK-067 mocked: 11 desktop-tool tests (also run in the real container, incl. docx and symlinks) and 8 loop tests pass: windows exact, three kept, injection stays data, default-deny, delivery card hook and named final message, fixed failure codes, 4,000-character answers.
- [x] TASK-067 real stack: through the 4311 listener as the agent's own user, list/read (offset)/deliver work, a script renamed .pdf is refused, delivered files are mode 600 with a numbered suffix, a real text-layer PDF reads offline.
- [ ] TASK-067 live: attach a PDF, ask a question about it; ask the agent to download a file and send it (owner check; needs your key and a model that follows the delivery rule).
- [x] TASK-069 mocked: 4 tests pass (one run and one card per message, busy card once without a second run, missing model/desktop fixed cards, errors never leak details).
- [ ] TASK-069 live: send `What time is it?` to an agent; an answer card appears without a refresh (owner check; needs a saved real key).
- [x] TASK-046 live: with the project Meta key, a call through the proxy to api.meta.ai/v1/models returned 200 and 9 models, and the key was not echoed (agent check, 2026-11-01).
- [ ] TASK-021/046 live: the Settings Test button with a saved key (needs your login).
- [x] TASK-020 offline: 17 model tests pass for owner-safe settings, AES-GCM persistence, short-key masking, provider-change key clearing, same-key reuse, the serialized same-key invariant, CSRF/Origin/owner denials, bounded mocked Test output and independent rate limiting.
- [x] TASK-020 browser: run `cc8ffafe-25fe-4fe2-afa1-58fea2d5375e` saved Main AI with a synthetic key, reloaded to a masked hint only, shared one encrypted provider with SAM same-key, rendered a mocked bounded model/latency Test response, showed honest live-Test unavailability, denied unauth/Origin/CSRF/unknown/oversized inputs and fit at 375 px (6 model checks plus encrypted-at-rest database assertion).
- [ ] Main AI accepts a Meta Model API key; Test shows models and latency
- [x] SAM card with "Use the same key as Main AI" works with one Meta key
- [x] Saved keys show only as `••••1a2b` and are never returned by the API
- [ ] Keys never appear in model prompts, logs or receipts
- [ ] Muse Wonder is used for hard computer-use steps and falls back to Spark when unavailable
- [ ] A model without tool calling is rejected with a clear message

## Approvals, permissions and Astra Mode

- [x] Anything not in an agent's permissions is denied (`test:agent-step-loop`: the default-deny action allowlist stops before any input; TASK-050 keeps it first)
- [x] Risky actions prompt Allow once / Always allow / Deny (`test:agent-step-loop`: allow executes after a page re-check; deny executes nothing; a missing approval service fails closed; a changed page is `approval_stale`)
- [x] Approval attention preserves existing budget and security attention, and clears only approval attention (`tests/approval-attention.test.mjs`: conditional SQL and disposable Postgres checks).
- [x] Always allow is stored per agent + site + action (+ limit) and doesn't apply to other agents or sites (`test:approvals` real-Postgres: exact host only, subdomain/other class/other agent denied; revoke removes it at once)
- [x] An action over a saved limit asks again (`test:approvals`: a grant with one use allows once, then creates a new approval and the run waits)
- [ ] Enabling Astra Mode needs the warning modal; the red ASTRA MODE badge shows everywhere
- [x] In Astra Mode, receipts, audit log, budgets, tripwire and key isolation still work (`test:astra` gate auto-allow/record, `test:agent-step-loop` proves allowlist, task scope, canary, step limit and budget still block; audit rows are covered by `test:audit`)

## Security

- [x] Agents can only reach domains on their allowlist (TASK-045: offline registry/proxy checks plus disposable real-Docker run `4a002910-58ca-4ca0-b83f-cfceae57723f`; real Chromium loaded `example.com` and refused `iana.org`)
- [x] Requests to `169.254.169.254` and private network ranges are blocked (TASK-045: CONNECT to `169.254.169.254`, `10.0.0.1` and an HTTP request to `169.254.169.254` refused; see the TASK-045 subsection)
- [ ] Credentials are injected by the egress proxy; the model never sees them
- [x] An agent's canary secret leaving the machine kills the session and logs a security event (`test:canary` 4/4, `test:tripwire` 5/5, `test:egress-tripwire` 7/7, `test:agent-step-loop` 43/43). Limits: no TLS interception, so HTTPS bodies/paths, chat text, owner takeover typing and provider calls are not inspected; the proxy sees `CONNECT` hosts and plain-HTTP request lines/headers, and the app sees `type` text before execution.
- [x] A malicious page instructing the agent to send data elsewhere does not change the task (TASK-049 offline: `test:agent-scope` 8/8 covers hosts, emails, look-alikes, userinfo tricks, page rule and hostile input; `test:agent-step-loop` proves no desktop input, unchanged task and text-free receipts. Live hostile page pending TASK-055)
- [x] Stop agent halts one agent immediately; Stop crew halts all of them (`test:halt`: fixed order, independent steps, time bounds, crew gate first; `test:tripwire` keeps the trip order)
- [ ] Security Center lists tripwire events and blocked actions
- [x] Audit log is append-only and signed (`test:audit`: 20 concurrent writers form one gap-free chain, duplicate `source_ref` recorded once, runtime UPDATE/DELETE denied, tampering fails `entry_hash_mismatch`; `test:verify-cli` covers `verify-audit` pass, pin, truncation and tamper)

### TASK-071 network namespace spike (2026-11-02 IST)

- Reproduce: `node scripts/spikes/network-namespace.mjs`. A non-passing candidate exits 1; cleanup is reported separately. The spike does not complete TASK-045 or TASK-071.
- Final run `3d2616f6d171d52fffbfc2c4`: [sanitized report](../test-results/network-namespace/3d2616f6d171d52fffbfc2c4/report.json), 36.1 seconds, Docker 29.9.2 Linux amd64, desktop image `sha256:8568856aa703d782be2168e12634f0c641292717a3078ff56f12470046d4a92d`. Earlier runs retain preflight/parser diagnostics; this is the final evidence.
- [x] 72 Linux probe assertions pass. Supervisor effective/permitted/bounding capabilities reduce from `0x2001c3` to `0x1c3`; inherited filter remains active. Both synthetic agent users have zero capability sets and no-new-privileges. New user/network namespaces are created after reduction; temporary namespace-local capabilities are dropped before agent/browser work.
- [x] Two distinct agents bind the same localhost port and read their own markers; restarting the first agent creates a third distinct namespace while the second remains active. Outer network-namespace creation without a user namespace is denied; all synthetic sessions exit and are reaped.
- [x] Shared IPv4/IPv6 loopback is unreachable. Direct TCP, DNS-like UDP, QUIC-like UDP and IPv6 documentation-address probes return no route. Only loopback exists; no IPv4 routes exist. These are controlled topology tests, not live probes against metadata or LAN machines.
- [x] The inherited socket inventory contains only the intended AF_UNIX bridge endpoint, not a pre-opened TCP/UDP escape. Abstract Unix sockets are isolated; a pathname socket below root-only `/run/eclipse` returns EACCES.
- [x] The fixed HTTP bridge reaches only its disposable fixture. Unlisted/private/metadata destinations, simulated forbidden DNS, a forbidden redirect and forged agent identity all return 403. The DNS fixture is deterministic and is not production resolver/allowlist enforcement.
- [x] Real graphical Chromium loads the bridge fixture, clicks the known button and captures a 4,546-byte PNG in all three sessions. `chrome://sandbox` confirms namespace/PID/network and Seccomp-BPF layers. Existing `startSession` and Playwright private pipes are reused; no production controller integration or noVNC acceptance is claimed.
- [ ] **Candidate boundary failure (3 assertions):** every session connects to the deliberately world-accessible `/tmp/task071-shared.sock` in the shared filesystem. Network namespaces isolate abstract sockets, but pathname sockets still depend on filesystem permissions/authentication. This is a synthetic counterexample, not a demonstrated exploit of an existing app listener. See [network_namespaces(7)](https://man7.org/linux/man-pages/man7/network_namespaces.7.html), [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) and [user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html).
- [ ] **Environment limit:** this Docker Desktop engine advertises seccomp but no AppArmor; both existing desktop and fixture have an empty AppArmor profile. No override or host setting was changed. Superseded for the kernel layer by the Oracle probe below (Ubuntu 24.04 aarch64, AppArmor enabled); the full x86-64 suite with the real desktop image and Linux-host portability remain unverified.
- [x] Named volume, internal network, fixture container/image and temporary base-image tag are removed. Independent run-label enumeration is empty; all pre-existing container IDs/images/running states/start times/restart counts and volume/network identities are preserved.
- Next bounded validation: inventory the actual desktop's pathname listeners and test that peer agents cannot use them to reach network-capable services. Check private directories and service authentication, including X/Chromium sockets. Approve a separate production prompt only after that boundary is accounted for; the full x86-64 isolation suite (which runs under AppArmor) is still needed for that layer.
- No real credentials, saved profiles, models, external websites, metadata endpoints or unrelated LAN targets were used. Production allowlists, credential injection, tripwire, approvals and controller integration remain separate acceptance; their existing boxes stay unchecked.
- Offline harness checks: `node --test tests/network-namespace-spike.test.mjs` (7/7 with Windows child-process access), `npm run lint` and `npm run typecheck` pass. `--test-isolation=none` also passes 7/7 within the restricted sandbox, avoiding its child-process EPERM without changing Docker security.

### TASK-045 desktop egress (2026-11-02 IST)

- Reproduce: `npm run test:egress-desktop` (12 offline proxy/registry checks), `npm run test:egress-policy` (3 app-push checks), `npm run test:desktop-egress` (disposable `desktop` + `egress-proxy` stack, real Chromium, real internet). Evidence for the Docker run: `data/spikes/task-045/<uuid>/result.json`.
- [x] Offline: exact/subdomain/look-alike allowlist matching; token mint/verify and desktop/proxy formula agreement; `407` for missing/wrong/peer tokens; `403` for unknown/blocked agents, non-443, IP literals, unlisted hosts, private/metadata DNS and mixed answers; DNS pinned to the first checked address; plain HTTP `307` with the same path and `403` for unlisted/private; policy auth, strict validation, TTL; an unchanged refresh keeps tunnels while a changed/blocked push and expiry destroy them; tunnel caps; no secret or token in logs; the app and proxy domain patterns agree (12/12).
- [x] Offline app push: Bearer `EGRESS_PROXY_SECRET`, bounded JSON body, 5 s abort, non-2xx/network failure is a soft failure, invalid secret sends nothing, blocked pushes use an empty list (3/3).
- [x] Real Docker `4a002910-58ca-4ca0-b83f-cfceae57723f` (39 s): allowlisted `example.com` CONNECT completed a verified TLS handshake; `example.org`, `169.254.169.254`, `10.0.0.1`, port 80 and a token minted for another agent were refused; plain HTTP was redirected to HTTPS and `169.254.169.254` over HTTP was refused; direct TCP to `1.1.1.1`, the Docker gateway and unauthenticated `egress-proxy:4320` failed; `DESKTOP_CONTROL_SECRET`, `EGRESS_DESKTOP_SECRET` and the token were absent from every agent-visible environment and command line; real Chromium loaded `example.com`, refused `iana.org`, and still loaded the loopback fixture. Cleanup complete.
- [x] Plain HTTP from the browser to an allowlisted host is redirected to HTTPS; plaintext is never forwarded.
- [ ] Live owner-stack check (rebuild with `EGRESS_DESKTOP_SECRET`, browse an allowlisted and a blocked site from an agent desktop) and a chat-run push against the running app.

### Shadow DOM and iframe grounding spike (2026-11-02 IST)

- Reproduce: `node scripts/spikes/shadow-frame/run.mjs`. One throwaway `main-desktop` container, uid `65534:65534`, `--read-only`, `--cap-drop=ALL`, `no-new-privileges`, the pinned seccomp profile, `--network none` and no mounts or ports; the live-page phase is a separate `--live` opt-in and was not run. Evidence: `data/spikes/shadow-frame/<runId>/report.md`. No production file changed.
- Final run `bdd10ac2f05b` (61.7 s): image `sha256:09f18a2f8398…` created 2026-11-02T00:21:42Z; the image's `page-snapshot.mjs` hash matched the repo copy; cleanup complete; Compose unchanged before/after (5 services, digest `3b39c38a7efa`). Calibration origin `{x:4,y:87}`, viewport 1015×676, real xdotool pointer moves.
- Columns: **Current** = the image's `scanPage` (top frame only); **A** = open-shadow DOM walk with per-frame offsets and the parent hit test; **B** = CDP `Accessibility.getFullAXTree` + `DOM.getContentQuads`, one session per frame. 9 fixtures, 38 named targets, 27 of them `listed`.

| Scanner | Fixtures pass | Listed targets found / clicked | heavy.html p95 | Safety |
|---|---|---|---|---|
| Current | 2/9 | 9 / 27 | 4 ms | pass |
| A | 8/9 | 26 / 27 | 155 ms | pass |
| B | 5/9 | 18 / 27 | 240 ms | **fail** |

- [x] Every cross-site frame really ran out of process: CDP `Target.getTargets` reported a `localhost:8082` iframe target for all three fixtures that embed one (`cross-site.html`, `sensitive.html`, `payment.html`).
- [x] No sensitive or payment control was ever listed by Current or A. All three scanners counted the Stripe-shaped frame, listed none of its controls, and never offered `cc-number`, `cc-exp`, `cc-csc`, a password field or an `one-time-code` field — in open shadow, in a same-origin frame and in a cross-site frame.
- [x] Speed: p95 on `heavy.html` (50 hosts × 10 open-shadow buttons + 5 frames × 50 buttons) was 155 ms for A and 240 ms for B, both under the 1,500 ms bar; both hit the 150-control production cap on that page, which the report marks.
- [x] Clicks are verified by real input, not by the scanner's own claim: the page records `window.__spikeClicks` per frame and the click counts only if exactly the named target recorded it.
- [ ] **Safety failure, B:** `obstruction.html/Covered shadow` — an open-shadow button under a fixed overlay — was listed by B and its click landed. The accessibility tree carries no hit-test information, so B cannot decide what is reachable and must not be a grounding source on its own.
- [ ] **Coverage gap, A:** `closed-shadow.html/Book test drive` was found by no DOM route (0/1) and only by B (1/1). Closed roots stay unreachable to any in-page script.
- [ ] **Coverage gap, B:** same-process child frames are unreachable with the prescribed per-frame CDP sessions — `frames.html` 1/7 (only the top-frame button), and the buttons inside the same-origin frames of `sensitive.html` and `obstruction.html` are missing too. Out-of-process frames are fine (3/3).
- [ ] **Name divergence:** the open-shadow button labelled from a light-DOM id (`Cross label`) is named by A and unnamed to the accessibility tree, so B cannot list it. `docs/ARCHITECTURE.md` §7's cascade would have to keep A's name rules to preserve the current inventory.
- [x] Verification predicates still behave: `control_present` passed for the 3 sampled targets per scanner per fixture, and `control_absent: Removed target` passed for all three after the real click on "Remove target" (`verifySnapshot`, no ambiguous matches).
- Offline harness checks: `node --test tests/shadow-frame-spike.test.mjs` (7/7 — container flags and the `--live` one-value diff, classification refuses a pass on missing data, cleanup refuses a foreign or Compose-managed container, report rendering, and the fixture/cases agreement), `npm run lint`, `npm run typecheck`, `git diff --check`.
- Recommendation from the table: **combine them** — build A as the primary shadow/frame scanner (8/9 fixtures, 26/27 clicks, safety clean) and keep B as the fallback for closed roots only, gated behind A's hit test. Live-site evidence (Shoelace, Porsche, MDN, Stripe) is still owed before the production prompt.

## Memory

- [ ] `SOUL.md`, `USER.md` and `MEMORY.md` are readable and editable in the Memory tab
- [x] Every new entry has a scope (global / agent / private) and provenance (`test:memory-store`: owner writes carry scope, author and version; `test:memory` proves default-deny reads)
- [x] A `private` entry is not visible to agents outside its list (`test:memory`: scope rule; `test:memory-store`: agent B never sees agent A's MEMORY/private notes in the snapshot)
- [x] Facts learned from web, email or documents need approval before entering shared memory (`test:memory-changes`: propose writes nothing, approve applies, reject/expired refused; `test:memory-scan` rejects injection and secrets)
- [x] New memories show as diffs with Undo; pinned facts are never rewritten (`test:memory-changes`: undo appends a restore and stale versions are refused; pinned body refusal is enforced in `undoMemoryVersion`)
- [x] Writes during a session take effect in the next session (frozen snapshot) (`test:memory-store`: an already-loaded snapshot is unchanged, the next load sees the new entry)
- [x] Changes are mirrored to `./data/memory` as Markdown (`test:memory-store`: USER.md, SOUL.md, MEMORY.md and PRIVATE.md match the database)
- [ ] Asked about a fact saved in an earlier session, the agent checks memory and answers with it instead of asking the owner again
- [ ] "I'll remember that" is only said after a memory write request was made
- [x] TASK-086 origin gate: a quote that is an exact owner message with 90% word coverage auto-saves/replaces/forgets; a missing quote, a low-coverage fact, a `document`-born fact, a pinned entry and `ask` mode all wait or refuse. Auto-save has a version, an audit event and Undo (`test:memory-gate` 5/5, real Postgres)
- [x] TASK-086 caps and scopes: USER.md 1,500, MEMORY.md 3,000, private 2,200, snapshot 8,000; new agents get `global` + `agent`; the migration sets existing agents to `ask` (`test:memory-store` 6/6, `test:memory-changes` 6/6, `test:memory-gate`)
- [x] TASK-086 chat search: full-text over the calling agent's own chat only, up to five 300-character snippets, owner-scoped, no vector database (`test:chat-search` 2/2)
- [ ] TASK-086 background review and tidy: enqueue after chat, 120 s delay, per-agent cursor, at most 5 changes; nightly/85% tidy with 95% source coverage, batch Undo and a 6-hour floor. `test:memory-background` 5/5 offline plus one opt-in real pg-boss check (`ECLIPSE_MEMORY_QUEUE_E2E=1` inside the app container). Built; no live model run yet
- [ ] TASK-086 browser check at 1440/375 px: tell an agent "I prefer replies in bullet points", see the auto-save card with Undo, the mode banner and the visible-to picker. Not run

## Budgets and cost

- [x] Agent daily and monthly budgets warn at 80% and pause the agent at 100% (isolated Postgres run: exact 80% warning card and 100% pause; `npm run test:costs-store`)
- [ ] Routine budgets warn at 80% and pause at 100% (routine runtime is TASK-038/039)
- [x] Run guards stop runs at max steps, max tokens and the wall-clock limit (`test:agent-step-loop`, `test:providers`; non-cooperating provider is aborted). TASK-087: a `shell` agent reaches 60 steps / 1,500,000 weighted tokens / 60 minutes, TASK-083's base is 60 / 400,000 weighted / 30 minutes, a caller can request less (heal's 8), and the stop card names the actual limit (`test:agent-step-loop` 97/97)
- [x] The same action repeated 3 times stops the run (`test:agent-step-loop`)
- [x] Each run has a cost receipt: tokens in/out/cached, model per step and call, cost in USD micros (`test:costs-store`, real run cost route)
- [x] Editing the price table changes later cost receipts, never old rows (`test:costs-store`: Wonder $4/1M falls to $2/1M while the first row stays $4)
- [x] Budget is checked before every model call against the live total; two concurrent runs may each make only the one call they checked before the shared total pauses (`test:costs-store`)
- [x] At 100% the run stops with a `budget_paused` card in chat, the `corona` ring on the agent and a toast (live Chrome: price save/reload, `Needs you` ring and toast at 1440 and 375 px, no overflow; screenshots in `test-results/task-034/`; attention fixture and session removed)
- [x] Retrying the same model call adds no second cost row (`test:costs-store`, real unique idempotency key and `onConflictDoNothing`)
- [x] Runs that fail, return invalid output or are cancelled still appear in the cost receipt (`test:costs-runtime`; failed calls carry a zero-usage row when the provider reports no usage)

## Date and time

- [ ] "What's today's date and time?" is answered correctly in the owner's timezone
- [x] "Next Friday 9am" resolves to the correct date and is shown in the routine card (TASK-038 automated relative-date/DST tests; card display verified live)
- [ ] A weekday 09:00 routine fires at 09:00 local time across a DST change
- [ ] Timestamps are stored in UTC and shown in the owner's timezone
- [x] Timezone notice (`test:timezone-notice`): it appears only when the browser zone differs from the saved one and that saved/detected pair was not kept; it never writes on its own (one owner-click POST to the CSRF-protected account route); a new trip or a changed saved zone asks again; browser storage access is guarded; it is in all three shell layouts; the route needs the session and accepts only real IANA zones.
- [ ] Live browser: with the saved zone set to `UTC`, every page shows the notice; **Use Asia/Kolkata** saves and the header chip updates; **Keep UTC** hides it after reload on that device; at 375 px the buttons wrap without horizontal scroll.

## Non-functional

- [ ] UI actions respond in under 400 ms
- [ ] Layout works at 375, 768, 1280 and 1440 px; approvals, skill diffs and Jobs are usable on a phone
- [ ] Web app is keyboard-navigable with visible focus states
- [ ] WCAG 2.2 AA contrast; controls have ARIA labels
- [ ] No telemetry: only model, tool and agent-browsing traffic leaves the machine

## Demo acceptance

- [ ] The demo story runs end to end without manual fixes in 5 consecutive takes
- [ ] At least 4 Meta models are visibly used (Spark/Wonder, SAM 3.1, Voice Transcribe, Image)


## Connections, MCP, Composio, templates, shell and namespaces (TASK-070–075)

- [x] `npm run test:connections`: owner scoping, 8-per-agent cap, label uniqueness, cascade, audit kinds, token never returned.
- [x] TASK-088: `tests/github-device.test.mjs` (6/6) runs a real disposable Postgres with migration 0030 and a mocked proxy: the device code is encrypted and never returned; owner scoping; a second Connect replaces the pending flow; `authorization_pending` and `slow_down` reschedule; `access_denied`, `expired_token` and unknown errors stop once; success stores encrypted access/refresh tokens, a `ghu_…last4` hint, and the scheduler tick queues exactly one refresh for a token within 30 minutes of expiry; a repeat poll is a no-op; refresh rotates both tokens; `bad_refresh_token` marks the row `expired`, deletes the refresh token and pushes an empty credential list; a transport failure retries without losing the token. `test:egress-proxy` (14/14) proves the fixed host/paths, no caller target, no token in logs.
- [x] TASK-087 live desktop check: the rebuilt image runs as uid 20000 under `ulimit -u 512 -f 1048576 -v 4194304 -c 0`; `rg` 14.1.0, `jq` 1.7, `ps` (procps-ng 4.0.4), `zip` 3.0, `file` 5.45, `patch` 2.7.6, `python3 -m venv` + `pip` 24.0 inside the venv, Node/WebAssembly and npm 11.19.1 all pass. The running desktop image was rebuilt and is healthy. A public clone without a GitHub connection is covered by `test:git-gateway`; the live owner clone remains part of the git acceptance.
- [ ] TASK-088 live owner sign-in: register the GitHub App (device flow, token expiry, Contents/Pull requests read-write, Metadata read), set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_SLUG`, then Connect GitHub at 1440/375 px, Test passes, push to an installed repo, a repo without the app fails with the needs-you message, Disconnect removes it. Not run (needs the owner's App). Live route probe passed: proxy 400 `invalid_device_request`, app route 401 unauthenticated
- [x] `npm run test:egress-credentials`: bearer/basic/header injection, peer isolation, block/trip/expiry wipe, redaction, canary, header allowlist.
- [x] `npm run test:mcp`: JSON and SSE replies, session id, pin hash stability, risk table, discovery → pin, changed tools block.
- [x] `npm run test:composio`: encrypted key, session body (`instant:false`, no sandbox), link mapping, pin, blocked results, per-agent accounts.
- [x] `npm run test:agent-templates`: templates parse, personas ≤ 2000, no browser actions, fixture is red.
- [x] `npm run test:agent-step-loop`: `tool_call` allowlist/scope/canary/approval/receipt; `shell` allowlist/canary/exit/timeout/receipt; blocked-push approval (one card per pending id, receipt-before-grant, fresh-step retry hint, no whole-command rerun), deny/timeout cleanup, Astra authorization, receipt/grant/cleanup/poll failures, duplicate polls and multi-ref grants.
- [x] `npm run test:egress-relay` (Linux): client Proxy-Authorization replaced, token never echoed, malformed head closed, two identities kept.
- [x] `npm run test:netns` (Linux): helper rejects malformed args; a non-root process either isolates or returns a fixed code.
- [x] `npm run test:shell`: fixed shell environment with no secret, proxy and git-gateway rewrite, credential helper disabled, bounded result schema/formatting, `exit_code`/`stdout_contains` expectations, invalid input refused before spawn.
- [x] `npm run test:git-gateway`: pkt-line create/update/delete/multiple/capabilities/truncation/`push-cert`/duplicate refs/over-64 KiB; classification for default, non-default, new, delete, tag and lookup failure; forged preface; client `Authorization` stripped and Basic injected; blocked push 403 without contacting GitHub; gzip 415; missing credential 403; token absent from logs and responses.
- [x] `npm run test:git-approvals`: pending/grant lifecycle (dedupe, TTLs, caps, exact agent/owner/repo/requestHash/ref/kind/old/new binding, atomic all-or-none consumption, concurrent retry winner); deny/revoke/clear/trip/policy-expiry invalidation; gateway queues one pending per protected ref and forwards only after every exact grant; a changed object id or unprotected ref needs fresh approval; Bearer-only proxy controls with bounded validation and cross-agent refusal; app helpers and shell port fail closed. 13/13.
- [x] `npm run test:egress-relay` (Linux): the gateway relay writes its own `ECLIPSE-AGENT` preface before any client bytes.
- [x] `git --version` executes in the rebuilt pinned image (`2.43.0`); the lock is 445 archives / 250231110 bytes.
- [ ] Live git: clone and push a branch from an agent namespace with no card; a default-branch push shows one card per protected ref; Allow once lets a fresh push succeed; Deny stops `needs_owner`; Always allow/revoke and Astra behave as above; a multi-ref push needs every ref; `env` and `git config -l` show no token. Not run: needs an owner GitHub token and a live egress-proxy rebuild; offline coverage passes.
- [ ] Live owner checks: GitHub Test with a real token; GitHub MCP discovery/pin and a read + comment; Composio link/pin/read/write; shell + git.
- [ ] Linux host + AppArmor run of the isolation suite.
- [x] Live `npm run test:agent-sessions` passes (6/6): the cookie fixture now starts inside each session namespace through `session-fixture-cookie`, so Chromium reaches only its own loopback; the container's own loopback has no listener. Fixes the `ECLIPSE_FIXTURES` flag that `bootstrap.py` previously dropped before the supervisor and the worker. Loopback is now an explicit proxy bypass, and the test's capability check accepts the namespaced session worker alongside Chromium.
- [x] Kernel/AppArmor probe (Oracle Ubuntu 24.04 aarch64, Docker 29.9.2, AppArmor enabled, `kernel.apparmor_restrict_unprivileged_userns = 1`, `user.max_user_namespaces = 47461`): `unshare --user --net --map-user=20001 --map-group=20001` as uid 20001 with `--cap-drop ALL` and no-new-privileges. Default Docker seccomp blocks it (`Operation not permitted`); project seccomp + default AppArmor works (uid map `20001 20001 1`, only `lo`); unconfined seccomp works; project seccomp + `apparmor=unconfined` fails at `write /proc/self/uid_map` (unconfined counts as unprivileged under the sysctl). No custom profile or sysctl change is needed, and the desktop must never run with AppArmor off.
