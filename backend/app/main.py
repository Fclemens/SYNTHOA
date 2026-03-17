from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import load_overrides
from .database import init_db, engine
from .routers import (
    audiences_router, calibration_router,
    experiments_router, runs_router, settings_router,
)

logger = logging.getLogger(__name__)


async def _migrate_db() -> None:
    """Add new columns to existing tables without full Alembic migrations."""
    migrations = [
        "ALTER TABLE audiences ADD COLUMN backstory_prompt_template TEXT",
        "ALTER TABLE experiments ADD COLUMN drift_detection_enabled BOOLEAN NOT NULL DEFAULT 1",
    ]
    async with engine.begin() as conn:
        for stmt in migrations:
            try:
                await conn.execute(text(stmt))
                logger.info(f"Migration applied: {stmt}")
            except Exception:
                # Column already exists — safe to ignore
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_overrides()          # apply settings_override.json if present
    await init_db()           # create_all for new tables
    await _migrate_db()       # add new columns to existing tables
    yield


app = FastAPI(
    title="GenAI Customer Simulator",
    description=(
        "Platform for running synthetic customer interviews via LLMs. "
        "Four modules: Audience Builder → Script Editor → Pre-Flight → Execution & Results."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000", "http://127.0.0.1:3000",
        "http://localhost:3001", "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(audiences_router)
app.include_router(experiments_router)
app.include_router(runs_router)
app.include_router(calibration_router)
app.include_router(settings_router)


@app.get("/health")
async def health():
    return {"status": "ok", "version": app.version}
