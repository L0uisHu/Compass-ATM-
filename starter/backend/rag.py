"""RAG engine for the AI Buddy.

Pipeline:
    question
      -> embed + BM25 search   (hybrid retrieval)
      -> RRF merge             (combine the two rankings)
      -> MMR diversity         (drop near-duplicates)
      -> LLM rerank            (GPT-5.4-nano scores each chunk)
      -> confidence gate       (abstain if best score is too low)
      -> generation            (GPT-5.4 with cited chunks)
      -> {answer, sources, verticale}

All state lives in the module-level `STATE` dict, populated by `load_state()`
at FastAPI startup. No globals are mutated after startup.
"""

from __future__ import annotations

import json
import os
import pickle
import re
from collections import Counter
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

import faiss
import numpy as np
import tiktoken
import yaml
from openai import OpenAI
from rank_bm25 import BM25Okapi
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from openai import RateLimitError, APIError, APITimeoutError

from prompts import build_system_prompt, RERANK_PROMPT, Verticale, VERTICALE_ADDENDA


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DATA_DIR = Path(__file__).parent / "data"
INDEX_DIR = DATA_DIR / "index"

EMBED_MODEL = "text-embedding-3-large"
RERANK_MODEL = "gpt-5.4-nano"
ANSWER_MODEL = "gpt-5.5"
USE_HYDE = os.getenv("USE_HYDE", "0").strip().lower() in ("1", "true")

EMBED_DIM = 3072  # text-embedding-3-large dimension

# Chunking
CHUNK_TARGET_TOKENS = 800
CHUNK_OVERLAP_TOKENS = 100
EMBED_BATCH_SIZE = 128

# Retrieval
DENSE_TOP_K = 30
BM25_TOP_K = 30
RRF_K = 60  # Reciprocal Rank Fusion constant; 60 is the standard value
MMR_LAMBDA = 0.7  # 1.0 = pure relevance, 0.0 = pure diversity
MMR_KEEP = 20  # how many chunks survive MMR before LLM rerank
RERANK_KEEP = 8  # final number of chunks shown to the answer model
CONFIDENCE_THRESHOLD = 4.0  # rerank score (0-10); below -> abstain

VERTICALES: list[Verticale] = ["relocation", "life_on_campus", "study_abroad", "career_readiness"]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    """A single retrievable unit of text."""
    chunk_id: int            # position in the global chunk list
    file_path: str           # relative to data/, e.g. "career_readiness/msc-finance.md"
    verticale: Verticale
    title: str
    breadcrumb: str          # e.g. "MSc Finance > Curriculum > Year 1"
    text: str                # raw chunk text (without prefix)
    token_count: int

    def embed_input(self) -> str:
        """The string we feed to the embedding model — text plus context prefix."""
        return f"[{self.verticale}] {self.title}\n{self.breadcrumb}\n\n{self.text}"


# ---------------------------------------------------------------------------
# Frontmatter + chunking
# ---------------------------------------------------------------------------

_TIKTOKEN_ENC = tiktoken.get_encoding("o200k_base")
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)


def parse_frontmatter(raw: str) -> tuple[dict, str]:
    """Split YAML frontmatter from body. Returns ({} , raw) if no frontmatter."""
    m = _FRONTMATTER_RE.match(raw)
    if not m:
        return {}, raw
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        meta = {}
    return meta, raw[m.end():]


def count_tokens(text: str) -> int:
    return len(_TIKTOKEN_ENC.encode(text))


def split_on_headings(body: str) -> list[tuple[str, str]]:
    """Split markdown body on H1/H2/H3 headings.

    Returns a list of (breadcrumb, section_text) where breadcrumb is
    e.g. "MSc Finance > Curriculum > Year 1" reconstructed from heading levels.
    """
    lines = body.split("\n")
    sections: list[tuple[str, list[str]]] = []
    crumb_stack: list[str] = []  # one entry per heading level we're currently inside
    current: list[str] = []

    def flush():
        if current and any(line.strip() for line in current):
            sections.append((" > ".join(crumb_stack) if crumb_stack else "", current.copy()))
        current.clear()

    for line in lines:
        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            flush()
            level = len(m.group(1))
            heading = m.group(2).strip()
            # truncate stack to level-1, then push the new heading
            crumb_stack[:] = crumb_stack[: level - 1] + [heading]
        else:
            current.append(line)
    flush()
    return [(crumb, "\n".join(text)) for crumb, text in sections]


