# Session handoff — Bocconi AI Buddy

> **Read me first.** This is a handoff from a previous Claude session. After reading this, skim `BRIEF.md` (challenge spec) and `AGENTS.md` (technical contract) for any constraint you don't see below. Today is **2026-05-09** — hackathon day. We started ~10:06, eval v2 finished ~11:32, deadline is **16:00 (6 hours from start)**. We're ~1.5 hours in, ~4.5 hours left.

## Working agreement (load-bearing)

**Claude is the brain, Codex is the muscle.** The user has unlimited Codex usage (via ChatGPT subscription) and limited Claude usage. **Default: write detailed rescue briefs and have the user run `/codex:rescue`.** Reserve direct Claude edits for: tight architectural decisions, debugging that needs shared context, small one-line fixes, integration after Codex lands.

This is also saved as a feedback memory at `~/.claude/projects/-Users-louis-bocconi-hackathon-/memory/feedback_codex_muscle.md`.

The user is a Bocconi student following the global CLAUDE.md teaching cadence — explain non-obvious choices, ask probing questions, never let them accumulate black-box understanding.

## What's built and working

### Backend (FastAPI, Python 3.13, in `backend/`)

Files we wrote:
- **`backend/prompts.py`** — base abstention/citation rules + per-verticale system prompt addenda. The single highest-leverage line: *"If the sources do not contain the information needed to answer, abstain in the user's language."*
- **`backend/rag.py`** — full RAG engine: chunking, FAISS+BM25 hybrid retrieval, RRF merge, MMR diversify, **batched** GPT-5.4-nano rerank (1 call, not 20), confidence gate, GPT-5.5 generation. Module-level `STATE` dict, loaded once at FastAPI startup.
- **`backend/main.py`** — FastAPI app with `lifespan` that calls `rag.load_state()` once. Graceful 200 fallback if indexes aren't loaded yet.
- **`backend/scripts/build_index.py`** — one-shot indexer. Run on host with `uv run python -u scripts/build_index.py` (PYTHONUNBUFFERED for live output).
- **`backend/scripts/eval.py`** — calibration harness: hits `/ask` with the 10 sample questions, writes `backend/eval_results.json`.

Pipeline:
```
question
  ├→ embed(text-embedding-3-large) → FAISS top-30
  └→ BM25 keyword → top-30
  → RRF merge (k=60) → 30
  → MMR diversify (λ=0.7) → 20
  → GPT-5.4-nano BATCHED rerank → 8
  → confidence gate (top score < 4.0/10 → abstain w/o calling answer model)
  → per-verticale system prompt + 8 chunks
  → GPT-5.5 (max_completion_tokens=3000, no temperature param) → answer
  → return {answer, sources=cited paths, verticale=majority vote}
```

### Index built and persisted

`backend/data/index/`:
- `faiss.index` — 123 MB, 10,523 vectors × 3072 dims (text-embedding-3-large)
- `chunks.jsonl` — 15 MB, one JSON per chunk with full metadata
- `bm25.pkl` — 10 MB, pickled `BM25Okapi`

Total: ~148 MB on disk. Built once for ~$0.46. Lives inside `backend/data/` so the production Dockerfile copies it into the image.

### Dev environment

- `docker-compose.dev.yml` runs backend at `:8000` and frontend at `:5173`.
- We added `- /app/.venv` to the backend volumes to **mask the host venv** (otherwise host-side `uv sync` triggered a uvicorn reload loop in the container).
- Backend hot-reloads on Python file changes (uvicorn `--reload`).
- Frontend is still the placeholder `<h1>Build me</h1>`.

### Eval v2 results (estimated +80 points on 10 sample questions)

