# Compass ATM — Frontend Redesign Plan

> **Tagline:** Ask Bocconi. Navigate Milan.
> **Goal:** A calm, premium, command-center single page. The chatbot is the
> product; the surrounding chrome (mission chips, answer card, evidence panel,
> suggested prompts, status dot) makes answers easier to act on.
> **Reference:** Linear / Arc / Raycast quality bar. No AI orbs, no shadowed
> card piles, no university brochure beige.

---

## 0. What's already in the repo (must reuse / preserve)

The current `App.tsx` is 1,479 lines and the current `index.css` is 921 lines.
Most of it is over-built (4 mode tiles, voice waveform canvas, plan-extraction,
confidence pill, mobile sheet). Strip aggressively. Keep these:

- `BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000'`
- `POST /ask` body shape: `{ question }` → `{ answer, sources, verticale }`
- 30s `AbortController` timeout on `/ask` (good defensive pattern; keep it).
- `parseMarkdownBlocks(...)` and `splitCitationParts(...)` — these already do
  exactly what the spec asks for under "Answer text → structure formatter."
  Lift them, simplify, keep.
- `basename(...)` helper — useful for source labels.
- Speech recognition + `VoiceBrain` canvas — **DELETE.** Spec says "Mic button
  placeholder" only. The canvas waveform is decorative AI fluff.
- The four-mode `MODES` table — **simplify** (no per-mode tint colors, no
  `intro` paragraph, no `StaticHelper` blocks per vertical). Keep `key`,
  `label`, `description`, `icon`, and one suggestion-set used only on the
  empty state.
- `parsePlan` (action-extraction), `ConfidencePill`, `ModePanel`, `StaticHelper`,
  `MobileEvidenceSheet`, `useReducer` machinery — **DELETE.** Replace
  `useReducer` with a few `useState` hooks. The spec is explicit: no plan
  panel, no confidence pill, no per-vertical helpers.

**Dead dependencies in `package.json` that App.tsx never imports:**
`@radix-ui/*`, `framer-motion`, `react-markdown`, `remark-gfm`,
`class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`. Leave
them in `package.json` (removing risks breaking the lockfile right before a
hackathon demo) but **do not import any of them.** Cost is install-time only;
they don't enter the bundle if unused.

**Tailwind v4 IS already wired** (`@tailwindcss/vite`, `@import "tailwindcss"`
at top of `index.css`). The current code uses semantic class names instead of
utility classes. **We will switch to utilities** because that is the fastest
reliable path to the Linear/Raycast precision the spec calls for.

---

## 1. Styling decision — Tailwind v4 utilities + a thin CSS variable layer

**Recommendation: Tailwind v4 utility classes, with design tokens declared in
`@theme` so utilities like `bg-surface`, `text-ink`, `border-border` work.**

Why:
- Already installed. Zero new deps.
- Utility classes enforce the 4/8/12/16/24/32 spacing scale by construction —
  you cannot accidentally type `padding: 17px`.
- One file (`index.css`) instead of growing CSS modules. Hackathon-fast.
- The current `index.css` (921 lines of hand-written semantic CSS) gets
  replaced by ~80 lines of `@theme` token declarations + base styles.

Why **not** plain CSS-with-variables: the existing 921-line CSS file is the
proof — semantic class names drift, get re-declared, and pile up shadows.
Utilities prevent that drift.

Why **not** CSS Modules: extra build complexity for a one-page app, no real
reuse problem to solve.

Why **not** add shadcn/Radix-styled components: already installed but unused,
and the surface area we need (one button, one textarea, one badge, one row)
does not justify the abstraction. **Inline everything.**

---

## 2. Visual system

### 2.1 Colors (declared once in `@theme inline { ... }` in `index.css`)