def slide_split(text: str, target: int, overlap: int) -> list[str]:
    """Split a long string into ~target-token windows with overlap."""
    tokens = _TIKTOKEN_ENC.encode(text)
    if len(tokens) <= target:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(tokens):
        end = min(start + target, len(tokens))
        chunks.append(_TIKTOKEN_ENC.decode(tokens[start:end]))
        if end == len(tokens):
            break
        start = end - overlap
    return chunks


def chunk_file(file_path: str, meta: dict, body: str) -> list[Chunk]:
    """Turn one markdown file into a list of Chunk objects."""
    verticale = meta.get("verticale")
    title = meta.get("title") or Path(file_path).stem
    if verticale not in VERTICALES:
        # If frontmatter is missing or wrong, fall back to the parent folder name.
        verticale = file_path.split("/")[0] if "/" in file_path else "career_readiness"

    out: list[Chunk] = []
    for breadcrumb, section_text in split_on_headings(body):
        section_text = section_text.strip()
        if not section_text:
            continue
        # If the section is short, ship it as one chunk; else slide-window split.
        if count_tokens(section_text) <= CHUNK_TARGET_TOKENS:
            pieces = [section_text]
        else:
            pieces = slide_split(section_text, CHUNK_TARGET_TOKENS, CHUNK_OVERLAP_TOKENS)
        for piece in pieces:
            out.append(
                Chunk(
                    chunk_id=-1,  # set after global numbering
                    file_path=file_path,
                    verticale=verticale,
                    title=title,
                    breadcrumb=breadcrumb,
                    text=piece,
                    token_count=count_tokens(piece),
                )
            )
    return out


def load_all_chunks() -> list[Chunk]:
    """Walk data/<verticale>/*.md, parse, chunk, return a flat list."""
    chunks: list[Chunk] = []
    for verticale in VERTICALES:
        folder = DATA_DIR / verticale
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.md")):
            raw = path.read_text(encoding="utf-8")
            meta, body = parse_frontmatter(raw)
            rel_path = f"{verticale}/{path.name}"
            chunks.extend(chunk_file(rel_path, meta, body))
    for i, c in enumerate(chunks):
        c.chunk_id = i
    return chunks


# ---------------------------------------------------------------------------
# Tokenization for BM25
# ---------------------------------------------------------------------------

_BM25_TOKEN_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9]+")


def bm25_tokenize(text: str) -> list[str]:
    """Cheap multilingual tokenizer for BM25: lowercase + split on non-alnum.

    BM25 is bag-of-words; we don't need a fancy tokenizer. We do want to
    keep accented characters (Italian) and acronyms.
    """
    return [t.lower() for t in _BM25_TOKEN_RE.findall(text)]


# ---------------------------------------------------------------------------
# Embeddings
# ---------------------------------------------------------------------------

def get_client() -> OpenAI:
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


@retry(
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type((RateLimitError, APIError, APITimeoutError)),
)
def embed_batch(client: OpenAI, texts: list[str]) -> np.ndarray:
    resp = client.embeddings.create(model=EMBED_MODEL, input=texts)
    arr = np.array([d.embedding for d in resp.data], dtype=np.float32)
    # Normalize for cosine similarity via inner product on a flat IP index
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


def embed_query(client: OpenAI, text: str) -> np.ndarray:
    return embed_batch(client, [text])[0]


def hyde_query(question: str) -> str:
    """Generate a retrieval-only hypothetical passage for HyDE."""
    try:
        resp = get_client().chat.completions.create(
            model=RERANK_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are simulating a passage from official Bocconi documentation. "
                        "Write a 2-3 sentence plausible answer to the question as if it were "
                        "copied verbatim from a Bocconi web page or PDF. Be specific (include "
                        "numbers, dates, names if relevant) — even if you have to estimate. "
                        "This text is used only for retrieval, never shown to the user. Do NOT "
                        "refuse, do NOT say 'I don't know', do NOT add disclaimers. Reply in "
                        "the question's language."
                    ),
                },
                {"role": "user", "content": question},
            ],
            max_completion_tokens=180,
        )
    except Exception as e:
        print(f"[hyde] WARNING: failed to generate hypothetical passage: {type(e).__name__}: {e}")
        return ""

    hypo = (resp.choices[0].message.content or "").strip()
    if not hypo:
        print("[hyde] WARNING: generated empty hypothetical passage")
        return ""
    return hypo