| Q | Topic | Latency | Verdict |
|---|---|---|---|
| 1 | ATM under-27 pass | 8.5s | partial — got "€200 student" but no adult comparison |
| 2 | SSN registration | 19.7s | full numbered list w/ EU/non-EU branches |
| 3 | IT bus comparison | 16.4s | structured table all 4 carriers |
| 4 | IT library access | 6.2s | clean, cited |
| 5 | Dining areas | 20.2s | 3 dining areas table |
| 6 | Exchange weights | 9.9s | weights table (50%/20%/30% × 1000) |
| 7 | **MIT trap** | 8.8s | **caught** — "no MIT in sources" |
| 8 | Merit Award | 9.0s | abstained — likely false negative |
| 9 | **BESS 2026 trap** | 2.5s | **caught** — "no 2026 BESS" |
| 10 | Sport tiers | 23.7s | "6 tiers, cheapest €27 student" |

All under the 30s wall. No empty answers. Both traps caught. Italian language matching working.

Estimated v1 → v2 improvement: from ~-25 to ~+80 (rough — the actual judge is an LLM that accepts paraphrases).

## Known accuracy gaps

1. **Q8 (Bocconi Merit Award)** — abstains when retrieval pulled the right verticale. The model can't pin down a specific number/format from those chunks. **HyDE** (have the model draft a hypothetical answer, embed it, search with the hypothetical too) is the queued upgrade. Brief is in the "Next moves" section below.
2. **Q1 (ATM pass)** — gets the under-27 student price (€200) but the comparison adult price isn't being retrieved. Either it's not in the corpus or our chunking missed it. Worth one investigation pass.

## Tools, accounts, env

- **OpenAI API key** is in `/Users/louis/bocconi hackathon/starter/.env` as `OPENAI_API_KEY=...`. Gitignored. Already burned ~$0.50 (one full corpus embed + two eval runs of 10 questions). $50 budget, ~$49.50 left.
- **Models** chosen:
  - Embedding: `text-embedding-3-large` (3072 dims, multilingual)
  - Rerank: `gpt-5.4-nano` (batched, single JSON call per question)
  - Answer: `gpt-5.5`
  - Note: these models reject `temperature` and `max_tokens` — must use `max_completion_tokens` only.
- **Codex CLI** installed and authenticated via ChatGPT subscription (louis.hu@studbocconi.it). Codex usage does NOT consume the $50 OpenAI API credits.
- **Codex plugin for Claude Code** installed (`openai/codex-plugin-cc`). Slash commands available:
  - `/codex:rescue` — delegate a task to Codex (background)
  - `/codex:status` — check progress
  - `/codex:result` — fetch output
  - `/codex:cancel` — stop a job
  - `/codex:review`, `/codex:adversarial-review` — second-opinion review modes
- **Railway CLI** installed (v4.57.1). Account not yet logged in.
- **uv** installed on host (v0.11.12).
- **Docker** running. Dev containers up at `:8000` and `:5173`.

## Frozen contract — do NOT change

`POST /ask`:
- Request: `{"question": str}`
- Response: `{"answer": str, "sources": list[str], "verticale": "relocation"|"life_on_campus"|"study_abroad"|"career_readiness"}`
- 200 always (even for "I don't know"). 30s hard wall.
- 4 verticali required.
- Reply in same language as question.

## Next moves queued

### 1. Frontend (NEXT) — delegated to Codex via `/codex:rescue`

The brief below is what we're about to send to Codex. If the user hasn't already kicked it off, paste it. Locked design choices:
- **Concept:** mobile-first, 4 verticale cards on home, tap-to-chat with chips, sources rendered as first-class chips with file paths visible.
- **Typography:** Bricolage Grotesque (display) + Inter Tight (body) + JetBrains Mono (citations).
- **Palette:** warm ivory bg, deep teal foreground, hot saffron accent + per-verticale tints.

<details>
<summary>Frontend rescue brief (paste into <code>/codex:rescue</code>)</summary>

