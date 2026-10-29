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

- Every page, API route, SSE stream and WebSocket (including the noVNC desktop stream) **MUST** require a valid owner session. The only exceptions are:
  - `/login`
  - `/setup`, and only until the owner account exists. After that it **MUST** return 404 permanently.
  - `POST /api/hooks/<id>`, which is authenticated by its per-hook secret token instead (see §6).
  - an unauthenticated health check that returns no data.
- Authentication **MUST** be enforced server-side, in middleware *and* inside each handler. Hiding UI elements is not access control.
- Passwords **MUST** be hashed with argon2id and never stored or logged in plain text.
- Session cookies **MUST** be `Secure` (when served over HTTPS), `HttpOnly`, `SameSite=Lax` or stricter, and backed by a server-side session record so they can be revoked.
- State-changing requests **MUST** have CSRF protection.
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
- "Always allow" grants **MUST** be scoped to agent + site + action (+ optional limit). They **MUST NOT** be global.
- Approval checks **MUST** look at action arguments, not only tool names. For example, `send_email` to a new recipient escalates.
- Astra Mode removes approval prompts only. Receipts, audit log, budgets, tripwire, token isolation and the block on out-of-scope data exfiltration after untrusted content **MUST** stay on.

**Internal services**

- `desktop-controller`, Postgres, CDP, VNC and the job queue **MUST NOT** be published to the host. They live on the internal Docker network only.
- `desktop-controller` **MUST** accept requests only from `app`, authenticated with an internal shared secret. Network placement alone is not enough.

### 3. Secrets

- Secrets **MUST NOT** reach client-side code. This covers API keys, provider tokens, the encryption key, signing keys, TOTP secrets, session secrets and OAuth tokens.
  - Never put a secret in a `NEXT_PUBLIC_*` variable.
  - Modules that touch secrets **MUST** import `server-only`.
  - API responses **MUST** return only the masked `key_hint` (e.g. `••••1a2b`), never the key itself, even to the owner after it has been saved.
- Secrets **MUST NOT** reach the model. Provider keys and tool credentials are injected by the egress proxy, and **MUST NOT** appear in prompts, tool results, memory, skills or receipts.
- Passwords and OTPs typed for an agent **MUST** go through single-use, short-lived opaque handles that the executor resolves. They **MUST** be masked in screenshots and recordings and never persisted.
- Stored credentials **MUST** be encrypted at rest with the key from `.env`.
- `.env`, `data/` and backups **MUST NOT** be committed. `.gitignore` covers them, and CI **SHOULD** run a secret scanner.
- The desktop container **MUST NOT** mount `.env`, the database or any secret store.
- Logs and error reports **MUST NOT** contain secrets, session tokens, OTPs or full request bodies from auth routes.
- Each agent has its own canary secret. If one appears in outbound traffic, the session **MUST** be killed and a `security_event` recorded.

### 4. Database

- Postgres **MUST NOT** be published outside the Docker network.
- The app **MUST** connect as a least-privilege role, not the superuser. Migrations run with a separate migration role.
- Queries **MUST** go through Drizzle's parameterised query builder. Raw SQL built by string interpolation **MUST NOT** be used. Where raw SQL is unavoidable, it **MUST** use the parameterised `sql` template.
- The audit log and receipt tables are append-only. The app role **MUST NOT** have `UPDATE` or `DELETE` on them.
- Sensitive columns (`providers.encrypted_key`, `connections.encrypted_token_ref`, `traveller_profiles.encrypted_blob`, TOTP secrets) **MUST** be encrypted at the application layer before storage.
- Owner scoping lives in the data-access layer (§2). Postgres row-level security **SHOULD** be added when multi-user team mode is introduced.
- Backups **MUST** be encrypted before they leave the machine.

### 5. Input

All input is untrusted until validated. This includes model output and anything an agent reads.

- All user input **MUST** be validated server-side with Zod schemas. Client-side validation is a UX convenience only.
- Model output is input too. Chat cards (`message`, `clarification`, `tool_connection`, `routine`) and action intents (`{action, target, expect}`) **MUST** be schema-validated before they are used. Invalid output is rejected and never executed.
- Every piece of content **MUST** carry a source tag. Only `user` content may instruct an agent. `web`, `email`, `document` and `tool` content is data only, and may change *how* a task is done, never *what* the task is.
- Ingested untrusted content **SHOULD** pass through the quarantined reader (a tool-less model call that returns structured data) and the injection scanner.
- Memory writes **MUST** be injection-scanned. Untrusted-origin writes to shared memory **MUST** require approval.
- Imported skills **MUST** be scanned and **MUST NOT** grant permissions.
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
- Archives **MUST** be checked for path traversal (zip-slip) and decompression bombs before extraction.

**File size**

- The per-file limit defaults to 250 MB (configurable), enforced while streaming, before the file is fully written.
- The per-agent storage quota defaults to 10 GB: warn at 80%, pause writes at 100%.

**Filename**

- Filenames **MUST** be normalised (Unicode NFC) and stripped of path separators (`/`, `\`), `..`, null bytes and control characters.
- Leading dots and Windows reserved names (`CON`, `NUL`, …) **MUST** be rejected.
- Filenames **MUST** be limited to 255 bytes. Collisions are resolved by suffixing, never by overwriting.
- The final path **MUST** resolve inside the target agent's `inbox/`, checked after resolving symlinks.

**Storage and handling**

- Uploads **MUST** be written as the target agent's Linux user, into that agent's `inbox/` only.
- `Downloads/` **MUST** be mounted `noexec`. Agents **MUST NOT** run downloaded files without approval, and Office macros are disabled.
- Downloads **SHOULD** be checked by SHA-256 hash against MalwareBazaar. Only the hash is sent, never the file.
- File *contents* are untrusted data (§5), even when the owner uploaded the file.
- Previews in the web app **MUST** be served with `Content-Disposition` and `nosniff`, and from a sandboxed context for HTML, SVG and PDF, so an uploaded file can't run script in the app's origin.

### 8. Sandbox, network and browser

- Containers **MUST** run as non-root with Docker's default seccomp/AppArmor profiles, no `--privileged`, and read-only system paths where possible.
- All desktop and tool egress **MUST** go through the egress proxy, with per-agent default-deny domain allowlists.
- CDP **MUST** bind inside the desktop container only.
- Agents **MUST NOT** solve CAPTCHAs, evade bot detection or skip queues. CAPTCHAs, OTPs and payment verification (3-D Secure) are handed to the owner.
- The app **MUST NOT** record anything during owner takeover unless the owner presses **Record** in teach mode. Logins, CAPTCHAs and OTP entry are never recorded.

### 9. Integrity and audit

- Every agent step **MUST** produce a hash-chained receipt. Runs are signed with the install's Ed25519 key, and the private key **MUST** stay on the host.
- Security-relevant events **MUST** be written to the signed, append-only audit log and shown in the Security Center. These include logins, permission changes, Astra Mode toggles, approvals, tripwire hits and blocked actions.
- Kill switches (stop one agent, stop the whole crew) **MUST** work even when the job queue is stalled.

### 10. Dependencies and supply chain

- Dependencies **MUST** use exact versions with a committed lockfile. New dependencies need a reason in the PR.
- Base Docker images **SHOULD** be pinned by digest.
- CI **SHOULD** run `npm audit` (or equivalent) and a secret scanner on every PR.
- MCP servers **MUST** be allowlisted and version-pinned.
- Third-party model weights (e.g. SAM 3.1) **MUST NOT** be shipped in our images. They are downloaded on the user's machine under their own license, with checksums verified.

---

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
