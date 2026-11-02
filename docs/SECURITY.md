# Security

Eclipse Crew runs AI agents that browse the web, read untrusted content and act on your behalf on your own machine. This document has two parts: the security requirements every contribution must meet, and how to report a vulnerability.

The design behind these rules is in [`docs/ARCHITECTURE.md` §15](ARCHITECTURE.md#15-security-architecture).

> These controls are layered mitigations, not guarantees. Prompt injection in particular is an unsolved problem. Run agents with the least permissions their job needs.

---

## Reporting a vulnerability

**Do not open a public issue for security problems.**

- Report privately through GitHub's **Security → Report a vulnerability** on this repository.
- Include affected version or commit, steps to reproduce, impact, and any proof-of-concept.
- We aim to acknowledge within 3 days and agree a disclosure timeline with you. Please allow a fix to ship before public disclosure.

**In scope:** sandbox escape, cross-agent access (one agent reading another's files, credentials or memory), secret leakage to the model, the browser or logs, authentication bypass, tripwire or egress-proxy bypass, receipt forgery, prompt injection that crosses task scope, and RCE through uploads, downloads or webhooks.

**Out of scope:** issues that need an already-compromised host or `.env`, a model simply giving a wrong answer, and attacks on third-party model providers or websites.

| Version | Supported |
|---|---|
| `main` (latest) | Yes |
| Older commits | No |

---

## Security requirements

The keywords **MUST**, **MUST NOT** and **SHOULD** are used as in RFC 2119.

### 1. Authentication

Eclipse Crew has a single owner per install, with no public signup.

- Every page, API route, SSE stream and WebSocket (including the noVNC desktop stream) **MUST** require a valid owner session. This includes the cost receipt, budget-attention poll and price settings routes; a foreign or unknown run returns the same 404 and price mutations require CSRF. The only exceptions are:
  - `/login`
  - `/setup`, and only until the owner account exists. After that it **MUST** return 404 permanently.
  - `POST /api/hooks/<id>`, which is authenticated by its per-hook secret token instead (see §6).
  - an unauthenticated health check that returns no data.
- Authentication **MUST** be enforced server-side, in middleware *and* inside each handler. Hiding UI elements is not access control.
- Passwords **MUST** be hashed with argon2id and never stored or logged in plain text.
- Session cookies **MUST** be `Secure` (when served over HTTPS), `HttpOnly`, `SameSite=Lax` or stricter, and backed by a server-side session record so they can be revoked.
- State-changing requests **MUST** have CSRF protection.
- Current setup/login require the exact canonical `APP_ORIGIN`; authenticated mutations additionally compare a session-bound CSRF token in constant time. Session identity is read from Postgres, never a caller's owner header/body. Local HTTP uses `eclipse_session`; HTTPS uses Secure `__Host-eclipse_session`. Ingress overwrites forwarding headers; native HTTP trusts them only from the exact ingress DNS peer.
- Setup **MUST** use the shared setup/login/reset transaction lock and database singleton constraint. Conflicting legacy owners fail without deletion. Password recovery uses private stdin and atomically revokes only that owner's sessions. The single-owner login lockout **MUST NOT** be bypassable using claimed IP headers.
- Login, 2FA and password-change endpoints **MUST** be rate-limited, with temporary lockout after repeated failures.
- Changing the password or email **MUST** require the current password. A password change **MUST** invalidate all other sessions.
- If TOTP 2FA is enabled, the secret **MUST** be encrypted at rest, recovery codes **MUST** be stored hashed and single-use, and each code **MUST NOT** be accepted twice.
- The app **MUST** bind to `127.0.0.1` by default. Remote access goes through Tailscale or HTTPS (Caddy) only.

### 2. Authorization

There are two levels: the owner over their data, and each agent over only what its job needs.

**Owner level**

- Every table carries `owner_id`. Every query **MUST** be scoped by the session's `owner_id` through the shared data-access layer, even with one owner today, so team mode can't silently leak data later.
- Resource IDs from the client **MUST** be checked for ownership before use. They **MUST NOT** be trusted just because they exist.

**Agent level (need-to-know)**

- Agent permissions are **default-deny**: tools, domains, memory scopes, files, credentials and action types are allowed only if listed in `agent_policies` or `permissions`.
- Isolation **MUST** be enforced by the OS, not the prompt. Each agent gets its own Linux user, home directory with mode `700`, screen and browser profile. There is no sudo and no access to other homes.
- `/crew/` handoff folders **MUST** be readable only by the sending and receiving agents.
- Memory reads **MUST** respect scopes (`global`, `agent`, `private`). An agent **MUST NOT** see another agent's `private` entries or credentials.
- Sub-agents and handoffs **MUST NOT** get more permissions than their caller, and **MUST** inherit taint.
- "Always allow" grants **MUST** be scoped to agent + site + action (+ optional limit). They **MUST NOT** be global. Implemented (TASK-050): one active `permissions` row per agent + exact host + action class, default 20 uses in a rolling 24 hours; the owner can revoke it in agent settings. Grants never apply to another agent, host or class.
- Approval checks **MUST** look at action arguments, not only tool names. For example, `send_email` to a new recipient escalates. Implemented limit (TASK-050): a risky grounded click is classified by code from the control name and `expect` (download, send, post, delete, purchase, submit). Classification is heuristic—a page can label a destructive button neutrally—and an Enter key that submits a form is not classified. Replay never prompts: a risky replay step proceeds only with a live grant that has capacity.
- Astra Mode removes approval prompts only. Receipts, audit log, budgets, tripwire, token isolation and the block on out-of-scope data exfiltration after untrusted content **MUST** stay on.

**Internal services**

- `desktop-controller`, Postgres, CDP, VNC and the job queue **MUST NOT** be published to the host. They live on the internal Docker network only.
- The `pgboss` schema **MUST** be created by migrations, owned by the migration role, and used at runtime with `migrate: false`/`reindex: false`. The app role gets schema usage plus queue DML, sequence and function execution only; it gets no schema creation, table ownership or DDL.
- `desktop-controller` **MUST** accept requests only from `app`, authenticated with an internal shared secret. Network placement alone is not enough.
- Both HTTP and WebSocket require the secret and exact current app DNS source; DNS failures deny access. Public upgrades require the exact canonical Host/Origin and a database-backed owner session. Revalidate within five seconds and terminate revoked/expired/replaced streams. Silent peers have bounded heartbeat teardown.
- VNC credentials **MUST** stay in private worker/controller memory and mode-600 runtime files. The authenticated browser receives only sanitized RFB pixels; server-side protocol filtering rejects keyboard/pointer/clipboard injection on the view-only channel. Owner input stays on separate authenticated, CSRF-protected HTTP routes.
- VNC startup **MUST NOT** put passwords in process arguments. The pinned x11vnc reads a mode-600 private tmpfs password file and removes it on read; `-nosel` disables selection/clipboard exchange on this screen stream.
- Lifecycle, takeover and operations **MUST** share one per-agent queue and recheck owner, UUID generation, running state and lease at dispatch. Acknowledged takeover blocks agent input/capture. Disconnect releases only its session/viewer lease. Uncertain execution quarantines the session; never automatically replay it.

### 3. Secrets

- Secrets **MUST NOT** reach client-side code. This covers API keys, provider tokens, the encryption key, signing keys, TOTP secrets, session secrets and OAuth tokens.
  - Never put a secret in a `NEXT_PUBLIC_*` variable.
  - Modules that touch secrets **MUST** import `server-only`.
  - API responses **MUST** return only the masked `key_hint` (e.g. `••••1a2b`), never the key itself, even to the owner after it has been saved.
- Secrets **MUST NOT** reach the model. Provider keys and tool credentials are injected by the egress proxy, and **MUST NOT** appear in prompts, tool results, memory, skills or receipts. Implemented (TASK-046): `app` decrypts the saved key per request and sends it only to `egress-proxy` over the private `egress_app` network; the proxy adds it to one upstream call and never stores, logs or returns it. The proxy has no `ENCRYPTION_KEY` and no database access. It accepts only public HTTPS hosts and blocks private, loopback, link-local and metadata addresses.
- Passwords and OTPs typed for an agent **MUST** go through single-use, short-lived opaque handles that the executor resolves. They **MUST** be masked in screenshots and recordings and never persisted.
- Stored credentials **MUST** be encrypted at rest with the key from `.env`.
- `.env`, `data/` and backups **MUST NOT** be committed. `.gitignore` covers them, and CI **SHOULD** run a secret scanner.
- The desktop container **MUST NOT** mount `.env`, the database or any secret store.
- Logs and error reports **MUST NOT** contain secrets, session tokens, OTPs or full request bodies from auth routes.
- Each agent has its own canary secret (bait, not a credential). The app **MUST** check every `type` text before execution, including text split across steps and common encodings; the egress proxy **MUST** check the `CONNECT` host and plain-HTTP request line/headers before resolving or connecting. On a match the traffic **MUST** be refused, the proxy tripped, the agent's other runs cancelled, its desktop stopped, it paused with `security_stop`, and exactly one append-only `security_events` row recorded. The canary is encrypted at rest and the proxy receives only its SHA-256; no canary, matched text or host may appear in logs, cards, receipts or events. Implemented limits: HTTPS bodies/paths, chat text, owner takeover typing and provider calls are not inspected. The decoy `inbox/passwords-backup.txt` is planted once and is not recreated if deleted.

### 4. Database

- Postgres **MUST NOT** be published outside the Docker network.
- The app **MUST** connect as a least-privilege role, not the superuser. Migrations run with a separate migration role.
- Queries **MUST** go through Drizzle's parameterised query builder. Raw SQL built by string interpolation **MUST NOT** be used. Where raw SQL is unavoidable, it **MUST** use the parameterised `sql` template.
- The audit log, receipt tables, `cost_entries` and `security_events` are append-only. The app role **MUST NOT** have `UPDATE` or `DELETE` on them. `model_prices` is owner-editable through the authenticated settings route; price changes never rewrite an existing cost row.
- Sensitive columns (`providers.encrypted_key`, `connections.encrypted_token_ref`, `traveller_profiles.encrypted_blob`, TOTP secrets) **MUST** be encrypted at the application layer before storage.
- Owner scoping lives in the data-access layer (§2). Postgres row-level security **SHOULD** be added when multi-user team mode is introduced.
- Backups **MUST** be encrypted before they leave the machine.

### 5. Input

All input is untrusted until validated. This includes model output and anything an agent reads.

- All user input **MUST** be validated server-side with Zod schemas. Client-side validation is a UX convenience only.
- Model output is input too. Chat cards (`message`, `clarification`, `tool_connection`, `routine`) and action intents (`{action, target, expect}`) **MUST** be schema-validated before they are used. Invalid output is rejected and never executed.
- The page control list used for grounding (`page.snapshot`) is `web` data: names are length-limited and stripped of control characters, validated in the worker and again in the app, and shown to the model as names only, never coordinates. Password, one-time-code and other secret-looking fields and all field values are never listed, so they cannot be offered for clicking or typing by name.
- Every piece of content **MUST** carry a source tag. Only `user` content may instruct an agent. `web`, `email`, `document` and `tool` content is data only, and may change *how* a task is done, never *what* the task is.
- Implemented (TASK-049): one exported tag list (`user/agent/web/email/document/tool`) is validated on every model request; a missing or unknown tag is rejected before the provider is called. Only the owner's task part is `user`.
- Implemented (TASK-049): task scope is computed in code from the owner's task, the agent's `domains` allowlist and the first readable page host. A `type` is refused when it names a host outside that scope, an email the owner did not name, or runs on an out-of-scope page unless the whole text is one allowed URL. The refusal sends no desktop input, writes a blocked receipt and one `security_events` row, and the second refusal stops the run as `scope_blocked`. The check does not see where a click, key press or form submission goes, and owner takeover typing is not checked; the egress allowlist is the network-level backstop. Astra Mode and approvals never override scope.
- Ingested untrusted content **SHOULD** pass through the quarantined reader (a tool-less model call that returns structured data) and the injection scanner.
- Memory writes **MUST** be injection-scanned. Untrusted-origin writes to shared memory **MUST** require approval.
- Imported skills **MUST** be scanned and **MUST NOT** grant permissions.
- Generated skills are model output: the app validates a closed structured draft, renders `SKILL.md` itself, keeps drafts non-callable, and requires an explicit owner approval that grants no permissions. Approval copies only manifest-listed after-shots into the skill namespace, then deletes the capture's private artifacts; a failed cleanup leaves the skill non-callable.
- Outbound URLs chosen by an agent **MUST** pass the egress allowlist. Internal, loopback, RFC 1918 and cloud-metadata addresses (e.g. `169.254.169.254`) are always blocked.
- Text rendered in the UI **MUST** be escaped. Markdown from agents or web content **MUST** be sanitised, with no raw HTML and no `javascript:` URLs.
- Shell commands built from input **MUST** use argument arrays, never string concatenation.

### 6. APIs

- Every route handler **MUST** validate path params, query string and body with Zod. Object schemas **SHOULD** use `.strict()` to reject unknown fields.
- Request bodies **MUST** have size limits. Uploads have their own limit (§7).
- IDs **MUST** be validated for format (e.g. UUID) and then for ownership (§2).
- Responses **MUST NOT** leak stack traces, SQL errors or internal paths in production. Errors are logged server-side with a correlation ID.
- Mutating endpoints **MUST** use non-GET methods and be CSRF-protected.
- Webhooks (`POST /api/hooks/<id>`):
  - **MUST** require a high-entropy per-hook secret, compared in constant time.
  - **MUST** be rate-limited and size-limited.
  - Payloads are untrusted content (`source_tag = tool`) and **MUST NOT** be treated as instructions.
  - **SHOULD** verify provider signatures when available (e.g. GitHub `X-Hub-Signature-256`).
- Sensitive and costly endpoints (auth, Run Now, model Test, voice) **MUST** be rate-limited.
- CORS **MUST** stay same-origin only. No wildcard origins.
- Security headers **MUST** be set: a restrictive `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `frame-ancestors 'none'` (except the internal desktop view), and HSTS when served over HTTPS.

### 7. File uploads and downloads

This applies to chat attachments, Files tab uploads, and files agents download in the browser.

**File type**

- Type **MUST** be detected from content (magic bytes), not the extension or the client-supplied `Content-Type`.
- Documents, images, text, CSV/JSON, code, audio and video are allowed. Executables, scripts, installers, APKs and macro-enabled Office files are blocked by default.
- Implemented rule (TASK-023a): content decides, the extension only blocks. Blocked by content: ELF, PE, Mach-O, Java class, DEX, legacy OLE2 Office (macros cannot be ruled out), `#!` scripts, ZIP-based APK/JAR, OOXML with `vbaProject.bin`, ODF with `Basic/` or `Scripts/`. Blocked by name: `.exe .dll .msi .bat .cmd .ps1 .vbs .wsf .hta .scr .lnk .sh .apk .jar .docm .xlsm .pptm` and similar. Other source code (for example `.py`, `.js`) is accepted as plain UTF-8 text. Also recognised by content: BMP, TIFF, ICO, HEIC/AVIF, WMV/ASF, FLV, MPEG, AIFF and MIDI; a text file that only starts like one of these stays text. Unknown binary content is refused. Archives are stored as opaque files and never extracted. A ZIP64 or unreadable Office-type container is refused.
- Archives **MUST** be checked for path traversal (zip-slip) and decompression bombs before extraction.

**File size**

- The per-file limit defaults to 250 MB (`MAX_UPLOAD_MB`, 1 to 1024), enforced while streaming, before the file is fully written. The upload route is excluded from `proxy.ts` (Next would buffer 10 MB and cut the rest), so it checks owner, Origin and CSRF itself, and the writer refuses any body that is shorter or longer than the declared `Content-Length`. At most one upload per agent and two across the stack run at a time.
- The per-agent storage quota defaults to 10 GB: warn at 80%, pause writes at 100%.

**Filename**

- Filenames **MUST** be normalised (Unicode NFC) and stripped of path separators (`/`, `\`), `..`, null bytes and control characters.
- Leading dots and Windows reserved names (`CON`, `NUL`, …) **MUST** be rejected.
- Filenames **MUST** be limited to 255 bytes. Collisions are resolved by suffixing, never by overwriting.
- The final path **MUST** resolve inside the target agent's `inbox/`, checked after resolving symlinks.

**Storage and handling**

- Uploads **MUST** be written as the target agent's Linux user, into that agent's `inbox/` only.
- `Downloads/` **MUST** resolve to the canonical `/downloads/<agent-uuid>` on a `noexec,nosuid,nodev` mount. Its persistent backing path `/workspace/.system/downloads` stays behind root-only `.system`; validate the home alias and reject substitutions. `noexec` blocks direct execution, not interpreter use or copying elsewhere. Agents **MUST NOT** run downloaded files without approval, and Office macros are disabled.
- Downloads **SHOULD** be checked by SHA-256 hash against MalwareBazaar. Only the hash is sent, never the file.
- File *contents* are untrusted data (§5), even when the owner uploaded the file.
- Implemented rule (TASK-067): agent file tools run only as the agent's Linux user on plain-named, regular, single-link files opened with `O_NOFOLLOW`; reads are limited to `inbox/` (documents 50 MiB, images 4 MiB, 60,000 characters per window), deliveries only from `Downloads/` and `work/` into `outbox/` with the upload block list plus extension/content matching. Extracted text and file names are `document`/`tool` tagged untrusted data; nothing is executed. Delivery is a deliberate action (never automatic) and the final message names every delivered file.
- Implemented rule (TASK-023b): the agent's `outbox/` is read only as the agent's Linux user. Only regular, single-link files with a plain name (no separators, controls or leading dot) are carded or served; symlinks, directories, scripts by name and unknown binaries never are. A download is always `Content-Disposition: attachment` with `application/octet-stream`, `nosniff` and a `sandbox` CSP (the proxy applies a `default-src 'none'; sandbox` CSP to every `/api/*` answer), and the desktop re-checks size and SHA-256 against the card before the first byte. "Open on the agent's desktop" opens only `image` (not SVG), `pdf`, `audio`, `video` and plain `text` files whose extension matches (`.txt .md .csv .json .log` for text), in a new tab of that agent's own browser, never during a takeover. HTML, XML, SVG, Office files and archives are download-only. Residual risk: a file can still change between the hash check and the end of the stream; the owner downloads what the agent wrote.
- Previews in the web app **MUST** be served with `Content-Disposition` and `nosniff`, and from a sandboxed context for HTML, SVG and PDF, so an uploaded file can't run script in the app's origin.

### 8. Sandbox, network and browser

- Containers **MUST** run as non-root with Docker default AppArmor, no `--privileged`, and read-only system paths where possible, except the owner-approved trusted desktop setup/supervisor role in ADR-026. Seccomp **MUST** remain Docker default except for the pinned desktop profile retained from ADR-025.
- Desktop **MUST** keep cap-drop ALL, no-new-privileges, read-only root, isolated networks and unpublished ports. Its profile is derived from pinned Playwright 1.64.1 plus only the chroot operation required within Chromium's private user namespace (applied SHA256 fa1e603f170044c931a103bfbe3bac6cfc6c935bdc72408e01c4cf6425cde627). Kernel checks must still deny ordinary outer-process chroot. Chromium's namespace/PID/network and Seccomp-BPF sandbox status must be verified in the smoke test. Never substitute seccomp=unconfined, capabilities beyond ADR-026 or --no-sandbox.
- ADR-026 permits only CHOWN/DAC_OVERRIDE/SETUID/SETGID/SETPCAP/SYS_ADMIN for trusted bootstrap. Before normal operation, PID 1 and every administrative entry point **MUST** permanently drop SYS_ADMIN (including bounding), install the inherited post-setup mount/privileged-syscall filter with ABI guards, and retain only the other five capabilities. No untrusted process runs before reduction succeeds. Every agent **MUST** run as its assigned UID/GID with no supplementary groups, all capability sets zero and no-new-privileges.
- Each graphical session worker and outer browser **MUST** run as its agent UID with all capability sets zero. Chromium creates further private user namespaces: Linux resets their bounding masks, which does not grant capabilities in the desktop namespace. Verify no-new-privileges and the single-UID private mapping for inner processes. Chromium namespace helpers can retain namespace-local SYS_ADMIN and a reset bounding mask; this never authorizes capabilities in the shared desktop namespace. Tests restrict helper effective/permitted sets to that namespace-local bit, require inheritable/ambient zero, and still require all five sets zero in the desktop namespace. See the [Linux user-namespace rules](https://man7.org/linux/man-pages/man7/user_namespaces.7.html). Xvfb **MUST** require private mode-600 Xauthority in a mode-700 runtime directory, disable TCP listening and reject peer/missing cookies. Browser control **MUST** use private inherited pipes; do not open unauthenticated CDP TCP ports, including on shared container loopback.
- The session-cookie snapshot (`~/.config/chromium/eclipse-session-cookies.json`) holds login secrets, like Chromium's own `Cookies` database beside it. It **MUST** stay mode 600 in the agent's mode-700 profile directory, be written atomically (temp file, `fsync`, rename), be read with `O_NOFOLLOW` only when it is a regular file owned by the agent UID with no group/other access, and never leave the worker (not sent to the controller, app, model, receipts or logs). It is not encrypted with the master key because the desktop container **MUST NOT** hold `ENCRYPTION_KEY`; OS isolation is the protection. It is bounded to 1 MiB, 2000 cookies and 30 days. A corrupt, oversized, symlinked, wrongly owned or loose-mode snapshot is ignored and never blocks session start.
- The local session-control socket **MUST** stay beneath root-only `/run/eclipse`, mode 600, with strictly bounded start/status/stop requests. It remains trusted local owner administration; the app uses the separate authenticated controller API. Never expose the socket or arbitrary commands. Status/errors exclude cookies, private transport credentials and raw browser diagnostics. Shutdown **MUST** signal only verified session process identities as that UID, preserve profile contents, refuse ambiguous locks and confine cleanup to verified owned artifacts.
- The trusted supervisor can access agent data; it is part of the trusted computing base. Its network interface accepts only authenticated app traffic. Registry/locks stay root-only, identities are owner-scoped canonical UUIDs, provisioning is serialized, unsafe paths/state fail closed, and existing data is never recursively repaired. The runtime account views are read-only through `/etc`; only trusted administration writes their protected backing files.
- Owner-approved maintenance exception: `npm run artifacts:repair` may run a short-lived root container solely to repair the stopped app's verified, project-labeled local artifacts volume. It has no network, secrets or host mounts, a read-only root filesystem, `no-new-privileges`, and only CHOWN/DAC_OVERRIDE capabilities. It preserves content and permission modes, does not follow symlinks, and never uses `chmod 777` or privileged mode. Normal app execution remains non-root.
- All desktop and tool egress **MUST** go through the egress proxy, with per-agent default-deny domain allowlists.
- Implemented rule (TASK-045, browser only): `app` pushes each agent's `agent_policies.domains` to the proxy's memory-only registry (120 s TTL, 60 s refresh, immediate on lifecycle/run changes; a changed or blocked push closes that agent's tunnels). Chromium uses the proxy at `http://egress-proxy:4321`; the proxy accepts only `CONNECT host:443`, where the host is the entry itself or a subdomain. Plain `http://` GET/HEAD to an allowlisted host returns a `307` to HTTPS; plaintext is never forwarded. The agent is identified by `Basic` username = agent UUID and password = `HMAC-SHA256(EGRESS_DESKTOP_SECRET, "v1:" + agentId)`; the token reaches the worker only through the supervisor's private pipe and is never in argv, an environment variable, the browser or a log. `EGRESS_PROXY_SECRET` stays with `app` and the proxy; `EGRESS_DESKTOP_SECRET` stays with the desktop supervisor and the proxy. Every answer is checked against `isBlockedAddress` and the first checked address is pinned. Limits: 64 tunnels per agent, 256 total, 10 s connect, 120 s idle, 30 min lifetime. Honest limits: loopback is bypassed for the mock fixture and shared by all agents until TASK-071; HTTPS bodies are not inspected; a site that answers 401 can receive the token through Chromium's origin-auth reuse, but the token is usable only from the desktop network and grants only that agent's allowlist; a compromised browser process can still reach shared loopback and desktop-network services until TASK-071.
- Owner-approved TASK-007 actual-click exception: spike:meta-live-click uses only fresh credential-free Firefox at http://127.0.0.1:3000/ after exact placeholder verification, never personal profiles/tabs or exposed CDP. Restrict page navigation/resources to the local origin and expected static paths; block WebSockets, service workers, downloads and popups. Browser environment contains only minimal OS values and private runtime paths. One explicit invocation permits at most three Contributor requests, low reasoning, 1024 output tokens each / 3072 total, 30 seconds/request and 90 seconds active model time, no retries. Exactly one genuine point may execute after strict schema, DOM hit-test and exact scene checks. Only computer_action_requires_confirmation is eligible for specific owner review after target validation; all other checks stop. Pause up to five minutes with provider handles only in memory and a fresh run/action-scoped single-use application token. Require the matching stdin approval after the owner confirms that particular action in chat; silence/denial/stale state never approves. Recheck before input, verify closed→open and visible status, then echo the exact reviewed checks with the genuine after-image and untouched replay history/receipt. Never auto-acknowledge or execute another model action. Record execution, postcondition and acknowledgement separately, including failures after input. Exclusive private artifacts exclude credentials/raw payloads/opaque provider handles; only verified local-page before/after images and sanitized metadata may be stored. No production desktop/egress boundary changes.
- Owner-approved TASK-008 development exception: the standalone `spike:sam-screenshot` CLI may make one single-image request to the fixed HTTPS Meta Responses endpoint with explicit `--live`, a privately loaded host key only in Authorization, no redirects, a 30-second request/read deadline, an 8 MiB response cap and no retries. The noun phrase and approved screenshot are the only segmentation inputs. Preflight must bound objects, source dimensions and decoded pixels before the parser allocates rasters. Private exclusive artifacts contain sanitized geometry/statistics and validated mask PNGs only; never raw responses, encoded payloads, credentials, provider IDs or source-image copies. Invalid/empty results do not authorize actions. No personal-browser capture, input execution, model substitution or production egress bypass is permitted; free-credit data-use terms still apply.
- Owner-approved TASK-007 development exception: the standalone spike:meta-computer-use CLI may use at most two protocol requests to the fixed HTTPS Meta Responses endpoint with --live: a text-only observation request followed by the explicitly selected non-sensitive static PNG as matching computer_call_output. Preserve the genuine stateless replay receipt unchanged in memory; missing/malformed replay or any pending safety check stops continuation. Use only muse-spark-1.3-contributor, minimal reasoning, 512 output tokens per request / 1024 total, 30 seconds per request / 45 seconds total. Inject the private host key only into Authorization, refuse redirects and never retry, acknowledge checks, capture a browser or execute input. Block outgoing replay containing the private key or its base64/URI encoding. This exception does not extend to app routes, agents or production. General evidence excludes credentials, images, opaque replay handles, reasoning and raw output. Contributor training terms still apply.
- Approved TASK-007 safety diagnostics may write private safety-review.json with at most 16 sanitized, bounded provider codes/explanations, source_tag:tool and untrusted:true. Withhold credential-pattern explanations; remove terminal controls; cap explanations at 1024 characters; omit provider IDs and arbitrary fields. Original read-only probes always stop on nonempty checks. The actual-click exception above may proceed only after its specific target-validated owner review. No auto-acknowledgement; missing/malformed metadata fails closed. Review data never becomes instructions or public/app/receipt content.
- Implemented rule (TASK-043): the desktop file listener gains two authenticated, source-checked routes on its existing port: `checkpoint/put` streams one saved file to the agent's own user, and `checkpoint/aside` moves a later file into a hidden `.rewound/<uuid>/` folder. Both run as the agent's own Linux user, refuse symlinks, hard links, hidden names, `..` and absolute paths, write atomically with `O_EXCL | O_NOFOLLOW`, re-hash the body before the rename, and never delete a file. No new port, secret or mount is added.
- CDP **MUST** bind inside the desktop container only.
- Implemented rule (TASK-048): the `app` container drops all capabilities and sets no-new-privileges; every service except `postgres` follows. Compose posture is checked against the effective config (only ingress publishes `127.0.0.1:3000`; no host, privileged, Docker-socket or `.env` mounts; desktop mounts only `workspace`; secrets stay in their owning services). Cross-agent checks run as real agent users in both directions: peer `/proc` environ/mem/maps/fd/cwd/root, signals, ptrace and `process_vm_readv`, private `/tmp` runtime, X lock/socket and home/Downloads/checkpoint paths are denied, and no readable command line or environment carries a secret. Shared loopback remains an honest limitation: a peer x11vnc is reachable to the RFB handshake and the controller/file listeners answer `403 source_denied`, so this is authentication, not network isolation, until TASK-071. `/proc/*/cmdline` and process names are visible to peers.
- Agents **MUST NOT** solve CAPTCHAs, evade bot detection or skip queues. CAPTCHAs, OTPs and payment verification (3-D Secure) are handed to the owner.
- The app **MUST NOT** record anything during owner takeover unless the owner presses **Record** in teach mode. Logins, CAPTCHAs and OTP entry are never recorded.
- Implemented rule (TASK-036, managed browser): teach capture is explicit consent separate from takeover; ordinary takeover records nothing. Capture requires the current owner session/viewer/generation/lease and stops on handback, lease/session loss, agent stop or worker failure; reconnect never resumes it. Only the selected managed browser viewport is captured. Frames are masked in memory before screenshots/encoder/storage, and typed text, clipboard, printable keys and opaque handles are never persisted. Capture pauses on login/password/OTP/CAPTCHA, dialogs, uninspectable frames/shadow roots and unsupported surfaces; Resume repeats the gate. Optional narration is opt-in and sent only to the fixed Meta ASR endpoint through the egress proxy after Stop; transcripts are untrusted and never instructions. Recordings stay owner-only in `artifacts/teach/<owner>/<capture>/`, are served only by manifest-checked owner routes, and are never mounted into `desktop`. The saved-recording list is owner+agent scoped, exposes only counters, status and timestamps, and cannot widen artifact access. Discard deletes that private namespace and keeps only a minimal discarded row for append-only cost attribution. Native desktop/terminal capture is owner-deferred for v1 and is not implemented by this rule.

### Mock vendor fixture boundary (TASK-035)

- The separately served desktop-local mock site **MUST** contain synthetic invoice data only, never app sessions, real credentials, private files or a database connection. It does not add a public route or authentication exception to the app.
- The fixture **MUST** bind only ephemeral loopback as the selected unprivileged agent with the existing sanitized launch environment; it **MUST NOT** publish a host port, change network controls or fetch outbound resources. Shared loopback before TASK-071 is an explicit limitation; no cross-agent confidentiality is claimed for these fictional invoices.
- Fixed routes, strict Zod queries/control bodies, duplicate-field rejection, bounded requests/connections/timeouts, exact Host/Origin, process-local CSRF and restrictive local-only CSP **MUST** protect demo controls. No GET mutation, path-based file serving, uploads or arbitrary URLs. PDF downloads contain owned fixed fixture text with fixed attachment names.
- Start/status/stop **MUST** reject symlinked/loosely owned state, scope state to the agent's private directories and verify UID, PID birth and exact executable/arguments before signaling. During verified termination, an empty command line may be a process-exit transition: wait without further signals, never adopt or kill by port. Stop/reset **MUST NOT** remove downloaded invoices or unrelated files/processes.
- The fixture's layout change is a test input, not evidence of self-healing, replay, receipts or tripwire behavior. QA **MUST** use isolated synthetic agents and preserve the owner stack.

### 9. Integrity and audit

- Every agent step **MUST** produce a hash-chained receipt. Runs are signed with the install's Ed25519 key, and the private key **MUST** stay on the host.
- Implemented rule (TASK-029/030): with no valid `RECEIPT_SIGNING_KEY` the agent does not run, and a run that cannot store a receipt stops. Receipts never contain typed text (only its length), file contents, page values, model reasoning or credentials; page text is bounded and stripped of control characters. The seed lives only in `.env` and the `app` environment, and only the public fingerprint is ever printed. The app role can INSERT and SELECT `steps` but not UPDATE or DELETE them. An export contains the task text and control names, so treat it as owner data. The signature detects changes made after signing; it does not defend against a compromised `app`, which holds the key. Verifiers should pin the fingerprint (`eclipse-crew verify --key-id`).
- Implemented rule (TASK-031): screenshots shown in History are stored only in the local `artifacts` volume, as PNG files named by their SHA-256 (`<artifacts>/blobs/ab/<hash>`, directories mode 700, files mode 600, written to a temp name and renamed, re-hashed on every read). They can contain private page content and are served only by `GET /api/runs/[runId]/evidence/[hash]`: owner session, the hash must be listed as before/after evidence of that owner's own run (otherwise the same 404 as an unknown run), `image/png`, `nosniff`, a sandbox CSP, never inserted as HTML. Only a validated 64-character hex name ever reaches the filesystem. The History view recomputes `verifyRunExport` on load and shows a failure with its reason code; the SAM outline is an unsigned display annotation. Run exports contain the task text and control names and are owner data.
- Implemented rule (TASK-043): a rewind never updates or deletes the original run, its receipts or its checkpoints. It writes only files owned by the agent, through the restore tool above, and a failed restore starts no run. The new run is a separate signed run whose header names `branch_of`/`branch_at`, so a branch cannot be silently re-parented. The owner correction is owner content, bounded to 600 characters and validated server-side; checkpoint state is the existing strict 256 KiB schema.
- Implemented rule (TASK-032): per-step checkpoints copy the agent's own files (`inbox`, `work`, `downloads`, `outbox`) into the same local artifacts store. The desktop side runs as the agent's own Linux user, so another agent's home is unreadable by construction; it lists only plain-named regular single-link files, refuses symlinks, devices, FIFOs, hidden names and any path with `..`, `/` or control characters, opens with `O_NOFOLLOW`, and never returns absolute paths. The app re-hashes every body it receives and drops one that does not match its manifest hash. `artifacts` is not mounted into `desktop`. The checkpoint state holds only what the model already sees (never typed text, screenshots, document contents, keys or tokens) and is validated with Zod before it is stored or read back. Checkpoint rows are insert-only for the app role. Files above 4 MiB are recorded by name and size only. Agent files may contain private data and now also exist in the artifacts volume; back it up and protect it like the workspace volume.
- Security-relevant events **MUST** be written to the signed, append-only audit log and shown in the Security Center. These include logins, permission changes, Astra Mode toggles, approvals, tripwire hits and blocked actions.
- Kill switches (stop one agent, stop the whole crew) **MUST** work even when the job queue is stalled.

### 10. Dependencies and supply chain

- Dependencies **MUST** use exact versions with a committed lockfile. New dependencies need a reason in the PR.
- Base Docker images **SHOULD** be pinned by digest.
- CI **SHOULD** run `npm audit` (or equivalent) and a secret scanner on every PR.
- MCP servers **MUST** be allowlisted and version-pinned.
- Third-party model weights (e.g. SAM 3.1) **MUST NOT** be shipped in our images. They are downloaded on the user's machine under their own license, with checksums verified.

---

## Desktop verification boundary (TASK-028)

- `page.verify` is a closed read-only operation dispatched through the same owner, generation and takeover checks as snapshots. It accepts only exact visible-control predicates and URL paths, never selectors, JavaScript or arbitrary network destinations.
- Verification snapshots include bounded control names/roles/geometry and focus only when the document has focus. Sensitive fields and all field values remain excluded; no screenshot/check is dispatched during takeover.
- Model observations are untrusted, schema-validated evidence. Disagreement or unknown evidence blocks input; a model verdict cannot override a supported failed DOM postcondition. A fresh snapshot rechecks the target before input; this is not atomic with the website and does not guarantee the absence of external side effects.
- SAM and visual-provider calls use authenticated egress transport only, with request/response/decode bounds and no automatic retry. No keys enter the model, browser or verification evidence. Step evidence is recorded in the step's receipt (TASK-029) as method, status and fixed code only.

## Contributor checklist

Before opening a PR that touches routes, data, agents or files:

- [ ] New routes require an owner session (or a documented exception) and validate params, query and body with Zod.
- [ ] Queries are scoped by `owner_id`, and IDs from the client are ownership-checked.
- [ ] No secret is reachable from client code, model context, logs or receipts.
- [ ] No raw SQL built by string interpolation.
- [ ] Model output and untrusted content are schema-validated and source-tagged before use.
- [ ] File handling checks type by content, size and filename, and writes only inside the agent's own home.
- [ ] New agent capabilities are default-deny and covered by policy checks and receipts.
- [ ] Tests cover the denied path, not just the allowed one.