# ---------------------------------------------------------------------------
# Index build / load
# ---------------------------------------------------------------------------

def build_and_save(chunks: list[Chunk], client: OpenAI) -> None:
    INDEX_DIR.mkdir(parents=True, exist_ok=True)

    # Dense index
    print(f"Embedding {len(chunks)} chunks in batches of {EMBED_BATCH_SIZE}...")
    vecs: list[np.ndarray] = []
    for i in range(0, len(chunks), EMBED_BATCH_SIZE):
        batch = chunks[i : i + EMBED_BATCH_SIZE]
        inputs = [c.embed_input() for c in batch]
        vecs.append(embed_batch(client, inputs))
        print(f"  {i + len(batch)} / {len(chunks)}")
    matrix = np.vstack(vecs).astype(np.float32)

    index = faiss.IndexFlatIP(EMBED_DIM)  # inner product on normalized vectors == cosine
    index.add(matrix)
    faiss.write_index(index, str(INDEX_DIR / "faiss.index"))
    print(f"FAISS index saved: {matrix.shape[0]} vectors x {matrix.shape[1]} dims")

    # Chunks (text + metadata)
    with open(INDEX_DIR / "chunks.jsonl", "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(asdict(c), ensure_ascii=False) + "\n")
    print(f"chunks.jsonl saved: {len(chunks)} entries")

    # BM25 index (over the embed_input strings — same context the dense side sees)
    tokenized = [bm25_tokenize(c.embed_input()) for c in chunks]
    bm25 = BM25Okapi(tokenized)
    with open(INDEX_DIR / "bm25.pkl", "wb") as f:
        pickle.dump(bm25, f)
    print("BM25 index saved")


def load_state() -> dict:
    """Load all indexes from disk into a state dict. Called at app startup."""
    if not INDEX_DIR.exists():
        raise RuntimeError(
            f"Index directory not found at {INDEX_DIR}. "
            "Run `uv run python scripts/build_index.py` first."
        )
    chunks: list[Chunk] = []
    with open(INDEX_DIR / "chunks.jsonl", "r", encoding="utf-8") as f:
        for line in f:
            chunks.append(Chunk(**json.loads(line)))
    index = faiss.read_index(str(INDEX_DIR / "faiss.index"))
    with open(INDEX_DIR / "bm25.pkl", "rb") as f:
        bm25 = pickle.load(f)
    return {"chunks": chunks, "faiss": index, "bm25": bm25}


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

def dense_search(state: dict, query_vec: np.ndarray, k: int) -> list[tuple[int, float]]:
    """Return list of (chunk_id, score) sorted by descending score."""
    scores, idxs = state["faiss"].search(query_vec.reshape(1, -1).astype(np.float32), k)
    return [(int(i), float(s)) for i, s in zip(idxs[0], scores[0]) if i != -1]


def bm25_search(state: dict, query: str, k: int) -> list[tuple[int, float]]:
    tokens = bm25_tokenize(query)
    scores = state["bm25"].get_scores(tokens)
    top = np.argsort(scores)[::-1][:k]
    return [(int(i), float(scores[i])) for i in top if scores[i] > 0]


def rrf_merge(*rankings: list[tuple[int, float]], k: int = RRF_K) -> list[tuple[int, float]]:
    """Reciprocal Rank Fusion — merge multiple rankings into one.

    For each item, sum 1 / (k + rank) across rankings it appears in.
    Robust to score-scale mismatch between dense (0..1) and BM25 (0..unbounded).
    """
    rrf: dict[int, float] = {}
    for ranking in rankings:
        for rank, (chunk_id, _score) in enumerate(ranking):
            rrf[chunk_id] = rrf.get(chunk_id, 0.0) + 1.0 / (k + rank + 1)
    return sorted(rrf.items(), key=lambda x: x[1], reverse=True)


def mmr_diversify(
    candidate_ids: list[int],
    query_vec: np.ndarray,
    state: dict,
    keep: int,
    lam: float = MMR_LAMBDA,
) -> list[int]:
    """Maximal Marginal Relevance: pick chunks that are relevant AND mutually distinct.

    Greedy: at each step, pick the candidate maximizing
        lam * sim(query, c) - (1 - lam) * max_{p in picked} sim(p, c)
    """
    if len(candidate_ids) <= keep:
        return candidate_ids

    # Reconstruct candidate vectors from FAISS (it stores them since we used IndexFlatIP)
    cand_vecs = np.vstack(
        [state["faiss"].reconstruct(cid) for cid in candidate_ids]
    ).astype(np.float32)
    q = query_vec.astype(np.float32)
    sim_to_query = cand_vecs @ q  # cosine since both are normalized

    picked: list[int] = []
    picked_idx: list[int] = []
    remaining = list(range(len(candidate_ids)))
    while remaining and len(picked) < keep:
        best_score = -1e9
        best_local = remaining[0]
        for local in remaining:
            relevance = sim_to_query[local]
            if picked_idx:
                redundancy = max(float(cand_vecs[local] @ cand_vecs[p]) for p in picked_idx)
            else:
                redundancy = 0.0
            mmr_score = lam * relevance - (1 - lam) * redundancy
            if mmr_score > best_score:
                best_score = mmr_score
                best_local = local
        picked.append(candidate_ids[best_local])
        picked_idx.append(best_local)
        remaining.remove(best_local)
    return picked


# ---------------------------------------------------------------------------
# LLM rerank (GPT-5.4-nano scores each chunk)
# ---------------------------------------------------------------------------

BATCH_RERANK_PROMPT = """You are scoring how relevant each document chunk is for answering a user's question.
For each chunk, output an integer score 0-10:
  0 = completely unrelated
  5 = mentions the topic but doesn't answer the question
  10 = directly answers the question

Respond with ONLY a JSON object of the form {{"scores": [{{"id": 0, "score": 7}}, ...]}}
— one entry per chunk, in the same order. No explanation. No markdown.

Question: {question}

Chunks:
{chunks_block}"""


def _format_chunks_for_rerank(chunks: list[Chunk]) -> str:
    parts = []
    for i, c in enumerate(chunks):
        body = c.embed_input()
        if len(body) > 1200:
            body = body[:1200]
        parts.append(f"[{i}] {body}")
    return "\n\n".join(parts)


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type((RateLimitError, APIError, APITimeoutError)),
)
def llm_rerank(
    client: OpenAI,
    question: str,
    candidates: list[Chunk],
) -> list[tuple[Chunk, float]]:
    """Score all candidates in a single nano call. Returns sorted desc by score.

    The single-call form trades 20 round-trips for 1, saving ~10-15s of wall time
    per question with no cost change. Falls back to RRF rank order if parsing fails.
    """
    if not candidates:
        return []
    prompt = BATCH_RERANK_PROMPT.format(
        question=question,
        chunks_block=_format_chunks_for_rerank(candidates),
    )
    try:
        resp = client.chat.completions.create(
            model=RERANK_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_completion_tokens=2000,
            response_format={"type": "json_object"},
            timeout=20,
        )
        raw = resp.choices[0].message.content or "{}"
        data = json.loads(raw)
    except Exception:
        # Fallback: keep RRF order, give every candidate a neutral 5 so we still proceed.
        return [(c, 5.0) for c in candidates]

    score_by_id: dict[int, float] = {}
    for entry in data.get("scores", []) or []:
        try:
            cid = int(entry.get("id"))
            sc = float(entry.get("score"))
            score_by_id[cid] = max(0.0, min(10.0, sc))
        except (TypeError, ValueError):
            continue

    scored = [(c, score_by_id.get(i, 0.0)) for i, c in enumerate(candidates)]
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type((RateLimitError, APIError, APITimeoutError)),
)
def _call_answer_model(client: OpenAI, system_prompt: str, user_prompt: str) -> str:
    resp = client.chat.completions.create(
        model=ANSWER_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        max_completion_tokens=3000,
        timeout=25,
    )
    return resp.choices[0].message.content or ""