```
TASK
Build the production frontend for the Bocconi AI Buddy at frontend/. The backend
is already implemented at backend/main.py and exposes POST /ask. Build a polished,
mobile-first React+TypeScript+Vite SPA that calls /ask and presents the answer
with sources. This is for a Bocconi hackathon judged at two levels: an automated
LLM scorer that hits /ask directly, and a human jury that opens the frontend on
their phone. Optimize the frontend for the human jury.

WORKING DIRECTORY
/Users/louis/bocconi hackathon/starter/
Touch only files in frontend/. Do NOT touch backend/.

PREREQ READS (do these first, in order)
1. starter/BRIEF.md — sections 7 ("How you are evaluated") and 1 ("The Challenge")
2. starter/DESIGN.md — entire file. Respect "do not ship the default chat-on-the-left".
3. starter/AGENTS.md — "Endpoint /ask" and "Language" sections only. /ask is FROZEN.
4. starter/SAMPLE_QUESTIONS.md — use 4 of these as pre-filled chips, one per verticale.
5. frontend/src/App.tsx (current placeholder), frontend/package.json, frontend/vite.config.ts.

API CONTRACT (frozen)
POST {VITE_BACKEND_URL or http://localhost:8000}/ask
Body: {"question": string}
Response: {"answer": string, "sources": string[], "verticale": "relocation"|"life_on_campus"|"study_abroad"|"career_readiness"}
The answer text contains inline citations like `[source: path/to/file.md]`. Render them
as interactive chips inline; click highlights the matching source row.

CONCEPT (locked)
Two views: HOME (4 verticale cards in 2x2 mobile / 1x4 desktop, each with glyph + name +
description + 2-3 question chips) and CHAT (thread with markdown answer, source chips,
verticale pill, composer textarea). Trap-style answers ("There is no..." / "I don't have
this information") render with a subtle honest-abstention treatment (left border + tag),
not as an error.

DESIGN TOKENS (paste into frontend/src/index.css, Tailwind v4 CSS-first, NO tailwind.config.ts)
@import "tailwindcss";
@theme inline {
  --color-background: oklch(0.985 0.008 80);
  --color-foreground: oklch(0.28 0.04 200);
  --color-muted: oklch(0.95 0.012 80);
  --color-muted-foreground: oklch(0.48 0.04 200);
  --color-border: oklch(0.91 0.012 80);
  --color-card: oklch(0.99 0.005 80);
  --color-card-foreground: oklch(0.28 0.04 200);
  --color-accent: oklch(0.71 0.17 65);
  --color-accent-foreground: oklch(0.20 0.04 200);
  --color-vert-relocation: oklch(0.71 0.17 65);
  --color-vert-life-on-campus: oklch(0.62 0.14 175);
  --color-vert-study-abroad: oklch(0.55 0.18 280);
  --color-vert-career-readiness: oklch(0.60 0.15 25);
  --font-display: "Bricolage Grotesque", ui-serif, Georgia, serif;
  --font-sans: "Inter Tight", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --radius-sm: 0.375rem; --radius-md: 0.625rem; --radius-lg: 1rem;
}
body { font-family: var(--font-sans); background: var(--color-background); color: var(--color-foreground); -webkit-font-smoothing: antialiased; }
h1, h2, .font-display { font-family: var(--font-display); }

Load fonts in index.html:
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;500;600;700&family=Inter+Tight:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">

STACK
- Tailwind v4, shadcn/ui (`pnpm dlx shadcn@latest init`, components: button, input, textarea,
  card, scroll-area, badge, separator, skeleton)
- lucide-react for icons
- react-markdown + remark-gfm for the answer body
- Use pnpm, not npm.

EXAMPLE QUESTIONS (use as chips)
relocation:
- "How do I open an Italian bank account as a non-resident?"
- "What's a fair monthly rent budget near Bocconi?"
- "Where do I get my codice fiscale?"
life_on_campus:
- "Can I bring guests into the library?"
- "What dining options are on campus?"
- "How do I join a student association?"
study_abroad:
- "Which partner universities offer Double Degrees in Finance?"
- "When do exchange applications open?"
- "How is the exchange selection score calculated?"
career_readiness:
- "What's the average salary for Bocconi MSc Finance grads?"
- "When does the curricular internship application close?"
- "Which scholarships are available for international MSc students?"

DO NOT
- Change /ask shape.
- Add features outside spec (auth, multi-conversation, dark mode, export). Depth > breadth.
- Use floating gradients, glassmorphism, neon. DESIGN.md flags those as "ChatGPT wrapper #4192".
- Remove `preview: { allowedHosts: true }` from vite.config.ts.

ACCEPTANCE TESTS (run before claiming done)
1. `cd frontend && pnpm install && pnpm build` exits 0.
2. `pnpm dev` shows the home screen at :5173.
3. Tapping a chip with backend running on :8000 sends /ask and renders the response with sources.
4. UI is usable at 360px viewport.
5. Error state renders calmly when /ask times out.
6. `[source: path]` tokens render as inline chips, not raw text.
7. Trap answers render with the honest-abstention visual.

DELIVERABLE
Working frontend in frontend/. Update package.json. Don't commit anything (no git).

When done, summarize: files touched, deps added, deviations from brief, acceptance tests run.
```