| Token | Hex | OKLCH-ish role |
|---|---|---|
| `--color-bg` | `#FAFAF7` | App background. Off-white, faintly warm. Not pure white (too clinical), not beige (too brochure). |
| `--color-surface` | `#FFFFFF` | Answer card, composer, evidence panel surface. |
| `--color-surface-alt` | `#F4F3EE` | Mission chip rest state, source row rest state. |
| `--color-ink` | `#0E1116` | Primary text. Near-black, slight blue cast. |
| `--color-ink-muted` | `#5B6472` | Secondary text, source paths, captions. |
| `--color-ink-subtle` | `#8A93A0` | Placeholders, disabled labels. |
| `--color-border` | `#E6E4DD` | Hairline 1px borders everywhere. |
| `--color-border-strong` | `#CFCBC0` | Focus ring outer, hover borders. |
| `--color-accent` | `#1F3A8A` | **The one accent.** Deep indigo-blue (Bocconi-adjacent without copying their navy). Used for: send button, active chip, focus ring, source-count badge, link underlines. |
| `--color-accent-fg` | `#FFFFFF` | Text on accent. |
| `--color-accent-tint` | `#EEF1FA` | Accent at 6% — used for active chip background, hovered source row. |
| `--color-success` | `#0F8A5F` | Backend status dot when `/health` is OK. |
| `--color-danger` | `#C0392B` | Error banner border, retry text. |

**Accent justification:** Deep blue (`#1F3A8A`) reads as university-serious
and pairs with off-white for a Linear-ish calm. Avoids the explicit "no
generic indigo or AI purple" trap by sitting darker and warmer than Tailwind
indigo-600 (`#4F46E5`) — closer to Pantone 281 / Bocconi navy without being
literally Bocconi navy.

If the implementation agent dislikes the blue, **fall back to forest**
`#1F5E3A`. Do not pick burgundy unless the reviewer specifically asks — it
fights with the source-count and warning red.

### 2.2 Typography

System stack only. **Do not load Inter or Bricolage Grotesque.** They are in
the current `index.html` and they are network cost we don't need; the system
sans on macOS (SF) and Windows (Segoe) are already premium.

```
font-family:
  ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
  "Helvetica Neue", Arial, sans-serif;
```

Mono (only for source paths / code blocks): `ui-monospace, SFMono-Regular, Menlo, monospace`.

Type scale (Tailwind v4 defaults are fine; we just pick which we use):

| Token | Size / line-height | Weight | Where |
|---|---|---|---|
| `text-[11px]` | 11 / 14 | 600 uppercase tracking-wide | Eyebrows ("EVIDENCE", verticale badge label) |
| `text-sm` | 14 / 20 | 400 | Source rows, captions, status |
| `text-base` | 16 / 24 | 400 | Body text in answer card |
| `text-lg` | 18 / 26 | 500 | Answer card "bottom line" first sentence |
| `text-xl` | 20 / 28 | 600 | Section headers (h2 inside answer card) |
| `text-2xl` | 24 / 32 | 600 | Header brand "Compass ATM" |
| `text-3xl` | 30 / 36 | 600 | Empty state hero "Ask Bocconi…" |

Letter-spacing: `tracking-tight` on h1/h2 only. Eyebrows: `tracking-wider uppercase`.

### 2.3 Spacing scale

Tailwind defaults map to the required 4 / 8 / 12 / 16 / 24 / 32 grid. **Use
only:** `1` (4px), `2` (8px), `3` (12px), `4` (16px), `6` (24px), `8` (32px),
`12` (48px), `16` (64px). **Never** use `5`, `7`, `9`, `10`, `11` — those
break the rhythm.

### 2.4 Radius scale

| Token | Px | Use |
|---|---|---|
| `rounded-md` | 6 | Mission chips, source rows, small buttons |
| `rounded-lg` | 10 | Composer, send button |
| `rounded-xl` | 14 | Answer card, evidence panel |
| `rounded-full` | — | Status dot, circular icon buttons (mic) |

### 2.5 Shadows

**Effectively none.** Linear/Raycast achieve depth via 1px borders + tiny
contrast bumps, not shadow stacks. Allowed:

- `shadow-none` everywhere by default.
- Composer + answer card: `border border-border` (1px hairline).
- Composer focused: `ring-1 ring-accent ring-offset-0` (no offset).
- One exception: empty-state suggested-prompt buttons may use
  `shadow-[0_1px_0_rgba(14,17,22,0.04)]` to lift them off the surface ~1px.

No blurred shadows. No glows. No gradients.

### 2.6 Motion

- Hover: 120ms ease-out on color and border only.
- Active chip indicator: instant (no slide).
- Loading shimmer: a CSS keyframe `pulse` on the skeleton lines, 1.4s.
- No framer-motion. No spring physics. No micro-bounces.

---

## 3. Layout

### 3.1 Desktop (≥ 960px)

```
┌────────────────────────────────────────────────────────────────────┐
│  ◇ Compass ATM   Ask Bocconi. Navigate Milan.        ● online    │ 64px header
├────────────────────────────────────────────────────────────────────┤
│  [ Ask anything ] [ Settle in Milan ] [ Study Abroad ]            │ 56px chip strip
│  [ Career ]       [ Campus Life ]                                 │
├──────────────────────────────────────┬─────────────────────────────┤
│                                      │   EVIDENCE                  │
│  ── chat thread ──                   │   ─────────                 │
│                                      │   3 sources                 │
│   user msg (right-aligned)           │                             │
│                                      │   ▢ Library guest policy    │
│     ┌────────────────────────┐       │     life_on_campus / bit-…  │
│     │ ⓘ Campus Life          │       │   ▢ ATM Milano lines        │
│     │                        │       │     relocation / dati-com…  │
│     │ Yes, students may      │       │   ▢ Bocconi Library FAQ     │
│     │ bring guests…          │       │     life_on_campus / www-…  │
│     │                        │       │                             │
│     │ Steps:                 │       │                             │
│     │  1. Register at desk   │       │                             │
│     │  2. Show guest ID      │       │                             │
│     │                        │       │                             │
│     │ Worth noting: …        │       │                             │
│     │                        │       │                             │
│     │ 3 sources →            │       │                             │
│     └────────────────────────┘       │                             │
│                                      │                             │
├──────────────────────────────────────┤                             │
│  ┌────────────────────────────────┐ │                             │
│  │ Ask about Bocconi, Milan, …    │ │                             │
│  │                          🎤  ▶ │ │                             │
│  └────────────────────────────────┘ │                             │
└──────────────────────────────────────┴─────────────────────────────┘
   max-width 1200px, centered; chat col flex 1; evidence col 360px
```

Grid: `grid grid-cols-[1fr_360px] gap-8` inside a `max-w-[1200px] mx-auto px-8`.

Header: fixed-feeling but not `position: fixed` — just sits at top, flex row,
justify-between, 64px tall, bottom border 1px.

Chip strip: horizontal flex with 8px gap. Wraps to 2 rows at narrow desktops.

Chat column: flex column. Thread scrolls. Composer sticks to bottom of the
column (`sticky bottom-0` with `bg-bg/95 backdrop-blur` so content scrolls
behind it cleanly).

Evidence column: also `sticky top-[112px]` so it stays visible as the chat
scrolls. Internal scroll if sources overflow.

### 3.2 Mobile (< 960px, target 360px)

```
┌────────────────────────────┐
│ ◇ Compass ATM       ●      │ 56px header
├────────────────────────────┤
│ [ Ask any ] [ Milan ] →    │ horizontal-scroll chips, 48px tall
├────────────────────────────┤
│ user msg                   │
│                            │
│ ┌────────────────────────┐ │
│ │ Campus Life            │ │
│ │ Yes, students may…     │ │
│ │ Steps: …               │ │
│ │                        │ │
│ │ ▾ 3 sources            │ │← collapsible, taps to expand inline
│ │   ▢ Library guest …    │ │
│ │   ▢ ATM Milano lines   │ │
│ └────────────────────────┘ │
│                            │
│ ┌────────────────────────┐ │
│ │ Ask…              🎤 ▶ │ │ sticky bottom
│ └────────────────────────┘ │
└────────────────────────────┘
```