def _format_sources_block(chunks: list[Chunk]) -> str:
    """Render the retrieved chunks as a labelled XML-ish block."""
    parts = []
    for c in chunks:
        parts.append(
            f"<source path=\"{c.file_path}\" verticale=\"{c.verticale}\" title=\"{c.title}\" "
            f"section=\"{c.breadcrumb}\">\n{c.text.strip()}\n</source>"
        )
    return "\n\n".join(parts)


def _extract_cited_paths(answer: str, allowed: set[str]) -> list[str]:
    """Pull `[source: path.md]` mentions out of the answer, filtered to known paths."""
    cited = re.findall(r"\[source:\s*([^\]]+?)\s*\]", answer)
    seen: list[str] = []
    for raw in cited:
        path = raw.strip()
        if path in allowed and path not in seen:
            seen.append(path)
    return seen


def majority_verticale(chunks: list[Chunk]) -> Verticale:
    counts = Counter(c.verticale for c in chunks)
    return counts.most_common(1)[0][0]


def abstain_message(question: str) -> str:
    """A short honest abstention. Language detection is delegated to the LLM
    elsewhere, but for the no-LLM-call path we keep both."""
    # Cheap heuristic: any common Italian function word -> Italian.
    italian_markers = {
        " e ", " il ", " la ", " un ", " una ", " del ", " della ", "qual ", "come ",
        "quanto ", "quando ", "dove ", "perché", "perche", "che cos", "ció ", "cio ",
    }
    q = " " + question.lower() + " "
    if any(m in q for m in italian_markers):
        return "Non ho questa informazione nel mio database."
    return "I don't have this information in my knowledge base."


