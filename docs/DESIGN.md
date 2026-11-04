# Design System

How Eclipse Crew looks and feels. Every screen uses these tokens and components; nothing is styled ad hoc.

<!--
Rules for AI agents:
- Use only the tokens and components below. No new colours, radii, shadows, fonts or font sizes.
- Build with Tailwind + shadcn/ui + Lucide (ADR-002). Map tokens through the CSS variables in "Implementation".
- Never use: gradients, gradient text, glows, glass/blur as decoration, coloured left/right borders thicker than 1px, eyebrow labels above headings, purple/indigo accents.
- If a screen needs something not covered here, ask the owner and add it to this file first.
-->

## Style

The idea is an eclipse: a black disc with a thin ring of light around it.

- **Monochrome first.** Near-black surfaces, white text, thin grey borders. Hierarchy comes from type weight, spacing and contrast, not colour.
- **One warm accent, used rarely.** `corona` gold means one thing: **you are needed** (an approval, a hand-off, a budget limit, or you're in control of a screen). When nothing needs you, the screen has no gold on it.
- **Quiet and precise.** No gradients, glows or decorative effects. Separate surfaces with 1 px borders and small background shifts.
- **Smooth.** Short, eased transitions on everything interactive. Nothing bounces.
- **Dense but calm.** A power-user workspace: small type, tight groups, generous separation between groups.
- **Dark only in v1.**

## Typography

| Use | Font |
|---|---|
| UI and body | **Geist Sans** |
| Code, hashes, IDs, costs, token counts, timestamps, model IDs | **Geist Mono** |

Load both with `next/font` (Geist is SIL OFL). Fallback: `system-ui`, `ui-monospace`. Mono is only for code, data and measurements, never as decoration.

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `text-xs` | 12 / 16 | 400–500 | Badges, table meta, timestamps |
| `text-sm` | 14 / 20 | 400 | Default UI and chat text |
| `text-base` | 16 / 24 | 400 | Long-form reading (skills, memory) |
| `text-lg` | 18 / 28 | 600 | Panel titles |
| `text-2xl` | 24 / 32 | 600 | Page titles |
| `text-4xl` | 36 / 40 | 600 | Setup wizard heading only |

- Headings use `tracking-tight` and `text-wrap: balance`. Body uses normal tracking.
- More space above a heading than below it.
- Changing or compared numbers (costs, tokens, durations, counts) use `tabular-nums`.
- Long text (chat, skills, memory) is capped at about 70 characters per line.

## Colors

All text pairings meet WCAG 2.2 AA on their intended background.

**Surfaces and text**

| Token | Hex | Use |
|---|---|---|
| `background` | `#000000` | App background |
| `surface` | `#0A0A0A` | Panes, cards, inputs |
| `surface-hover` | `#141414` | Hovered and selected rows |
| `surface-raised` | `#1A1A1A` | Menus, popovers, modals, tooltips |
| `border` | `#242424` | Card and pane dividers |
| `border-strong` | `#333333` | Hovered cards, selected items, table header lines |
| `border-input` | `#666666` | Input and checkbox outlines (3:1 contrast) |
| `text` | `#EDEDED` | Primary text, focus ring, links |
| `text-muted` | `#A1A1A1` | Secondary text, labels |
| `text-subtle` | `#878787` | Placeholders, hints, timestamps |

**Accent and status**

| Token | Hex | Use |
|---|---|---|
| `primary` | `#EDEDED` (text `#0A0A0A`) | Primary buttons |
| `corona` | `#F2C46D` (text on fill `#0A0A0A`) | **You're needed:** approvals waiting, agent waiting for you, budget at 80%, takeover active, SAM highlight in receipts |
| `success` | `#3FB950` | Verified steps, passed checks, succeeded jobs |
| `danger` | `#FF6166` | Error text, failed steps, tripwire events |
| `danger-solid` | `#CD2B31` (text `#FFFFFF`) | Destructive buttons, **ASTRA MODE** badge |

- There is no separate warning colour: anything that needs the owner's attention uses `corona`.
- "Running" and "live" are shown as a green `success` chip with a dot (per the reference images); "Needs you", budget and takeover states use `corona`. A takeover border remains `corona`.
- Links are `text` with an underline (`underline-offset-4`); no coloured link text.
- Status colour is never the only signal: always pair it with an icon or label (✓ Verified, ✕ Failed, "Needs you").
- Tinted backgrounds (badges, banners) use the colour at 12% opacity with the full colour for text.

**Owner avatar palette** (owner-approved 2026-11-04)

The owner's initials avatar (header chip, owner chat rows) follows the DiceBear "Initials" style (CC0 1.0): a flat circular fill picked by hashing the login, with the owner's real initials in `#0A0A0A` at 60% opacity, Geist regular at half the avatar size, and a 1 px `border`. These fills are used **only** for this avatar, never for status, buttons or text.

| Fill | Hex |
|---|---|
| Green | `#43AA8B` |
| Blue | `#4D96FF` |
| Purple | `#B57BFF` |
| Pink | `#FF5D8F` |
| Amber | `#FFB703` |

Agent avatars are the 12 voxel bot SVGs in `public/avatars/voxel/` on a `surface-hover` circle with a `border` ring.

## Spacing and layout

- 4 px base unit. Use Tailwind steps `1, 2, 3, 4, 6, 8, 12, 16` only.
- Padding: controls `px-3`, cards `p-4`, panels `p-6`.
- Tight inside a group (`gap-2`), clear between groups (`gap-6` or more).

**App shell (per `designs/Eclipse_Crew_02/05/39`)**

| Region | Width |
|---|---|
| Left sidebar | 260 px at ≥ 1280 px (full, image 39 — the earlier collapsed-rail-at-1280 idea is superseded by image 39). Contains the "Eclipse Crew" wordmark, app navigation, the agent list and the "Self-hosted · Secure workspace" footer. |
| Top header | Global search (Ctrl K), New Agent, and the owner chip with timezone. |
| Workspace center | Agent heading with avatar, name, role and status chip; below it the central tabs Chat / Settings / Tools / Routines / History / Memory; then the active tab's content (chat column max 720 px). |
| Workspace right column | Live desktop stream with Take over / Full screen, then Current activity and Run summary cards. One stream is shared across tabs and the expanded view. |

Panes and the sidebar are separated by 1 px `border` lines, not by cards or gaps.

**Breakpoints**

| Width | Layout |
|---|---|
| ≥ 1280 px | Full sidebar + workspace center + right column |
| 768–1279 px | 56 px rail (logo mark, agent initials, settings) with the agent list and panel opening as sheets; header shows the page title, search and owner chip |
| < 768 px | Header with back navigation, search icon and owner chip; every page shows the same bottom dock (Agents, Chat, Panel, Menu burger) — the workspace switches views in place, other pages link back via `?view=`; the Menu burger opens a bottom sheet listing all app pages; other pages stack with the same header |

Test at 375, 768, 1280 and 1440 px. On phones, approvals, skill diffs and the Jobs list must be fully usable; the live desktop is view-only unless the takeover input check passes (keyboard plus mouse/trackpad — see Takeover).

## Radius, borders and elevation

| Element | Radius |
|---|---|
| Buttons, inputs, badges, chips | 6 px (`rounded-md`) |
| Cards, chat cards, table containers | 8 px (`rounded-lg`) |
| Modals, sheets, live desktop frame | 12 px (`rounded-xl`) |
| Status dots, avatars | Full |

- Borders are always 1 px.
- Never nest a card inside a card. Group inside a card with spacing and dividers.
- Shadows only on floating layers (menus, popovers, modals, toasts): `0 8px 30px rgba(0,0,0,0.5)` plus a 1 px `border`.

## Motion

| Token | Duration | Use |
|---|---|---|
| `fast` | 150 ms | Hover, press, colour and border changes |
| `base` | 200 ms | Menus, popovers, tooltips, tab switches |
| `slow` | 300 ms | Sheets, modals, panel resize |

- Easing: `cubic-bezier(0.16, 1, 0.3, 1)` (exponential ease-out) for entering, `ease-in` for leaving.
- Animate `opacity`, `transform`, `filter` and colours. Never animate layout size.
- Menus and modals fade in from a 4 px offset with a slight blur-to-sharp; sheets slide in from their edge.
- New chat messages and receipt steps fade in. Streaming text appears without a typing animation.
- **Signature moment:** when an agent starts needing you, its avatar gets a thin `corona` ring that fades in over 600 ms, then holds still. This is the only decorative animation in the app.
- `prefers-reduced-motion`: drop movement and blur, keep only short fades.

## Icons

- Lucide only, 16 px in UI and 20 px in empty states, stroke 1.5, `currentColor`.
- Icon-only buttons need an `aria-label` and a tooltip.

## Buttons

| Variant | Look | Use |
|---|---|---|
| **Primary** | `primary` background, dark text; hover slightly dimmer | The one main action per view (Confirm, Approve, Save) |
| **Secondary** | `surface` background, 1 px `border-strong`, `text`; hover `surface-hover` | Other actions (Cancel, Test, Export) |
| **Ghost** | No background; hover `surface-hover` | Toolbars, icon buttons, table row actions |
| **Destructive** | `danger-solid` background, white text | Delete, Deny, Stop agent, Stop crew, Enable Astra Mode |
| **Link** | `text`, underlined | Inline navigation |

- Sizes: `sm` 28 px high, `md` 32 px (default), `lg` 40 px (setup wizard). Minimum hit area 24 × 24 px.
- Labels name the action ("Approve purchase", not "OK").
- Loading: keep the label, add a 14 px spinner and disable the button. Never change its width.
- Destructive actions that can't be undone open a confirmation dialog that names what will be removed.

## Components

**Base card:** `surface` background, 1 px `border`, `rounded-lg`, `p-4`. Hover (when clickable): `border-strong`. Use cards for chat cards and settings groups only; lists and tables are not cards.

| Component | Rules |
|---|---|
| **Chat rows and cards** | Ordinary owner and agent messages are **unboxed rows**: a circular avatar on the left, "Name · time" on one line, then the plain text (sheet 36: "rows, not nested cards"). Content that is an action stays carded: file cards, routine cards, clarification cards, approval cards, memory cards, live-run steps — each with the card's own title, a Lucide icon left of the title and right-aligned action buttons at the bottom. A finished run shows a compact summary chip row (steps · status, cost · duration). |
| **Status chip** | Small rounded chip: green dot + label for Running/Verified/Connected/Approved; neutral for Idle/Paused/Offline; red for Failed/Blocked; `corona` for Needs you. Always textual, never colour alone (sheet 35). |
| **Page header** | Circular icon tile, page title (`text-2xl`), one-line subtitle, one primary action on the right. Underlined tabs sit below it when the page has sections. |
| **Agent list item** | Avatar or initials, name, one status. Idle: nothing. Running: white pulsing dot. Needs you: `corona` ring on the avatar plus "Needs you" in `text-xs`. Paused: name in `text-subtle`. Selected: `surface-hover` background and `border-strong` outline. |
| **Model label** | Mono chip in `text-xs text-muted`, e.g. `muse-spark-1.3`, shown on every step. |
| **ASTRA MODE badge** | `danger-solid` chip, uppercase `text-xs` semibold, next to the agent name everywhere. |
| **Approval prompt** | Card with a 1 px `corona` border and a "Needs you" badge: what the agent wants to do, the site and the amount, then Allow once (primary), Always allow (secondary), Deny (destructive). |
| **Receipt step** | Row with step number, action, before/after thumbnails, method, confidence, cost (mono) and a ✓ / ✕ status. Expands to full screenshots with the SAM highlight as a 2 px `corona` outline. |
| **Diff view** | Memory and skill diffs in mono: added lines on a `success` tint, removed lines on a `danger` tint. |
| **Live desktop frame** | `rounded-xl`, 1 px `border`, black letterbox. Top bar with the screen name, a green live dot, Take over / Hand back and Full screen. During takeover the frame border turns `corona` and a "You're in control" bar shows at the top. |
| **Expanded desktop view** | Opened by Full screen on the live desktop frame (`designs/Eclipse_Crew_04_Live_Desktop.png`; the button and phone expand icon are in `designs/Eclipse_Crew_39_Workspace_1280.png` and `designs/Eclipse_Crew_44_Mobile_Desktop_View_Only.png`). It fills the app window below the app header and never uses the browser Fullscreen API. The same stream moves into it, so nothing reconnects and an active takeover stays active. The header shows the agent, a live dot, the time, Take over / Hand back and Exit full screen (same as Back to workspace); a side column holds status, current task and control-safety cards. Esc exits, except during a takeover, when Esc goes to the desktop and only the buttons exit. On phones it is view-only unless the keyboard-and-mouse input check passes (takeover eligibility — see the Live desktop and takeover docs; an actual keyboard/mouse-equipped phone or tablet can take over). |
| **Tables** (Jobs, History) | 40 px rows, 1 px `border` between rows, sticky header in `text-xs text-muted`. |
| **Inputs** | 32 px high, `surface` background, `border-input`, `rounded-md`. Focus: `text` ring. Error: `danger` border plus a message below. |
| **Toasts** | Bottom-right, `surface-raised`, auto-dismiss after 5 s, except errors and approvals, which stay until dismissed. |
| **Secrets** | Always masked in mono (`••••1a2b`). There is no reveal button. |

**Composer**
- Compact single-row composer: paperclip button, borderless input ("Message {agent}…"), send icon button (sheet 36). Attachments, hints, and errors render above it. Enter sends, Shift+Enter adds a line.

**Takeover eligibility (input policy, not width)**
- Takeover is offered only when the owner has demonstrated keyboard plus mouse/trackpad input in the current viewer session (trusted pointer + trusted non-composing keyboard event on the takeover control; `(any-pointer: fine)` is only a hint). Touch-only devices stay view-only at any width; keyboard+mouse devices can take over at any width. View-only by default; the check never forwards events to the desktop or stores key values. See `docs/UI_REFERENCE_MAP.md` for the full rule and `docs/SECURITY.md` for the server boundary.

## UX Requirements

**Loading states**
- Content areas use skeletons shaped like the real content (a gentle 1.5 s pulse), not page spinners.
- Running work shows live progress: the current step, elapsed time and cost so far.
- If an action takes over 400 ms, show feedback immediately (a pressed state, then the spinner).

**Empty states**
- One short line saying what goes here, plus one primary action. For example: "No routines yet." with a Create routine button.
- An empty search or filter result says so and offers Clear filters.

**Error states**
- Say what happened and what to do next, in plain words, e.g. "Couldn't reach Ollama at host.docker.internal:11434. Check it's running."
- Show errors inline next to their cause. Use a toast only for background failures, with a link to the Jobs page.
- Never show stack traces in the UI. Failed runs link to their run detail page.

**Needs-you states**
- When an agent needs you (approval, login, CAPTCHA, budget pause), show it in three places: the `corona` ring on the agent's avatar, a card in chat, and a toast.

**Accessible forms**
- Every input has a visible label. Hints and errors are linked with `aria-describedby`.
- Validate on blur and on submit, not on every keystroke. On submit, move focus to the first error.
- Mark required fields; don't mark optional ones.

**Keyboard and accessibility (WCAG 2.2 AA)**
- Everything works with a keyboard, in a logical tab order.
- Focus is always visible: a 2 px `text` ring with a 2 px offset.
- Modals trap focus and close with Esc. Menus support arrow keys.
- Live regions (`aria-live="polite"`) announce run status changes and new approvals.
- Never rely on colour alone; keep text contrast ≥ 4.5:1 and UI component contrast ≥ 3:1.

## Implementation

Tokens live as CSS variables in `app/globals.css` and map onto shadcn/ui's variable names, so shadcn components pick them up without edits.

```css
:root {
  --background: #000000;
  --foreground: #ededed;
  --card: #0a0a0a;
  --card-foreground: #ededed;
  --popover: #1a1a1a;
  --popover-foreground: #ededed;
  --primary: #ededed;
  --primary-foreground: #0a0a0a;
  --secondary: #0a0a0a;
  --secondary-foreground: #ededed;
  --muted: #141414;
  --muted-foreground: #a1a1a1;
  --accent: #141414;          /* shadcn "accent" = hover surface, not a colour */
  --accent-foreground: #ededed;
  --destructive: #cd2b31;
  --destructive-foreground: #ffffff;
  --border: #242424;
  --input: #666666;
  --ring: #ededed;
  --radius: 0.5rem;           /* 8px; sm = 6px, xl = 12px */

  /* Eclipse Crew extras */
  --surface-raised: #1a1a1a;
  --border-strong: #333333;
  --text-subtle: #878787;
  --corona: #f2c46d;
  --corona-foreground: #0a0a0a;
  --success: #3fb950;
  --danger: #ff6166;
}
```