Breakpoints:
- `< 768px` (Tailwind `md:` boundary): single column, evidence collapses
  inside each answer card as a `<details>` "▾ N sources".
- Chip strip: `overflow-x-auto` with `snap-x snap-mandatory`, no scrollbar
  shown.
- Composer: `sticky bottom-0` with safe-area inset
  (`pb-[max(env(safe-area-inset-bottom),12px)]`).
- At 360px: header tagline truncates to "Ask Bocconi." only. Brand stays.

---

## 4. Component breakdown

**Default to inlining.** Per the user's CLAUDE.md, no extraction until 3
repetitions. The whole app is one route, one screen.

| Component | Inlined or extracted? | Where | Purpose |
|---|---|---|---|
| `App` | the file | `src/App.tsx` | State, fetch, layout |
| `Header` | inline in `App.tsx` | — | Brand, tagline, status dot |
| `StatusDot` | inline | — | Polls `/health`, green/red/grey |
| `MissionChips` | inline | — | The 5 chips; click seeds composer |
| `ChatThread` | inline | — | Scrolling list of messages |
| `UserBubble` | inline | — | Right-aligned, `bg-surface-alt`, no border |
| `AnswerCard` | inline | — | Verticale badge, structured body, sources count, mobile-collapse evidence |
| `Composer` | inline | — | Textarea + mic placeholder + send |
| `EmptyState` | inline | — | Hero + 4 suggested-prompt buttons |
| `EvidencePanel` | inline | — | Desktop right rail |
| `SourceRow` | inline | — | One source line with derived label + path caption |
| `Icon` | extracted | `src/Icon.tsx` (or keep in `App.tsx`) | We swap to `lucide-react` (already installed) — `<Compass>`, `<Send>`, `<Mic>`, `<Building2>`, `<Plane>`, `<Briefcase>`, `<Sparkles>`, `<ChevronDown>`. Drop the hand-rolled SVGs. |

**Extracted only if real reuse exists.** Source rows appear in 2 places
(desktop panel + mobile inline), but they take 6 lines — duplicate inline,
don't extract until it bites.

File tree after redesign:

```
frontend/
  index.html                    ← retitle, set lang="en"
  src/
    main.tsx                    ← unchanged
    App.tsx                     ← rewrite top-to-bottom (~400 lines target)
    index.css                   ← ~80 lines: @theme tokens + base resets
    Icon.tsx                    ← optional; thin wrappers around lucide-react
```

Delete: nothing else exists. The `public/` dir is empty.

---

## 5. Answer text → structure formatter (algorithm)

The backend returns plain text or markdown-ish text plus `[source: path]`
inline citation markers. We render it as a structured **answer card**, not a
ChatGPT paragraph blob.

### 5.1 Pipeline (run once per assistant message, memoized)

1. **Strip inline source markers from the rendered text but remember them.**
   - Run regex `/\[source:\s*([^\]]+)\]/g` over the answer.
   - Remove every match from the displayed string. Collect the matched paths
     into a `Set` per message.
   - Important: the `sources` array in the API response is the canonical list.
     We use the inline-marker set only to verify and to optionally annotate
     a line (e.g., a line citing source X gets a small superscript number
     matching that source's index in the panel — *only if it's clean*; if it
     gets messy at implementation time, drop the cross-link and keep just
     the cleaned text + the right-rail panel).
2. **Block-segment the cleaned text** using a simplified version of the
   existing `parseMarkdownBlocks(...)`:
   - Lines starting `## ` / `### ` → headings (render as `h3` / `h4` inside
     the card; visually small, weight 600).
   - Lines starting `- ` / `* ` → unordered list. Group consecutive into one
     `<ul>`.
   - Lines starting `1. `, `2. ` (any `\d+\.`) → ordered list / checklist.
     If 3+ items, render as a numbered checklist with circle-numbers in the
     accent color.
   - Lines starting `|` with a divider line below → table (use existing
     `SimpleTable` logic).
   - Otherwise: paragraph. Consecutive non-blank, non-list lines join with a
     space into one paragraph.