# ---------------------------------------------------------------------------
# Orchestration: the function /ask calls
# ---------------------------------------------------------------------------

def answer_question(state: dict, question: str) -> dict:
    """Full pipeline. Returns a dict matching AskResponse."""
    client = get_client()

    # 1. embed + retrieve
    qvec = embed_query(client, question)
    search_vec = qvec
    if USE_HYDE:
        hypo = hyde_query(question)
        if hypo:
            hvec = embed_query(client, hypo)
            avg = (qvec + hvec) / 2.0
            norm = np.linalg.norm(avg)
            if norm > 0:
                search_vec = avg / norm
                print(f'[hyde] q="{question[:60]}" -> hypo="{hypo[:80]}"')
            else:
                print("[hyde] WARNING: blended query vector had zero norm")

    dense = dense_search(state, search_vec, DENSE_TOP_K)
    bm25 = bm25_search(state, question, BM25_TOP_K)
    merged = rrf_merge(dense, bm25)[: max(DENSE_TOP_K, BM25_TOP_K)]
    candidate_ids = [cid for cid, _ in merged]

    if not candidate_ids:
        return {
            "answer": abstain_message(question),
            "sources": [],
            "verticale": "life_on_campus",  # default; nothing was retrieved
        }

    # 2. MMR diversity → 20 → LLM rerank → 8
    diverse_ids = mmr_diversify(candidate_ids, qvec, state, MMR_KEEP)
    diverse_chunks = [state["chunks"][i] for i in diverse_ids]
    reranked = llm_rerank(client, question, diverse_chunks)

    if not reranked:
        return {
            "answer": abstain_message(question),
            "sources": [],
            "verticale": majority_verticale([state["chunks"][i] for i in candidate_ids[:8]]),
        }

    top_score = reranked[0][1]
    top_chunks = [c for c, _ in reranked[:RERANK_KEEP]]
    chosen_verticale = majority_verticale(top_chunks)

    # 3. confidence gate — abstain without burning a generation call
    if top_score < CONFIDENCE_THRESHOLD:
        return {
            "answer": abstain_message(question),
            "sources": [],
            "verticale": chosen_verticale,
        }

    # 4. generate
    system_prompt = build_system_prompt(chosen_verticale)
    user_prompt = (
        f"<sources>\n{_format_sources_block(top_chunks)}\n</sources>\n\n"
        f"Question: {question}\n\n"
        "Answer using ONLY the sources above. Cite each fact inline as [source: <file_path>]. "
        "If the sources do not contain the answer, abstain in the question's language."
    )

    try:
        answer = _call_answer_model(client, system_prompt, user_prompt)
    except Exception:
        return {
            "answer": abstain_message(question),
            "sources": [],
            "verticale": chosen_verticale,
        }

    allowed_paths = {c.file_path for c in top_chunks}
    cited = _extract_cited_paths(answer, allowed_paths)
    # If the model answered without citing anything, fall back to the top chunks'
    # paths. The schema requires sources; missing them costs us trust.
    if not cited:
        cited = list(dict.fromkeys(c.file_path for c in top_chunks))[:5]

    return {"answer": answer, "sources": cited, "verticale": chosen_verticale}
