"""
Analysis router: statistical summaries, LLM deep dives, prompt management, PDF export.
"""
from __future__ import annotations

import io
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models.experiment import Experiment
from ..models.simulation import SimulationRun, SimulationTask
from ..services.analysis import (
    build_pdf_report,
    compute_summary,
    generate_deep_dive,
    get_prompt,
    save_prompt,
    summarize_field_llm,
)
from ..services.llm_client import get_price

router = APIRouter(prefix="/api", tags=["analysis"])

_ALLOWED_PROMPTS = {"summarize_open_ended", "summarize_field_stats", "deep_dive"}


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_run_and_tasks(run_id: str, db: AsyncSession):
    run = await db.get(SimulationRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    result = await db.execute(select(SimulationTask).where(SimulationTask.run_id == run_id))
    tasks = result.scalars().all()
    return run, tasks


async def _get_experiment_name(experiment_id: str, db: AsyncSession) -> str:
    exp = await db.get(Experiment, experiment_id)
    return exp.name if exp else experiment_id


# ── Summary ───────────────────────────────────────────────────────────────────

@router.get("/runs/{run_id}/analysis/summary")
async def get_summary(
    run_id: str,
    confidence_threshold: float = Query(0.0, ge=0.0, le=1.0),
    db: AsyncSession = Depends(get_db),
):
    """Return computed statistical summary for a completed run."""
    run, tasks = await _get_run_and_tasks(run_id, db)
    return compute_summary(run, tasks, confidence_threshold)


# ── Field-level LLM summary ───────────────────────────────────────────────────

class SummarizeFieldRequest(BaseModel):
    field_key: str
    confidence_threshold: float = 0.0


@router.post("/runs/{run_id}/analysis/summarize-field")
async def summarize_field(
    run_id: str,
    body: SummarizeFieldRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate an LLM summary for one open-ended field."""
    run, tasks = await _get_run_and_tasks(run_id, db)
    summary = compute_summary(run, tasks, body.confidence_threshold)

    field = summary["fields"].get(body.field_key)
    if not field:
        raise HTTPException(status_code=404, detail=f"Field '{body.field_key}' not found in schema")
    if field.get("n", 0) == 0:
        raise HTTPException(status_code=400, detail="No data available for this field")

    model = settings.effective_insights_model
    provider = settings.effective_insights_provider
    text, tin, tout = await summarize_field_llm(
        field_key=body.field_key,
        field_data=field,
        model=model,
        provider=provider,
    )
    cost = get_price(model, tin, tout)

    return {
        "key": body.field_key,
        "llm_summary": text,
        "model": model,
        "tokens_in": tin,
        "tokens_out": tout,
        "cost_usd": cost,
    }


# ── Deep dive ─────────────────────────────────────────────────────────────────

class DeepDiveRequest(BaseModel):
    confidence_threshold: float = 0.0


@router.post("/runs/{run_id}/analysis/deep-dive")
async def deep_dive(
    run_id: str,
    body: DeepDiveRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate a full AI analysis report for a run."""
    run, tasks = await _get_run_and_tasks(run_id, db)

    # Return cached result if available and confidence threshold matches
    if run.analysis_cache:
        cached = run.analysis_cache
        if (
            cached.get("confidence_threshold") == body.confidence_threshold
            and "analysis" in cached
        ):
            return cached

    summary = compute_summary(run, tasks, body.confidence_threshold)
    experiment_name = await _get_experiment_name(run.experiment_id, db)

    ins_model = settings.effective_insights_model
    ins_provider = settings.effective_insights_provider
    text, tin, tout = await generate_deep_dive(
        run=run,
        summary=summary,
        experiment_name=experiment_name,
        model=ins_model,
        provider=ins_provider,
    )
    cost = get_price(ins_model, tin, tout)
    now = datetime.now(timezone.utc).isoformat()

    result: dict[str, Any] = {
        "analysis": text,
        "model": ins_model,
        "tokens_in": tin,
        "tokens_out": tout,
        "cost_usd": cost,
        "generated_at": now,
        "confidence_threshold": body.confidence_threshold,
    }

    # Cache it
    run.analysis_cache = result
    await db.commit()

    return result


# ── Prompt management ─────────────────────────────────────────────────────────

@router.get("/analysis/prompts/{name}")
async def read_prompt(name: str):
    if name not in _ALLOWED_PROMPTS:
        raise HTTPException(status_code=404, detail=f"Unknown prompt '{name}'")
    try:
        content = get_prompt(name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Prompt file not found")
    return {"name": name, "content": content}


class UpdatePromptRequest(BaseModel):
    content: str


@router.put("/analysis/prompts/{name}")
async def update_prompt(name: str, body: UpdatePromptRequest):
    if name not in _ALLOWED_PROMPTS:
        raise HTTPException(status_code=404, detail=f"Unknown prompt '{name}'")
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="Prompt content cannot be empty")
    save_prompt(name, body.content)
    return {"name": name, "content": body.content}


# ── PDF export ────────────────────────────────────────────────────────────────

@router.get("/runs/{run_id}/analysis/export-pdf")
async def export_pdf(
    run_id: str,
    confidence_threshold: float = Query(0.0, ge=0.0, le=1.0),
    db: AsyncSession = Depends(get_db),
):
    """Generate and stream a PDF analysis report."""
    run, tasks = await _get_run_and_tasks(run_id, db)
    experiment_name = await _get_experiment_name(run.experiment_id, db)
    summary = compute_summary(run, tasks, confidence_threshold)

    deep_dive_text: str | None = None
    if run.analysis_cache and "analysis" in run.analysis_cache:
        deep_dive_text = run.analysis_cache["analysis"]

    try:
        pdf_bytes = build_pdf_report(run, summary, experiment_name, deep_dive_text)
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="fpdf2 not installed. Run: pip install fpdf2",
        )

    safe_name = experiment_name.replace(" ", "_")[:40]
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=analysis_{safe_name}_{run_id[:8]}.pdf"},
    )