3. **Pull out the "bottom line" / short answer.**
   - If the first block is a paragraph and is ≤ 220 chars → render it with
     `text-lg font-medium text-ink` (the lead). Subsequent paragraphs revert
     to `text-base text-ink-muted`.
   - If the first block is a list → no lead; show "Steps" header above the list.
   - This is heuristic and cheap. Do not try to detect "Bottom line:" labels
     or build a summarizer.
4. **Detect "Worth noting" caveats.**
   - Scan blocks for any paragraph that starts with one of:
     `"Note:"`, `"Worth noting"`, `"Caveat:"`, `"Important:"`, `"However,"`.
   - Pull those out and render them in a single muted block at the bottom of
     the card with an eyebrow `WORTH NOTING`. If multiple, join with bullets.
   - This includes the abstention pattern (`/no information|i don't have/i`):
     when matched, render the WHOLE answer in the "worth noting" muted style
     and skip the structured rendering — Compass said it didn't know, and we
     should show that humbly, not pretend we have a plan.
5. **Footer of the card:** `→ N sources` text-button. On desktop it's
   informational (the panel already shows sources). On mobile it expands a
   `<details>` block of source rows inline.

**Markdown bold/italic/code:** keep `stripMarkdown()` for headings/cells, but
inside paragraphs, render `**bold**` as `<strong>` and `*italic*` as `<em>`.
Hand-roll a tiny inline formatter (split-on-asterisk) — do NOT import
`react-markdown`. The current code already does inline citation splitting
(`splitCitationParts`); generalize that pattern to also handle `**` and `*`.

### 5.2 What we do NOT do

- No tooltip on the inline text saying "click to see source." Source-citation
  pills inside paragraphs are explicitly forbidden by the spec.
- No streaming token-by-token. The backend doesn't stream; don't fake it.
- No "expand to see full answer" — render everything; the card scrolls in
  context with the thread.
- No copy-to-clipboard button (out of scope).

---

## 6. Source rendering — path → human label

Source paths are slugified URLs of the form
`<verticale>/<dashed-domain-and-slug>.md`. Examples from the actual data dir:

| Raw path | Derived label | Caption (smaller text below) |
|---|---|---|
| `life_on_campus/www-unibocconi-it-en-current-students-library-archives-news.md` | **Bocconi · Library archives news** | unibocconi.it · en/current-students/library/archives/news |
| `relocation/dati-comune-milano-it-dataset-ds538-atm-percorsi-linee-di-superficie-urbane.md` | **Comune di Milano · ATM surface lines (ds538)** | dati.comune.milano.it · dataset/ds538-atm-percorsi-linee-di-superficie-urbane |
| `study_abroad/viaggiaresicuri-it-scheda-paese-giappone-jpn.md` | **Viaggiare Sicuri · Japan country sheet** | viaggiaresicuri.it · scheda-paese/giappone-jpn |
| `career_readiness/almalaurea-it-sintesi-condizione-occupazionale-laureati-2024.md` | **AlmaLaurea · Graduate employment summary 2024** | almalaurea.it · sintesi/condizione-occupazionale-laureati-2024 |
| `life_on_campus/bit-unibocconi-it-hc-en-us-articles-4405876182418-how-do-i-get-into-the-library.md` | **Bocconi Help · How do I get into the library** | bit.unibocconi.it · articles/how-do-i-get-into-the-library |

### 6.1 Algorithm

