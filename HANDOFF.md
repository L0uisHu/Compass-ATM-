# Compass ATM — session handoff

> Context for next Claude session. Paste this whole file in or just `Read` it.

## TL;DR (read this first)
Hackathon project: a RAG-based AI buddy for Bocconi students ("Ask Bocconi. Navigate Milan.").
Backend deployed and tuned; frontend redesigned and rendering correctly locally; **frontend not deployed yet** (deploys to Railway, not Vercel — user's correction).

## Live URLs
- **Backend (production):** https://compass-atm-production.up.railway.app
- **GitHub repo:** https://github.com/L0uisHu/Compass-ATM- (public; flip private with `gh repo edit L0uisHu/Compass-ATM- --visibility private --accept-visibility-change-consequences`)
- **GitHub Release with FAISS index:** https://github.com/L0uisHu/Compass-ATM-/releases/tag/rag-index-v1 (the Dockerfile fetches `faiss.index` from here at build time)

## Repo layout
```
/Users/louis/bocconi hackathon/
├── starter/
│   ├── backend/              # FastAPI + uv + RAG (production-deployed)
│   │   ├── Dockerfile        # Fetches faiss.index from GitHub Release at build
│   │   ├── main.py           # /ask + /health endpoints
│   │   ├── rag.py            # Pipeline (embed → BM25 → RRF → MMR → rerank → gate → generate)
│   │   ├── prompts.py        # System prompts (per-vertical)
│   │   ├── data/             # Knowledge corpus + index files (chunks.jsonl, bm25.pkl)
│   │   └── scripts/eval.py   # Local 10-question eval (manual grade)
│   └── frontend/             # Vite + React + TS + Tailwind v4
│       ├── REDESIGN_PLAN.md  # The redesign spec (already implemented)
│       ├── vite.config.ts    # MUST include @tailwindcss/vite plugin (see Gotchas)
│       └── src/{App.tsx, index.css, main.tsx}
├── DEPLOY.md                 # Railway deploy guide (still says Vercel for frontend — outdated)
└── BRIEF.md, AGENTS.md, ...  # Hackathon docs
```

## Backend state — DEPLOYED, all changes live
Currently in Railway project `beneficial-youth`, service `Compass-ATM-`, region **EU West**.

### Tuning shipped (vs original)
| Constant / behavior | Original | Now | Why |
|---|---|---|---|
| `_call_answer_model` retries | 3 attempts × 25s | 1 attempt × 22s | Killed the 75s tail latency |
| Retry on `APITimeoutError` | yes | no | One timeout = abstain (0 > -5) |
| `max_completion_tokens` | 3000 | 1500 | Bound generation latency |
| `CONFIDENCE_THRESHOLD` | 4.0 | 3.0 | Convert no_answers to attempts |
| `MMR_KEEP` | 20 | 14 | Faster rerank |
| `RERANK_KEEP` | 8 | 10 | More context to answer model |
| `DENSE_TOP_K`, `BM25_TOP_K` | 30, 30 | 50, 50 | Better recall (in-memory, free) |
| New COMPLETENESS rule in `prompts.py` | — | added | Convert partials → corrects |
| `AttributeError` catch on rerank parse | missing | added | Bug: malformed JSON silently killed requests |

### Key bug found and fixed
Rerank model occasionally returns `{"scores": [5, 7, ...]}` instead of `{"scores": [{"id":0,"score":5}, ...]}`. The original `except (TypeError, ValueError)` didn't catch the resulting `AttributeError`, so the whole `/ask` request crashed → main.py returned the abstain message → graded as wrong/no_answer. Fix at `rag.py` ~line 483.

### Score history
- **Run #73:** 95/160 (7C/5P/4N/0W). User flagged this as starting point.
- **Target:** 130+ minimum.
- **Latest run:** unknown — pending. User was waiting 10 min between tests.

### To redeploy backend
```bash
cd "/Users/louis/bocconi hackathon/starter/backend"
railway up --ci
```
Railway is logged in (token cached). Service is linked to `beneficial-youth/Compass-ATM-`.

## Frontend state — WORKING LOCALLY, not deployed
Verified locally with `npm run dev` + headless browser screenshots on 2026-05-09:
- Desktop @ 1280×800: hero, mission chips, suggestion grid, composer, evidence panel — all polished, off-white/dark-ink, accent `#1F3A8A`.
- Mobile @ 360×800: tagline hidden, chip strip scrolls, suggestions single-column, composer sticky.
- Chat flow end-to-end: click suggestion → POST /ask → answer card with verticale badge + sources count + evidence in right rail.
- Markdown bold/italic render; `[source: ...]` markers stripped from prose.
- Production `npm run build`: passes, 23 KB CSS / 213 KB JS (5.47 / 67.57 KB gzipped).

### What was rebuilt
- `App.tsx`: rewritten ~1123 lines, six `useState`s, AbortController 30s timeout, lucide-react icons. Stripped voice/canvas/confidence-pill/per-vertical-helpers/useReducer.
- `index.css`: 921 → 56 lines. Tailwind v4 `@theme inline` declares all design tokens.
- `index.html`: dropped Google Fonts (system stack), inline SVG compass favicon, `lang="en"`.
- `REDESIGN_PLAN.md`: the spec — read it before changing the frontend.

### Cosmetic polish remaining (NOT bugs, NOT blocking)
1. `labelFromPath` derives source labels like `"Bocconi Help · 4405876182418 How Do I Get Into The Library"` — leaves the article ID number in. 5-min regex fix in `App.tsx`.
2. Path caption shows `bit.uniboccon.it` instead of full domain (treats hyphenated slug as a domain). Same function.

## To deploy frontend (when user gives green light)
**Per user's correction: Railway, not Vercel.** Add it as a second service in the same Railway project:
```bash
cd "/Users/louis/bocconi hackathon/starter/frontend"
railway link --project beneficial-youth     # if not already linked
railway add --service compass-atm-web       # second service in same project
railway service compass-atm-web             # link CLI to it
railway variables --set VITE_BACKEND_URL=https://compass-atm-production.up.railway.app
railway up                                   # build + deploy
railway domain                               # generate public URL
```
The frontend's existing `frontend/railway.json` already configures `npm run build` + `vite preview`. **Set `VITE_BACKEND_URL` BEFORE the build** — Vite inlines env vars at build time, not runtime.

## Gotchas / pitfalls that ate hours

### 1. Railway `railway up` silently drops files >~100MB
The 129 MB `faiss.index` file refused to upload. No error, just absent in the deployed image. **Fix in place:** Dockerfile has a `RUN python -c "urllib.request.urlretrieve(...)"` step that fetches it from the GitHub Release `rag-index-v1` at build time. URL is hard-coded — if you regenerate the index, upload to a new release tag and bump `FAISS_INDEX_URL` in `Dockerfile`.

### 2. Tailwind v4 needs the `@tailwindcss/vite` plugin EXPLICITLY in `vite.config.ts`
Installing the package isn't enough. Without the plugin registered, `@theme` / `@tailwind utilities` pass through as unknown at-rules and the browser ignores them — page renders as raw unstyled text in DOM order. **Fix in place** at `vite.config.ts`:
```ts
import tailwindcss from '@tailwindcss/vite'
plugins: [react(), tailwindcss()],
```
**Lesson: `npm run build` succeeded with warnings even when zero utilities applied. Always render the page once.**

### 3. GitHub Auto-deploy on the Railway service is a trap
The Railway service is linked to the GitHub repo. Pushing to GitHub may trigger an auto-deploy that fails (Railway can't find the Dockerfile at repo root — it lives at `starter/backend/`). The auto-deploy failure does NOT take down the URL — the previous successful `railway up` deploy keeps serving. So if you see "Deploy failed" in the Railway dashboard after a `git push`, ignore it; the production URL is fine. To clear the noise: in Railway dashboard, disconnect the GitHub integration on `Compass-ATM-` service.

### 4. Don't push the 129 MB faiss.index to GitHub
GitHub blocks files >100 MB. The original `.gitignore` had `*.index` which excluded it. Earlier session work tried to negate that (`!faiss.index`) to get Railway to upload — that didn't help (Railway dropped it anyway, see Gotcha 1). Current `.gitignore` is back to ignoring it. Do not re-add the negation.

### 5. The `_call_answer_model` retry decorator is now `@retry(stop=stop_after_attempt(1))`
Looks pointless. Keep it — the decorator still gives us tenacity's typed exception filter and is the place to add retries back if needed (e.g., per-vertical rate-limit retry). Don't strip it.

### 6. Local `eval.py` script's own 30s timeout
The eval script has its own request timeout. With the original `timeout=25` + 3 retries, it would mark requests "ERROR" at 30s. Now with 22s + 1 attempt, it stays under the eval cap.

## User preferences (from CLAUDE.md + memory)
- **Direct tone, no fluff.** Lead with the answer.
- **Teaching cadence:** explain non-obvious patterns by name; one probing question after big features.
- **Codex is the muscle, Claude is the brain.** User has unlimited Codex / limited Claude — delegate implementation via `/codex:rescue` or subagents when typing volume is high. Diagnosis + decisions stay with Claude.
- **No Co-Authored-By: Claude trailer in commits.** User flagged this explicitly. Commit as the user (`Louis Hu <louishu2@gmail.com>`).
- **Don't auto-deploy frontend** — user wants to test first.
- **TypeScript strict, no `any` unless justified inline.**
- **Comments only when WHY is non-obvious.**

## Useful commands cheatsheet
```bash
# Inspect Railway state
cd "/Users/louis/bocconi hackathon/starter/backend"
railway status
railway variables                              # show env vars
railway logs                                   # runtime logs
railway logs --build <deployment-id>           # build logs

# Backend redeploy
cd "/Users/louis/bocconi hackathon/starter/backend"
railway up --ci                                # builds + deploys

# Backend smoke test
curl https://compass-atm-production.up.railway.app/health
curl -X POST https://compass-atm-production.up.railway.app/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"How do I open an Italian bank account?"}'

# Local eval (10 questions, manual grading)
cd "/Users/louis/bocconi hackathon/starter/backend"
uv run python scripts/eval.py --backend https://compass-atm-production.up.railway.app

# Frontend dev
cd "/Users/louis/bocconi hackathon/starter/frontend"
VITE_BACKEND_URL=https://compass-atm-production.up.railway.app npm run dev

# Frontend build verify
cd "/Users/louis/bocconi hackathon/starter/frontend"
npm run build
```

## If the next score is still below 130, levers I haven't pulled
1. `CONFIDENCE_THRESHOLD 3.0 → 2.5` — converts more no_answers; raises wrong-answer risk. Math: as long as ≥33% of newly-let-through borderline answers are correct (vs wrong), net positive.
2. `RERANK_KEEP 10 → 12` — more context to answer model. Costs ~1-2s.
3. **Per-vertical thresholds** — keep `life_on_campus` strict, drop others. Requires editing `answer_question` to look up threshold by `chosen_verticale`.
4. **Inspect weak-vertical corpora** in `data/life_on_campus/` and `data/career_readiness/` — partials there suggest missing source pages or chunk-size mismatch with question vocabulary.
5. **Switch `ANSWER_MODEL` from gpt-5.5 to gpt-5.4** — risky (no time to validate quality), but if latency is still the issue, this halves it. Test first via local eval before deploying.

## Outstanding decisions for next session
- Frontend deploy: when user says go, use Railway commands above.
- Cosmetic polish on `labelFromPath` (5-min) — only if score is locked.
- Whether to disconnect GitHub auto-deploy on the backend Railway service to silence the false-failure dashboard noise.

## Last commit on main
- `fa3651e` — "Backend tuning + frontend redesign" (8 files, +1633 -2179)
- Pushed to `origin/main`. Author: Louis Hu only.
