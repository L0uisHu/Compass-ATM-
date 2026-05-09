# Bocconi Compass — session boot

> Read this file first. It's the minimum context to pick up the work where the
> last session left off. For a deeper handoff (full history, eval table, decisions)
> read `STATE.md`. For the challenge spec read `BRIEF.md`. For the technical
> contract read `AGENTS.md`.

Today is **2026-05-09 — hackathon day**. Deadline is **16:00**. Started ~10:06.
This file written ~13:35. ~2h 25min left when this was written.

## Working agreement (load-bearing)

**Claude is the brain. Codex is the muscle.** The user has unlimited Codex usage
(via ChatGPT subscription) and limited Claude usage. **All implementation goes
to Codex** — backend, frontend, eval, deploy, refactors, bug fixes. Default to
writing a precise rescue brief, not editing files.

Reserve direct Claude file edits for: integration glue after Codex lands, one-line
config fixes, reading files for diagnostic/audit purposes (not editing), running
docker / shell commands that Codex's sandbox blocks.

**To invoke Codex**, use the `Agent` tool with `subagent_type: "codex:codex-rescue"`.
Do NOT use the `Skill` tool with `codex:rescue` or `codex:codex-rescue` — the Skill
form re-enters the slash command and hangs the session.

**Always start a Codex brief with `--fresh --background`** as the first line, then
"Begin by writing a single-line acknowledgement of this brief, then list the
prereq files you will read in order. Only after that, start the actual work."
This forces visible output before the first hang risk.

## What's built and running

### Backend (FastAPI, Python 3.13, in `backend/`)
- `prompts.py` — base abstention/citation rules + per-verticale prompt addenda.
  The single highest-leverage line: *"If the sources do not contain the
  information needed to answer, abstain in the user's language."*
- `rag.py` — full pipeline: chunking, FAISS + BM25 hybrid retrieval, RRF merge,
  MMR diversify, batched GPT-5.4-nano rerank (1 call per question), confidence
  gate (top score < 4.0/10 → abstain), GPT-5.5 generation. **HyDE behind
  `USE_HYDE` env flag (default 0, leave OFF — see "HyDE decision" below).**
- `main.py` — FastAPI app with `lifespan` that loads the index once at startup.
- `scripts/build_index.py` — one-shot indexer (already run, do not rerun).
- `scripts/eval.py` — runs the 10 SAMPLE_QUESTIONS through `/ask`. Writes to
  `eval_results_no_hyde.json` or `eval_results_hyde.json` based on `USE_HYDE`.

### Index (already built, persisted in `backend/data/index/`)
- `faiss.index` — 123 MB, 10,523 vectors × 3072 dims (text-embedding-3-large)
- `chunks.jsonl` — 15 MB
- `bm25.pkl` — 10 MB
- Bundled into the production Docker image via `backend/Dockerfile` + `.dockerignore`.

### Frontend (React 19 + TypeScript + Vite, in `frontend/`)
- Single `App.tsx` (~1245 lines) — useReducer state machine, mode-aware chat,
  citation pre-pass, evidence drawer, mode panel with parsed action items, voice
  input via Web Speech API + AI brain visual via Web Audio AnalyserNode.
- Custom CSS in `src/index.css` (~890 lines) hits the design tokens via OKLCH
  CSS variables in both `@theme inline {}` (Tailwind v4) and `:root {}` (fallback).
- Deps installed: tailwindcss, lucide-react, react-markdown, framer-motion,
  shadcn/Radix substrate. Codex committed to vanilla CSS before knowing deps were
  available, so the libs are mostly unused — but installed so they CAN be used
  in any polish refactor.

### Dev environment
- `docker-compose.dev.yml` runs backend at `:8000` and frontend at `:5173`.
- Backend hot-reloads on Python file changes (uvicorn `--reload`).
- Frontend hot-reloads via Vite.
- `OPENAI_API_KEY` lives in `/Users/louis/bocconi hackathon/starter/.env` (gitignored).

## Frozen contract — DO NOT change

`POST /ask`:
- Request: `{"question": str}`
- Response: `{"answer": str, "sources": list[str], "verticale": "relocation"|"life_on_campus"|"study_abroad"|"career_readiness"}`
- Always 200 (even for "I don't know"). 30s hard wall.
- Reply in the question's language.
- Cite real paths from `backend/data/` corpus. **No fabricated citations.**

## Critical constraints (don't violate)

- `/ask` schema is **frozen**.
- 30s latency wall — over-limit counts as wrong (-15 each, on 80 questions).
- Reply in same language as question (84% EN, 16% IT in the real eval).
- All 4 verticali required: `relocation`, `life_on_campus`, `study_abroad`,
  `career_readiness`.