```
labelFromPath(path):
  1. strip leading `<verticale>/` if present.
  2. strip trailing `.md`.
  3. split the remaining slug on `-`.
  4. Walk left-to-right collecting tokens until we hit a known TLD-like
     token from the set { 'com','it','eu','org','net','xyz','io' }. Everything
     up to and INCLUDING that token is the domain. Reverse-join the
     pre-domain tokens into a domain string with `.` (e.g. ['www','unibocconi','it']
     → 'www.unibocconi.it').
  5. The remainder is the path-tail. Drop generic prefix tokens
     ('en','it','hc','us','articles','dataset','sintesi','scheda','paese')
     for the LABEL, but keep them for the CAPTION.
  6. Title-case the remaining tail tokens, joined with spaces, capped at
     ~60 chars. Append numeric IDs (e.g. ds538, 2024) verbatim.
  7. The brand is a hard-coded lookup on the domain root:
        unibocconi → "Bocconi"
        bit.unibocconi → "Bocconi Help"
        dati.comune.milano → "Comune di Milano"
        almalaurea → "AlmaLaurea"
        viaggiaresicuri → "Viaggiare Sicuri"
        roomlessrent → "Roomless Rent"
        wixsite, wordpress, blogspot → first non-platform token, title-cased
        (default) → first domain token, title-cased
     LABEL = `${brand} · ${title-cased tail}`.
  8. CAPTION = `${joined-domain} · ${path-tail joined with /}`.
```

Tooltip on the label (`title="<full raw path>"`) keeps debuggability.

If the algorithm produces a label longer than 70 chars, truncate with `…`.
If the algorithm fails (catches an exception), fall back to
`basename(path).replace(/-/g, ' ').replace(/\.md$/, '')`.

This stays graceful: even bad inputs always render *something* readable.

---

## 7. Interaction states (be specific)

### Mission chip
- Rest: `bg-surface-alt text-ink-muted border border-transparent`.
- Hover: `bg-surface text-ink border-border`. 120ms transition.
- Active (selected): `bg-accent-tint text-accent border-transparent font-medium`.
- Focus-visible: `outline-none ring-2 ring-accent ring-offset-2 ring-offset-bg`.
- Click: seeds composer with the verticale's first suggestion AND filters
  next answer's expected verticale visually (just for the chip; backend still
  decides). **Pick the simpler interpretation: clicking a chip just seeds
  the composer.** No scoping, no filtering, no extra state.

### Suggested-prompt button (empty state)
- Rest: `bg-surface border border-border text-ink rounded-xl p-4 text-left`.
- Hover: `border-border-strong`, no background change.
- Active/click: `scale-[0.99]` for 80ms.
- Focus: `ring-2 ring-accent ring-offset-2`.

### Composer textarea
- Rest: `bg-surface border border-border rounded-lg`.
- Focus-within (the form, not the textarea alone): `border-accent ring-1 ring-accent/30`.
- Disabled: `bg-surface-alt text-ink-subtle cursor-not-allowed`.
- Placeholder: `text-ink-subtle`.

### Send button
- Rest: `bg-accent text-accent-fg rounded-md px-4 h-9 font-medium`.
- Hover: `bg-[#16306B]` (accent darkened 8%).
- Active: `scale-[0.98]`.
- Disabled: `bg-ink-subtle text-bg cursor-not-allowed`.
- Loading: replace icon with a 14px spinner, keep text.

### Mic button (placeholder)
- Always disabled-styled in v1: `bg-surface-alt text-ink-subtle border border-border`.
- `aria-label="Voice input (coming soon)"`. `disabled` attribute set.
- This satisfies "Mic button placeholder" without shipping the speech API
  (which the current code does and which is over-scope).

### Source row
- Rest: `bg-transparent text-ink hover:bg-surface-alt rounded-md p-3`.
- Hover: subtle bg shift only.
- Active: `outline outline-1 outline-accent/30` for 200ms after click. (The
  current `.is-highlighted` pulse pattern; keep the idea, drop the bounce.)

### Status dot (header)
- Polling state (initial): `bg-ink-subtle` 8px circle.
- OK (`/health` returns 200): `bg-success`.
- Down (network error or non-200): `bg-danger`.
- Tooltip: `title="Backend online" | "Backend unreachable"`.