</details>

### 2. HyDE for Q8 false-abstention pattern (after frontend)

**Goal:** raise accuracy on questions like Q8 (Merit Award amount) where retrieval misses because the question's wording is too query-like and far from how documents are actually written.

**Plan (write a Codex rescue brief, don't edit directly):**
- In `rag.py`, add a `hyde_query()` function: one nano call that drafts a 2-3 sentence hypothetical answer to the question. Embed both the original question AND the hypothetical, average the vectors, do dense retrieval with the averaged vector. BM25 stays on the original question.
- Behind a feature flag (env var or constant) so we can re-run eval and compare with/without.
- Cost: +1 nano call per question (~$0.0005). Latency: +1-2s.
- Acceptance: re-run `eval.py`, Q8 should produce a real answer; no regression on Q7/Q9 (the traps must still abstain).

**Why HyDE wasn't done in v1:** premature optimization without measurement. Now we have data showing where it matters.

### 3. Railway deploy (target ~12:30, hour 3 marker)

Already-installed Railway CLI. Two services in one project, EU West Metal region. See `DEPLOY.md` and the Codex prompt at the end of that file. Brief outline:
- `railway login`, `railway init` (project root), name like `bocconi-buddy-louis`.
- Backend: `cd backend && railway up`, set `OPENAI_API_KEY`, `railway domain`.
- Frontend: new service in same project, set `VITE_BACKEND_URL` to backend URL **before** build, `railway up`, `railway domain`.
- Smoke test: `curl https://<backend-url>/health` and one `/ask`.

The Dockerfile at `backend/Dockerfile` already COPYs `data/` (which includes our 148 MB index). The `.dockerignore` does NOT exclude the index. Confirmed.

## Cost ledger

| Item | Spent |
|---|---|
| Embed corpus (one-time) | ~$0.46 |
| Eval run v1 (10 questions) | ~$0.30 |
| Eval run v2 (10 questions) | ~$0.30 |
| **Total so far** | **~$1.06 of $50** |

Plenty of budget left for HyDE iteration + final 80-question eval.

## Critical constraints (don't violate)

- `/ask` schema is **frozen**. Any deviation = -15 × 80 = -1200 floor on Level 1.
- 30s latency per request (system errors and over-limit count as wrong, -15).
- Reply in same language as question (84% EN, 16% IT in the real eval).
- Cite real paths from `data/`. Fabricated citations = -15.
- All 4 verticali must be covered.

## How to verify everything still works (when fresh session opens)

```bash
# 1. Containers up?
docker ps --format 'table {{.Names}}\t{{.Status}}'

# 2. Backend healthy and indexes loaded?
curl -s http://localhost:8000/health
docker logs starter-backend-1 2>&1 | grep "loaded"

# 3. /ask functional?
curl -s -X POST http://localhost:8000/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"What documents do I need to access the Bocconi library?"}'
```

If all three pass, the backend is solid and the next move is the frontend (or HyDE if frontend is already done).

If containers aren't running:
```bash
cd "/Users/louis/bocconi hackathon/starter"
docker compose -f docker-compose.dev.yml up -d
```
