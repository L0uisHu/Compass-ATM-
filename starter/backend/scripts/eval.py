"""Calibration harness — run the 10 sample questions through /ask.

Usage (after `docker compose up -d` and after build_index.py has run):
    uv run python scripts/eval.py
    uv run python scripts/eval.py --backend https://<your-railway-url>

Writes results to backend/eval_results.json. Open it, read the answers,
mark each one correct / partial / abstain / wrong by hand, then iterate.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

SAMPLE_QUESTIONS_FILE = Path(__file__).resolve().parent.parent.parent / "SAMPLE_QUESTIONS.md"
USE_HYDE = os.getenv("USE_HYDE", "0").strip().lower() in ("1", "true")
RESULTS_FILE = Path(__file__).resolve().parent.parent / (
    "eval_results_hyde.json" if USE_HYDE else "eval_results_no_hyde.json"
)


def parse_questions(path: Path) -> list[str]:
    """Pull the 10 numbered questions out of SAMPLE_QUESTIONS.md."""
    text = path.read_text(encoding="utf-8")
    # Find lines like `1. **What is ...**` after the "## The 10 sample questions" heading.
    after_header = text.split("## The 10 sample questions", 1)
    if len(after_header) < 2:
        raise RuntimeError(f"Could not find sample questions section in {path}")
    body = after_header[1]
    # Match: optional whitespace, digit(s), dot, space, **question**
    matches = re.findall(r"^\s*\d+\.\s+\*\*(.+?)\*\*", body, flags=re.MULTILINE | re.DOTALL)
    return [m.strip() for m in matches]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="http://localhost:8000", help="Backend base URL")
    args = ap.parse_args()

    questions = parse_questions(SAMPLE_QUESTIONS_FILE)
    print(f"Loaded {len(questions)} sample questions")
    print(f"Hitting {args.backend}/ask\n")

    # Sanity check
    try:
        h = requests.get(f"{args.backend}/health", timeout=5)
        h.raise_for_status()
    except Exception as e:
        print(f"FAIL: /health unreachable at {args.backend}: {e}")
        sys.exit(1)

    results: list[dict] = []
    for i, q in enumerate(questions, 1):
        print(f"[{i}/{len(questions)}] {q[:90]}{'...' if len(q) > 90 else ''}")
        t0 = time.time()
        try:
            r = requests.post(
                f"{args.backend}/ask",
                json={"question": q},
                timeout=35,  # one over the 30s budget so we see if we missed
            )
            elapsed = time.time() - t0
            data = r.json() if r.ok else {"error": r.text}
            ok = r.ok
        except requests.Timeout:
            elapsed = time.time() - t0
            data = {"error": "timeout"}
            ok = False
        except Exception as e:
            elapsed = time.time() - t0
            data = {"error": f"{type(e).__name__}: {e}"}
            ok = False

        results.append({
            "n": i,
            "question": q,
            "elapsed_s": round(elapsed, 2),
            "ok": ok,
            **data,
        })
        if ok:
            ans_preview = data.get("answer", "")[:120].replace("\n", " ")
            print(f"  -> {elapsed:.1f}s | {data.get('verticale')} | {ans_preview}...\n")
        else:
            print(f"  -> {elapsed:.1f}s | ERROR | {data}\n")

    RESULTS_FILE.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nResults written to {RESULTS_FILE}")
    print("Read each answer and judge: correct / partial / no_answer / wrong.")


if __name__ == "__main__":
    main()