### Error state (after `/ask` fails)
- Inline banner above the composer: `bg-bg border border-danger rounded-lg p-3`,
  text in `text-ink`, retry button as a text-link in `text-danger underline`.
- Do not red-flash the whole screen.

### Loading state (waiting on `/ask`)
- Composer disabled.
- Below the user message, a skeleton answer card: 3 grey lines pulsing
  (`animate-pulse` in Tailwind), no badge, no card border. Width: 80%, 100%,
  60%.

---

## 8. State model (in `App.tsx`)

```ts
type Verticale = 'relocation'|'life_on_campus'|'study_abroad'|'career_readiness';

type Message =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string;
      sources: string[]; verticale: Verticale; createdAt: number };

type AskState =
  | { kind: 'idle' }
  | { kind: 'loading'; question: string }
  | { kind: 'error'; question: string; message: string };

const [messages, setMessages] = useState<Message[]>([]);
const [askState, setAskState] = useState<AskState>({ kind: 'idle' });
const [composerValue, setComposerValue] = useState('');
const [activeChip, setActiveChip] = useState<'all'|Verticale>('all');
const [healthStatus, setHealthStatus] = useState<'pending'|'ok'|'down'>('pending');
```

That's it. Six `useState`s. No reducer, no context, no Zustand. Two `useEffect`s:
- One for `/health` polling (every 30s, with cleanup).
- One that auto-scrolls the thread to bottom when `messages.length` changes
  (`useRef` on the thread div + `scrollTo({ top: scrollHeight })`).

`activeChip` is purely cosmetic (which chip is highlighted) + drives empty-state
suggestion choice. It does NOT scope the request — backend decides verticale.

---

## 9. File diff plan

### Modify

- **`/Users/louis/bocconi hackathon/starter/frontend/index.html`**
  - `lang="it"` → `lang="en"` (UI is English).
  - `<title>Bocconi AI Buddy</title>` → `<title>Compass ATM — Ask Bocconi. Navigate Milan.</title>`.
  - Delete the Google Fonts `<link>` (we use system stack; saves ~80kb of font network).
  - Add `<meta name="description" content="Ask Bocconi. Navigate Milan." />`.
  - Add a 1-color SVG favicon inline (a simple compass needle in `#1F3A8A`).

- **`/Users/louis/bocconi hackathon/starter/frontend/src/App.tsx`** — full rewrite.
  Target ~400 lines. Inline everything per Section 4.

- **`/Users/louis/bocconi hackathon/starter/frontend/src/index.css`** — replace
  the 921-line file with:
  ```css
  @import "tailwindcss";

  @theme inline {
    --color-bg: #FAFAF7;
    --color-surface: #FFFFFF;
    --color-surface-alt: #F4F3EE;
    --color-ink: #0E1116;
    --color-ink-muted: #5B6472;
    --color-ink-subtle: #8A93A0;
    --color-border: #E6E4DD;
    --color-border-strong: #CFCBC0;
    --color-accent: #1F3A8A;
    --color-accent-fg: #FFFFFF;
    --color-accent-tint: #EEF1FA;
    --color-success: #0F8A5F;
    --color-danger: #C0392B;
  }

  /* Base */
  html, body, #root { height: 100%; }
  body {
    background: var(--color-bg);
    color: var(--color-ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  /* Hide native scrollbars on the chip strip */
  .no-scrollbar { scrollbar-width: none; }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  /* Pulse keyframe for skeleton */
  @keyframes pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 0.3; }
  }
  ```
  Total ~80 lines including comments. Tailwind utilities handle the rest.

### Create

- **`/Users/louis/bocconi hackathon/starter/frontend/src/Icon.tsx`** (optional).
  If the implementation agent prefers, lift `lucide-react` icon imports into a
  small wrapper. **Or** just import them inline in `App.tsx` — fewer files is
  better. Recommend: inline.

### Delete

