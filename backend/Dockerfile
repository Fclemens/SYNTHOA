# syntax=docker/dockerfile:1
FROM python:3.13-slim AS base

# System deps: build tools only where needed (scipy/numpy wheels usually ship binary)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for better layer caching
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy app code and default prompt templates
COPY app ./app
COPY prompts ./prompts-default
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Runtime data directory (mounted as volume in compose)
RUN mkdir -p /app/data

# Run as non-root
RUN useradd --uid 1000 --create-home --shell /bin/sh appuser \
    && chown -R appuser:appuser /app
USER appuser

# Default DB lives in the data volume; compose overrides this env var.
ENV DATABASE_URL="sqlite+aiosqlite:////app/data/genai_simulator.db"
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/health || exit 1

ENTRYPOINT ["entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
