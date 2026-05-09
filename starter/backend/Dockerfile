# Production Dockerfile for the FastAPI backend.
# Build context: this `backend/` folder. Run from `starter/backend/`:
#   docker build -t bocconi-backend .
#   railway up

FROM python:3.13-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

# Install dependencies first (cached layer if pyproject doesn't change)
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-install-project || uv sync --no-install-project || uv sync

# Copy backend source + bundled data/
COPY . .

# Fetch the 129MB FAISS index from a GitHub Release asset.
# Too large for Railway's `railway up` upload (silently dropped >~100MB).
ARG FAISS_INDEX_URL=https://github.com/L0uisHu/Compass-ATM-/releases/download/rag-index-v1/faiss.index
RUN python -c "import urllib.request, os; os.makedirs('/app/data/index', exist_ok=True); urllib.request.urlretrieve('${FAISS_INDEX_URL}', '/app/data/index/faiss.index')" \
    && ls -la /app/data/index/faiss.index

EXPOSE 8000

CMD ["sh", "-c", "uv run uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
