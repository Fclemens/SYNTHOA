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
    analyze_text_field,
    build_pdf_report,
    compute_summary,
    generate_deep_dive,
    get_prompt,
    save_prompt,
    summarize_field_llm,
)
from ..services.llm_client import get_price

router = APIRouter(prefix="/api", tags=["analysis"])

_ALLOWED_PROMPTS = {"summarize_open_ended", "summarize_field_stats", "deep_dive", "text_analytics"}


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


# ── Text analytics (themes + sentiment) ──────────────────────────────────────

class TextAnalyticsRequest(BaseModel):
    field_key: str
    confidence_threshold: float = 0.0


@router.post("/runs/{run_id}/analysis/text-analytics")
async def text_analytics(
    run_id: str,
    body: TextAnalyticsRequest,
    db: AsyncSession = Depends(get_db),
):
    """Extract themes, overall sentiment, and per-response sentiment for one text field."""
    run, tasks = await _get_run_and_tasks(run_id, db)
    summary = compute_summary(run, tasks, body.confidence_threshold)

    field = summary["fields"].get(body.field_key)
    if not field:
        raise HTTPException(status_code=404, detail=f"Field '{body.field_key}' not found")
    if field.get("n", 0) == 0:
        raise HTTPException(status_code=400, detail="No data available for this field")
    if field.get("type", "").lower() not in ("open_ended", "text", "string"):
        raise HTTPException(status_code=400, detail="Text analytics only applies to open_ended / text / string fields")

    model = settings.effective_insights_model
    provider = settings.effective_insights_provider
    parsed, tin, tout = await analyze_text_field(
        field_key=body.field_key,
        field_data=field,
        model=model,
        provider=provider,
    )
    cost = get_price(model, tin, tout)

    return {
        "key": body.field_key,
        "themes": parsed.get("themes", []),
        "sentiment": parsed.get("sentiment", {}),
        "per_response_sentiment": parsed.get("per_response_sentiment", []),
        "model": model,
        "tokens_in": tin,
        "tokens_out": tout,
        "cost_usd": cost,
    }


# ── Deep dive ─────────────────────────────────────────────────────────────────

class DeepDiveRequest(BaseModel):
    confidence_threshold: float = 0.0
    analysis_type: str = "executive_summary"   # executive_summary | segment_analysis | opportunity_map | objection_analysis | custom
    context_mode: str = "standard"             # quick | standard | full
    sample_size: int = 10                      # for standard mode: how many transcripts to include
    custom_prompt: str = ""                    # for custom analysis_type


@router.post("/runs/{run_id}/analysis/deep-dive")
async def deep_dive(
    run_id: str,
    body: DeepDiveRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate a full AI analysis report for a run."""
    from ..models.audience import Persona
    run, tasks = await _get_run_and_tasks(run_id, db)

    summary = compute_summary(run, tasks, body.confidence_threshold)
    experiment_name = await _get_experiment_name(run.experiment_id, db)

    # Build respondent data for standard/full context modes
    respondents: list[dict] = []
    if body.context_mode in ("standard", "full"):
        persona_ids = list({t.persona_id for t in tasks if t.pass1_status == "completed"})
        from sqlalchemy import select as sa_select
        personas_result = await db.execute(
            sa_select(Persona).where(Persona.id.in_(persona_ids))
        )
        personas = {p.id: p for p in personas_result.scalars().all()}
        completed = [t for t in tasks if t.pass1_status == "completed" and t.raw_transcript]
        if body.context_mode == "standard":
            import random
            sample = random.sample(completed, min(body.sample_size, len(completed)))
        else:
            sample = completed
        for t in sample:
            p = personas.get(t.persona_id)
            respondents.append({
                "traits": p.traits_json if p else {},
                "injected_vars": t.injected_vars or {},
                "transcript": t.raw_transcript or "",
                "extracted_json": t.extracted_json or {},
            })

    ins_model = settings.effective_insights_model
    ins_provider = settings.effective_insights_provider
    text, tin, tout = await generate_deep_dive(
        run=run,
        summary=summary,
        experiment_name=experiment_name,
        model=ins_model,
        provider=ins_provider,
        analysis_type=body.analysis_type,
        context_mode=body.context_mode,
        respondents=respondents,
        custom_prompt=body.custom_prompt,
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
        "analysis_type": body.analysis_type,
        "context_mode": body.context_mode,
    }

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
