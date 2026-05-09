"""Bocconi AI Buddy — backend entry point.

POST /ask is the frozen contract evaluated by the hackathon scorer.
The pipeline lives in rag.py; this file only handles HTTP, CORS, and startup.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Load .env from project root and from backend/.env (whichever exists)
from pathlib import Path
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env")

import rag

STATE: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load FAISS + BM25 + chunks once at startup. No embedding calls here."""
    try:
        STATE.update(rag.load_state())
        print(f"[startup] loaded {len(STATE['chunks'])} chunks, indexes ready")
    except Exception as e:
        # Don't crash the app — /ask will detect missing state and return a clean 200.
        # This lets /health stay green while we wait for a first index build.
        print(f"[startup] WARNING: indexes not loaded: {e}")
    yield


app = FastAPI(title="Bocconi AI Buddy", lifespan=lifespan)


_allowed = [
    o.strip()
    for o in (os.environ.get("FRONTEND_URL") or "*").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


Verticale = Literal["relocation", "life_on_campus", "study_abroad", "career_readiness"]


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1)


class AskResponse(BaseModel):
    answer: str
    sources: list[str]
    verticale: Verticale


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ask", response_model=AskResponse)
def ask(request: AskRequest) -> AskResponse:
    if not STATE.get("chunks"):
        # Indexes weren't loaded (likely build_index.py hasn't run yet).
        # Return a graceful 200 so the evaluator scores `no_answer` (0) instead of `wrong` (-15).
        return AskResponse(
            answer="The knowledge base is not yet loaded. Please try again shortly.",
            sources=[],
            verticale="life_on_campus",
        )
    try:
        result = rag.answer_question(STATE, request.question)
    except Exception as e:
        # Last-resort: return graceful abstention rather than 5xx (which scores wrong).
        print(f"[/ask] error: {type(e).__name__}: {e}")
        return AskResponse(
            answer=rag.abstain_message(request.question),
            sources=[],
            verticale="life_on_campus",
        )
    return AskResponse(**result)
