"""Prebuild the RAG indexes — runs once locally, ships the output in the image.

Usage (from `backend/`):
    uv run python scripts/build_index.py

Cost: ~$0.40 for the full corpus with text-embedding-3-large.
Time: 5-10 minutes wall-clock.

Output goes to `backend/data/index/`:
    faiss.index    dense vector index (FAISS, flat inner-product)
    chunks.jsonl   one JSON per chunk: text + metadata, used to load Chunk objects
    bm25.pkl       BM25Okapi instance, pickled

NEVER run this at request time or at app startup. See AGENTS.md.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

# Make `import rag` work when running from backend/scripts/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

# Load .env from project root (one level up from backend/)
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")
# And from backend/.env if someone put it there
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import rag  # noqa: E402


def main() -> None:
    t0 = time.time()
    print("Loading + chunking markdown files...")
    chunks = rag.load_all_chunks()
    print(f"  {len(chunks)} chunks across {len(set(c.file_path for c in chunks))} files")
    by_v = {}
    for c in chunks:
        by_v[c.verticale] = by_v.get(c.verticale, 0) + 1
    print(f"  by verticale: {by_v}")

    print("Building indexes (this calls OpenAI for embeddings)...")
    client = rag.get_client()
    rag.build_and_save(chunks, client)

    print(f"Done in {time.time() - t0:.1f}s.")


if __name__ == "__main__":
    main()