- Nothing on the filesystem. (`package.json` keeps the unused deps so the
  lockfile stays consistent — see Section 0.)

---

## 10. Risks / unknowns the implementation agent must double-check

1. **Tailwind v4 `@theme` syntax.** v4 changed how custom colors are exposed
   as utilities. If `bg-bg` doesn't resolve, the fallback is to use
   `bg-[var(--color-bg)]` (arbitrary-value syntax with the CSS variable).
   The current `index.css` already does this, so we know it works.
2. **`/health` CORS.** Confirm the backend allows `GET /health` from the
   frontend origin. If not, status dot stays grey forever — fine, but make
   sure the failure mode is silent (don't log loud errors).
3. **The `[source: path]` pattern is not guaranteed.** Some answers may have
   the markers, some not. The cleaner regex must be tolerant; absence is
   normal. The right rail always renders from the API `sources` array, not
   from the inline markers.
4. **30s timeout.** Keep the existing `AbortController` + 30s pattern. Do
   not shorten it; some RAG answers are slow.
5. **Long answers.** Some answers may be very long (markdown tables, lots
   of bullets). The answer card must not have a max-height — let it grow
   and scroll the thread, not the card. The composer's `sticky bottom-0`
   handles this UX.
6. **Speech recognition currently used.** The current code wires
   `webkitSpeechRecognition` and a canvas waveform. The redesign drops both.
   Make sure no broken refs remain. The mic stays as a disabled placeholder
   only.
7. **Scroll-to-bottom on new message.** When a new assistant message arrives,
   scroll the thread to bottom — but only if the user was already near the
   bottom (within ~120px). Otherwise respect their scroll position. (Standard
   chat UX. Not optional.)
8. **Subtle current behavior to preserve:** the existing reducer focuses the
   evidence panel on a fresh answer (`modePanelOpen: true`). In the new
   design the evidence panel is always visible on desktop, so this is moot.
   On mobile, the in-card `<details>` defaults to **closed** — opening it on
   first answer would feel pushy.
9. **A11y.**
   - The chip strip needs `role="tablist"`-like semantics? **No** — they
     don't switch panels, they seed the composer. Use plain `<button>`s in a
     `<nav aria-label="Mission shortcuts">`.
   - Source rows: each `<button>` with `aria-label="Open source: {derivedLabel}"`.
   - Composer textarea: `<label class="sr-only">` survives.
   - Status dot: `<span role="status" aria-live="polite">` so screen readers
     announce "online"/"offline" changes.
10. **Bundle size sanity check.** `lucide-react` tree-shakes per-icon. Importing
    8 icons is ~3kb gzipped. No issue.

---

## 11. Out of scope (explicitly NOT shipping)

- No auth, no Bocconi SSO.
- No chat history persistence (refresh = empty thread).
- No multi-conversation / threads.
- No streaming responses.
- No dark mode toggle. Single light mode.
- No settings panel.
- No language switcher.
- No copy-to-clipboard, no share buttons.
- No analytics, no tracking.
- No service worker / PWA.
- No backend changes (contract is fixed: `POST /ask`).
- No source preview (we don't fetch the .md content; we link conceptually only).

---

## 12. Implementation order (suggested 60–90 min path)

1. Replace `index.css` with the ~80-line token file. Delete the 921-line file.
2. Update `index.html` (title, lang, drop Google fonts).
3. Stub `App.tsx` shell: header, chip strip, empty state, composer. No data.
4. Wire `/ask` POST + state model from Section 8.
5. Build the answer card with the formatter from Section 5.
6. Build the evidence panel + source labeler from Section 6.
7. Mobile: collapsing evidence inside the answer card.
8. Polish pass: focus rings, hover states, the status dot poll, error banner.

If time runs out, drop the brand-table in source labeling (Section 6 step 7)
and just show `${first-domain-token} · ${tail}`. Everything else is critical.

---

**End of plan.** Implementation agent: read this top-to-bottom before
touching code.