## HyDE decision (made 2026-05-09 ~13:30)

Implemented behind `USE_HYDE` env flag. Compared on the 10 sample questions
(both `eval_results_no_hyde.json` and `eval_results_hyde.json` exist):

| Q | baseline | hyde | verdict |
|---|---|---|---|
| Q7 MIT trap | abstain | abstain | trap preserved ✓ |
| Q8 Merit Award (target gap) | abstain | abstain | did NOT close gap |
| Q9 BESS 2026 trap | abstain | abstain | trap preserved ✓ |

Latency: +0.4s/q on average. Other answers shift slightly (Q5, Q10) but it's mixed.

**Decision: ship the final 80-question eval with `USE_HYDE=0`.** The code stays
in (we paid for it) but the flag stays off. Don't enable without re-running the
comparison. Logs from the run did confirm HyDE generates fully fabricated trap
content for Q7/Q9 and the rerank+gate filter it — the "candidate generation
only" architecture works as designed.

## Codex sandbox quirks (known limitations)

When Codex runs in the background via `subagent_type: "codex:codex-rescue"`:
- **DNS to npm registry blocked** — Codex can't run `pnpm add`/`pnpm install`.
  If the brief needs new deps, install them from the host first.
- **Docker socket blocked** in some workspaces (was open in frontend rescue,
  blocked in HyDE rescue — unclear why). If Codex needs `docker compose exec`,
  expect it to fail; you (Claude) run those commands directly.
- **`apply_patch` tool is sandbox-scoped** to wherever the worker's CWD is at
  spawn time. If you spawn a Codex job while `cd`'d into `frontend/`, it can't
  patch files in `backend/` via the tool — but shell-based writes (`cat >`,
  `sed -i`, python heredocs) work. To avoid: `cd` to `starter/` before spawning
  any Codex job that touches the wider repo.
- **First job after a long idle can hang silently** — the very first Codex
  rescue we sent wrote `[codex] Turn started` then never produced output for 30
  min. The fix was `--fresh` + a forced-acknowledgement instruction at the top
  of the brief. Always include both.

## How to verify everything still works (fresh-session smoke test)

```bash
# Containers up?
docker ps --format 'table {{.Names}}\t{{.Status}}'

# Backend healthy + indexes loaded?
curl -s http://localhost:8000/health
docker logs starter-backend-1 2>&1 | grep "loaded"

# /ask functional?
curl -s -X POST http://localhost:8000/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"What documents do I need to access the Bocconi library?"}'

# Frontend up?
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173
```

If containers aren't running:
```bash
cd "/Users/louis/bocconi hackathon/starter"
docker compose -f docker-compose.dev.yml up -d
```

To toggle HyDE for testing:
```bash
USE_HYDE=1 docker compose -f docker-compose.dev.yml up -d backend  # on
USE_HYDE=0 docker compose -f docker-compose.dev.yml up -d backend  # off
```

To re-run the eval against localhost:
```bash
cd "/Users/louis/bocconi hackathon/starter/backend" && uv run python -u scripts/eval.py
```

## Cost ledger

| Item | Spent |
|---|---|
| Embed corpus (one-time) | ~$0.46 |
| Eval v1 + v2 + HyDE comparison (40 questions total) | ~$0.90 |
| **Total** | **~$1.36 of $50** |

Plenty of budget left for the final 80-question eval (~$2-3).

## Next move queued — Railway deploy

The user's next ask is: **deploy backend on Railway.** The artifacts are in
place:
- `backend/Dockerfile` (production, separate from `Dockerfile.backend` which is dev) — uses `${PORT:-8000}`, COPYs `data/` (index ships with the image)
- `backend/.dockerignore` — strips `.venv`, `.env` (secrets stay out)
- `backend/railway.json` — DOCKERFILE builder, `/health` check, 60s timeout
- Railway CLI installed (v4.57.1) but not yet logged in

Three deploy gotchas to remember:
1. **`OPENAI_API_KEY` must be set in Railway after `railway init`** — `.dockerignore`
   correctly strips `.env` so the key won't be baked into the image.
2. **Frontend `VITE_BACKEND_URL` must be set BEFORE the frontend build** — Vite
   bakes env vars at build time, not runtime. So order is: deploy backend → grab its
   URL → set var on frontend service → THEN build/deploy frontend.
3. **First container boot will take 10–20s** (loading 148 MB FAISS + unpickling
   BM25). The 60s healthcheck timeout absorbs it; bump it if it ever flakes.

The plan: write a Codex rescue brief that handles `railway login` (interactive
— may need user help), `railway init`, `railway up` for backend, set env var,
get domain, smoke-test, then repeat for frontend. See `DEPLOY.md` for the
detailed Railway flow if needed.
