from contextlib import asynccontextmanager
import json
import logging
import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, text

from .config import load_overrides, settings
from .database import init_db, engine
from .routers import (
    audiences_router, analysis_router,
    experiments_router, runs_router, settings_router,
)
from .services.execution import recover_interrupted_runs

logger = logging.getLogger(__name__)

# Columns added after a table first shipped: (table, column, DDL type/default).
_ADDED_COLUMNS = [
    ("audiences", "backstory_prompt_template", "TEXT"),
    ("experiments", "drift_detection_enabled", "BOOLEAN NOT NULL DEFAULT 1"),
    ("simulation_runs", "analysis_cache", "JSON"),
    ("sampling_jobs", "backstory_mode", "TEXT NOT NULL DEFAULT 'llm'"),
    ("personas", "archived", "BOOLEAN NOT NULL DEFAULT 0"),
]

# Columns and tables of removed features (plausibility checks, synonym
# injection, calibration — none had a UI).
_DROPPED_COLUMNS = [
    ("personas", "plausibility"),
    ("personas", "flagged"),
    ("sampling_jobs", "generate_backstories"),
    ("sampling_jobs", "validate_plausibility"),
    ("sampling_jobs", "llm_validation"),
    ("experiments", "synonym_injection_enabled"),
]
_DROPPED_TABLES = ["calibration_benchmarks", "calibration_status"]

_INDEXES = [
    ("ix_simulation_tasks_run_id", "simulation_tasks", "run_id"),
    ("ix_simulation_tasks_persona_id", "simulation_tasks", "persona_id"),
    ("ix_personas_audience_id", "personas", "audience_id"),
]


def _convert_placeholder_variables(conn) -> None:
    """
    Fold the old {{placeholder}} experiment variables (weighted value lists) into
    categorical experiment variables referenced as {name}, then drop their table.
    """
    rows = conn.execute(text("SELECT experiment_id, placeholder, attributes FROM experiment_variables")).all()
    for experiment_id, placeholder, attributes in rows:
        attrs = json.loads(attributes) if isinstance(attributes, str) else (attributes or [])
        exists = conn.execute(
            text("SELECT 1 FROM experiment_dist_variables WHERE experiment_id = :e AND name = :n"),
            {"e": experiment_id, "n": placeholder},
        ).first()
        if not exists:
            dist = {"type": "categorical",
                    "options": [{"label": str(a["value"]), "weight": float(a.get("weight", 1.0))} for a in attrs]}
            conn.execute(
                text("INSERT INTO experiment_dist_variables (id, experiment_id, name, var_type, distribution, sort_order) "
                     "VALUES (:id, :e, :n, 'categorical', :d, 0)"),
                {"id": str(uuid.uuid4()), "e": experiment_id, "n": placeholder, "d": json.dumps(dist)},
            )
        params = {"e": experiment_id, "old": "{{" + placeholder + "}}", "new": "{" + placeholder + "}"}
        conn.execute(text("UPDATE experiments SET global_context = REPLACE(global_context, :old, :new) WHERE id = :e"), params)
        conn.execute(text("UPDATE questions SET question_text = REPLACE(question_text, :old, :new) WHERE experiment_id = :e"), params)
    conn.execute(text("DROP TABLE experiment_variables"))
    if rows:
        logger.info(f"Migrated {len(rows)} {{{{placeholder}}}} variable(s) to experiment variables")


def _migrate(conn) -> None:
    """Lightweight schema evolution for existing SQLite databases (no Alembic)."""
    insp = inspect(conn)
    tables = set(insp.get_table_names())

    def columns(table: str) -> set[str]:
        return {c["name"] for c in insp.get_columns(table)} if table in tables else set()

    for table, column, ddl in _ADDED_COLUMNS:
        if table in tables and column not in columns(table):
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
            logger.info(f"Migration: added {table}.{column}")

    if "experiment_variables" in tables:
        _convert_placeholder_variables(conn)

    for table in _DROPPED_TABLES:
        if table in tables:
            conn.execute(text(f"DROP TABLE {table}"))
            logger.info(f"Migration: dropped table {table}")

    for table, column in _DROPPED_COLUMNS:
        if column in columns(table):
            conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
            logger.info(f"Migration: dropped {table}.{column}")

    for name, table, column in _INDEXES:
        conn.execute(text(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({column})"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_overrides()          # apply settings_override.json if present
    await init_db()           # create_all for new tables
    async with engine.begin() as conn:
        await conn.run_sync(_migrate)
    await recover_interrupted_runs()
    yield


app = FastAPI(
    title="GenAI Customer Simulator",
    description=(
        "Platform for running synthetic customer interviews via LLMs. "
        "Four modules: Audience Builder → Script Editor → Pre-Flight → Execution & Results."
    ),
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(audiences_router)
app.include_router(experiments_router)
app.include_router(runs_router)
app.include_router(settings_router)
app.include_router(analysis_router)


@app.get("/health")
async def health():
    return {"status": "ok", "version": app.version}
