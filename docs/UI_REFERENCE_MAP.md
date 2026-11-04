# UI Reference Map

Maps every supplied reference image (`designs/Eclipse_Crew_NN_*.png`) to its implemented surface, and every implemented surface back to its reference. Established 2026-11-03 by the approved prompt `prompts/2026-11-03-ui-reference-alignment.md`. Images 34–38 are system sheets: standards applied across the whole app, not standalone pages. Status values: **Matched** (implemented and aligned), **Partial** (implemented, named gaps below), **Gap** (no implemented surface; named functional gap, intentionally not faked).

## Forward map: image → implementation

| Image | Reference view | Implemented surface | Status |
|---|---|---|---|
| 01 Model Connection Setup | Setup step 3 | `app/setup` → `app/setup/setup-form.tsx` (model step) | Matched |
| 02 Agents List | Agents page: table, selected agent, crew overview | Workspace agent list in the app sidebar (`components/workspace/agent-pane.tsx`); selected-agent heading and actions in the workspace center. A standalone `/agents` table page does not exist (single-workspace app); the sidebar + workspace is the destination. Crew status aggregates are available through the crew status API and Mission Control. | Partial |
| 03 Agent Settings | Agent settings page | Workspace center → Settings tab (`components/workspace/agent-settings.tsx`, `astra-settings.tsx`, `agent-form.tsx`) | Matched |
| 04 Live Desktop | Expanded desktop view | `components/desktop/expanded-view.tsx` (right column: Live desktop, Current task, Control safety) | Matched |
| 05 Chat Workspace | Workspace: agent heading, central tabs, chat, desktop column | `app/page.tsx` → `components/workspace/workspace-shell.tsx`, central tabs (`components/workspace/workspace-center.tsx`), `components/chat/chat-pane.tsx`, desktop column (`components/workspace/desktop-column.tsx`) | Matched |
| 06 Skills Library | Skills table + skill details | **Gap:** v1 has no skills library backend or route. Skills exist only as teach recordings (`TeachControls` → `components/teach/skill-review.tsx`) and heal proposals. Nav entry intentionally omitted rather than dead. | Gap |
| 07 Record Skill | Recording overlay panel | `components/desktop/teach-controls.tsx` (recording state, timer, captured steps, stop) | Partial — panel lives inline above the stream, not as the right-column overlay; steps list shows captured events once saved, not a live ticking list (capture events stream server-side). |
| 08 Runs History | Runs table + selected run + branch relationship | `/mission-control` Runs section (`components/jobs/jobs-dashboard.tsx`) crew-wide (`/jobs` redirects there); per-agent History tab (`components/history/history-panel.tsx`, `run-list.tsx`) | Matched |
| 09 Run Detail | Run detail: timeline, step proof, receipt | `/jobs/[runId]` (`components/jobs/job-detail.tsx`); per-step receipts in `history/step-row.tsx` | Matched |
| 10 Rewind and Branch | Rewind wizard | `components/history/rewind-dialog.tsx` (checkpoint picker, correction, branch preview, external-side-effect warning) | Matched |
| 11 Schedules | Routines table + details + recent executions | `/schedules` (left nav): upcoming routines (`upcoming-runs.tsx`); routine cards + actions in chat (`chat-card.tsx`, `routine-card-actions.tsx`, `routine-run-now.tsx`). Routines are still created and confirmed in chat per TASK-038. | Matched |
| 12 Memory | Memory documents view | Workspace center → Memory tab (`components/memory/memory-panel.tsx`, `document-view.tsx`, `entry-form.tsx`) | Matched |
| 13 MCP Servers | Connections page | `/settings/connections` → `app/settings/connections/mcp-settings.tsx` (+ `connections-settings.tsx`, `composio-settings.tsx`); left nav now labels it Connections | Matched |
| 14 Models | Model roles + price table | `/settings/models` → `app/settings/models/model-settings.tsx`, `price-table.tsx`, `background-model.tsx` | Matched |
| 15 Account | Profile page | `/profile` (header chip + tablet rail; `/settings/account` redirects) → `app/settings/account/account-settings.tsx` | Matched |
| 16 Security Center | Security events, audit log, controls | `/security` → `components/security/security-center.tsx` | Matched |
| 17 Jobs Dashboard | Runs table + selected job + crew actions | `/mission-control` Runs section (`jobs-dashboard.tsx`, `jobs-table.tsx`, `job-detail.tsx`, `job-actions.tsx`) | Matched |
| 18 Upcoming Runs | Day-grouped upcoming list | `/schedules` → `components/jobs/upcoming-runs.tsx` | Matched |
| 19 Skill Review | SKILL.md review | `components/teach/skill-review.tsx` (opened from teach recordings in the desktop controls) | Matched |
| 20 Expanded Proof Receipt | Before/after evidence, verification, integrity | `/jobs/[runId]` step proof + `history/step-row.tsx` expansion (thumbnails, SHA-256, signature). A standalone proof route is a gap; the same data is in run detail. | Partial |
| 21 Owner Account Setup | Setup step 1 | `app/setup` → `app/setup/setup-form.tsx` (owner step) | Matched |
| 22 Timezone Setup | Setup step 2 | Timezone is completed elsewhere in setup; it is not a separate wizard step. | Partial |
| 23 Create First Agent | Setup step 4 | First agent creation is completed elsewhere in setup; it is not a separate wizard step. | Partial |
| 24 Login | Sign-in card | `app/login` → `app/login/login-form.tsx` | Matched |
| 25 Self-Healing Skill Update | Skill diff review | `components/heal/skill-update-review.tsx` (chat card + saved replay review) | Matched |
| 26 Action Approval | Needs-you approval card in chat | `chat-card.tsx` approval card + `components/approvals/approval-actions.tsx` | Matched |
| 27 Enable Astra Mode | Astra confirmation modal | `components/workspace/astra-settings.tsx` | Matched |
| 28 Delete Agent | Delete confirmation with backup + typed confirm | `components/workspace/agent-form.tsx` delete dialog (`modal-dialog.tsx`) | Matched |
| 29 Memory Change Approval | Proposed change + diff | `components/memory/change-requests.tsx`, `change-actions.tsx`, `diff-view.tsx` | Matched |
| 30 Memory Version History | Version list + comparison | `components/memory/history-view.tsx` | Matched |
| 31 Connect Tool | Add MCP connection modal | `mcp-settings.tsx` add-connection dialog | Matched |
| 32 Routine Confirmation | Confirm routine modal | Routine card + `routine-card-actions.tsx` confirm flow in chat | Matched |
| 33 File Preview | File preview dialog with inline document | Chat file card + `components/chat/file-card-actions.tsx` (Download / Open on agent desktop). Inline in-app document rendering is a gap (v1 opens the file via the agent's desktop or downloads). | Partial |
| 34 Foundations | Color, type, spacing sheet | Standard — applied app-wide via `app/globals.css` tokens and `docs/DESIGN.md` | Matched |
| 35 Controls | Buttons, inputs, tabs, focus | Standard — `components/ui/*`, all forms and tab lists | Matched |
| 36 Workspace Components | Agent rows, chat blocks, progress, desktop toolbar, context cards | Standard — agent pane rows, chat cards/rows, live run card, desktop controls, routine/clarification/tool cards | Matched |
| 37 Evidence & Safety | Receipt rows, SAM outline, approvals, security events, diffs | Standard — history step rows, receipts, approval cards, security center, diff views | Matched |
| 38 State Patterns | Loading, empty, error, needs-you, operational | Standard — per-pane loading/empty/error states, needs-you surfacing (avatar ring + chat card + toast), budget banners | Matched |
| 39 Workspace 1280 | Full sidebar at 1280 | `app-shell` sidebar shown in full at ≥1280 px (resolves the old collapsed-rail conflict in favor of this image) | Matched |
| 40 Workspace 768 Sheet | 768–1279 rail + sheets | `workspace-shell.tsx` tablet rail + accessible sheets | Matched |
| 41 Mobile Chat + Action Approval | Mobile chat with approval card | Workspace mobile view: chat + approval card usable at 375 px | Matched |
| 42 Mobile Skill Diff Review | Mobile skill update | `skill-update-review.tsx` usable at 375 px (opened from chat) | Matched |
| 43 Mobile Jobs List | Mobile runs list | `/mission-control` Runs at 375 px (search, filters, run rows) | Matched |
| 44 Mobile Desktop View Only | View-only mobile desktop | `live-view.tsx` / `expanded-view.tsx` view-only on phones (takeover eligibility rule below) | Matched |

## Takeover eligibility (supersedes width-based rules)

Takeover is an **input-policy check, not hardware attestation and not a server authorization boundary** (existing owner/lease/CSRF guards remain authoritative; RFB stays view-only). Implemented in `components/desktop/use-takeover-eligibility.ts`:

- Starts view-only. Uses `(any-pointer: fine)` only as a capability hint.
- Enables **Take over** only after, in the current viewer session: one trusted (`isTrusted`) mouse pointer action **and** one trusted non-composing keyboard event, collected on the takeover control itself. The check forwards nothing to the desktop, saves no key values, and never grants a lease by itself.
- Touch-only phones/tablets/laptops stay view-only. Mouse alone or keyboard alone does not pass. A device that demonstrates both can take over at any width.
- Remote pointer forwarding accepts only real mouse pointers (`pointerType === "mouse"`); touch/pen and their compatibility mouse events are ignored for the remote desktop, while app controls (Hand back, tabs, nav) remain touch-usable.
- Evidence resets on stream disconnect, page resume without evidence re-confirmation, or observed capability loss; queued input and new input are blocked immediately, recording stops and the lease is released. On failed release an accessible Hand back/recovery path remains. Resize alone never revokes eligibility.

## Reverse map: surface → reference

| Surface | Reference(s) |
|---|---|
| `app-shell.tsx` (sidebar nav, header, search, owner chip, footer) | 02, 39, 40, 41–44 headers; sheet 35 |
| `agent-pane.tsx` (sidebar agent list) | 02 list portion; sheets 34–36 |
| `workspace-center.tsx` (central tabs) | 05, 39; sheets 35–36 |
| `chat-pane.tsx`, `chat-card.tsx`, `live-run-card.tsx` | 05, 26, 33, 36, 41 |
| `desktop-column.tsx` (stream + activity + summary) | 05, 39 right column |
| `agent-settings.tsx`, `agent-form.tsx`, `astra-settings.tsx` | 03, 27, 28 |
| `live-view.tsx`, `expanded-view.tsx`, `teach-controls.tsx` | 04, 07, 44 |
| `history-panel.tsx`, `run-list.tsx`, `run-timeline.tsx`, `step-row.tsx`, `rewind-dialog.tsx` | 08–10, 20, 37 |
| `memory-panel.tsx` + memory components | 12, 29, 30 |
| `/mission-control` Runs + jobs components (`/jobs` redirects; `/jobs/[runId]` detail stays) | 08, 09, 11, 17, 18, 43 |
| `/security` (`security-center.tsx`) | 16, 37 |
| `/settings/models`, `/settings/connections` (+ `/profile`) | 14, 13, 15, 31 |
| `/setup`, `/login` | 01, 21–24 |
| `skill-update-review.tsx`, `skill-review.tsx` | 19, 25, 42 |
| `approval-actions.tsx` | 26, 37, 41 |
| Loading/empty/error/needs-you states across all surfaces | 38 |

## Named gaps (functional, not styling)

- **Skills library (06):** no skills table/route in v1; skills live inside teach recordings and heal proposals. The nav omits a dead Skills entry.
- **Inline file preview (33):** v1 offers Download and Open on the agent's desktop, not in-app document rendering.
- **Global search (header):** the palette searches agents (existing data) and links to the existing run search (Mission Control Runs) and `/security` event search; there is no cross-cutting search API. Its supported scope is named in the UI.
- **Live step list while recording (07):** captured events are listed from saved state; no live event stream endpoint exists.
- **Tools/Routines central tabs:** static empty states link to Connections and Jobs; they do not render per-agent grants or routines.
