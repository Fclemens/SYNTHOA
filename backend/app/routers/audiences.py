from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any, List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models.audience import (
    Audience, AudienceVariable, ConditionalRule, Persona, SamplingJob, VariableCorrelation,
)
from ..schemas.audience import (
    AudienceCreate, AudienceOut, AudienceUpdate,
    AudienceVariableCreate, AudienceVariableOut, AudienceVariableUpdate,
    ConditionalRuleCreate, ConditionalRuleOut,
    CorrelationUpsert,
    PersonaOut, SampleRequest, SamplingJobOut,
    AudienceExportBundle, AudienceImportResult,
)
from ..services.backstory import generate_backstory
from ..services.sampling import sample_correlated_population
from ..services.sampling_jobs import run_sampling_job
from ..services.validation import validate_persona, validate_persona_llm

router = APIRouter(prefix="/api/audiences", tags=["audiences"])


async def _get_audience_full(audience_id: str, db: AsyncSession) -> Audience:
    """Load audience with all relationships eagerly to avoid lazy-load errors."""
    result = await db.execute(
        select(Audience)
        .where(Audience.id == audience_id)
        .options(selectinload(Audience.variables))
    )
    audience = result.scalars().first()
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")
    return audience


# ── Import (must be before /{audience_id} dynamic routes) ─────────────────────

@router.post("/import", response_model=AudienceImportResult, status_code=201)
async def import_audience(body: AudienceExportBundle, db: AsyncSession = Depends(get_db)):
    """
    Import an audience bundle. Creates a new audience (never overwrites).
    Correlations are matched by variable name after variables are created.
    """
    # Create audience
    new_audience = Audience(
        id=str(uuid.uuid4()),
        name=body.audience.name,
        description=body.audience.description,
        backstory_prompt_template=body.audience.backstory_prompt_template,
    )
    db.add(new_audience)
    await db.flush()

    # Create variables — track name→new_id for correlation remapping
    name_to_id: dict[str, str] = {}
    for v in body.variables:
        new_var = AudienceVariable(
            id=str(uuid.uuid4()),
            audience_id=new_audience.id,
            name=v.name,
            var_type=v.var_type,
            distribution=v.distribution,
            sort_order=v.sort_order,
        )
        db.add(new_var)
        name_to_id[v.name] = new_var.id

    await db.flush()

    # Restore correlations using name→new_id mapping
    for c in body.correlations:
        a_id = name_to_id.get(c.var_a_name)
        b_id = name_to_id.get(c.var_b_name)
        if a_id and b_id:
            canon_a, canon_b = sorted([a_id, b_id])
            db.add(VariableCorrelation(
                audience_id=new_audience.id,
                var_a_id=canon_a,
                var_b_id=canon_b,
                correlation=c.correlation,
            ))

    # Restore personas
    persona_count = 0
    for p in body.personas:
        db.add(Persona(
            id=str(uuid.uuid4()),
            audience_id=new_audience.id,
            traits_json=p.traits_json,
            backstory=p.backstory,
            plausibility=p.plausibility,
            flagged=p.flagged,
        ))
        persona_count += 1

    await db.commit()

    return AudienceImportResult(
        audience_id=new_audience.id,
        name=new_audience.name,
        variables_imported=len(name_to_id),
        correlations_imported=len(body.correlations),
        personas_imported=persona_count,
    )


# ── Audience CRUD ─────────────────────────────────────────────────────────────

@router.post("", response_model=AudienceOut, status_code=status.HTTP_201_CREATED)
async def create_audience(body: AudienceCreate, db: AsyncSession = Depends(get_db)):
    audience = Audience(id=str(uuid.uuid4()), **body.model_dump())
    db.add(audience)
    await db.commit()
    return await _get_audience_full(audience.id, db)


@router.get("", response_model=List[AudienceOut])
async def list_audiences(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Audience)
        .order_by(Audience.created_at.desc())
        .options(selectinload(Audience.variables))
    )
    return result.scalars().all()


@router.get("/{audience_id}", response_model=AudienceOut)
async def get_audience(audience_id: str, db: AsyncSession = Depends(get_db)):
    return await _get_audience_full(audience_id, db)


@router.put("/{audience_id}", response_model=AudienceOut)
async def update_audience(audience_id: str, body: AudienceUpdate, db: AsyncSession = Depends(get_db)):
    audience = await db.get(Audience, audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(audience, field, value)
    await db.commit()
    return await _get_audience_full(audience_id, db)


@router.delete("/{audience_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_audience(audience_id: str, db: AsyncSession = Depends(get_db)):
    audience = await db.get(Audience, audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")
    await db.delete(audience)
    await db.commit()


# ── Variables ─────────────────────────────────────────────────────────────────

@router.post("/{audience_id}/variables", response_model=AudienceVariableOut, status_code=201)
async def add_variable(audience_id: str, body: AudienceVariableCreate, db: AsyncSession = Depends(get_db)):
    audience = await db.get(Audience, audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")
    var = AudienceVariable(id=str(uuid.uuid4()), audience_id=audience_id, **body.model_dump())
    db.add(var)
    await db.commit()
    await db.refresh(var)
    return var


@router.put("/{audience_id}/variables/{var_id}", response_model=AudienceVariableOut)
async def update_variable(
    audience_id: str, var_id: str, body: AudienceVariableUpdate, db: AsyncSession = Depends(get_db)
):
    var = await db.get(AudienceVariable, var_id)
    if not var or var.audience_id != audience_id:
        raise HTTPException(status_code=404, detail="Variable not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(var, field, value)
    await db.commit()
    await db.refresh(var)
    return var


@router.delete("/{audience_id}/variables/{var_id}", status_code=204)
async def delete_variable(audience_id: str, var_id: str, db: AsyncSession = Depends(get_db)):
    var = await db.get(AudienceVariable, var_id)
    if not var or var.audience_id != audience_id:
        raise HTTPException(status_code=404, detail="Variable not found")
    await db.delete(var)
    await db.commit()


# ── Correlations ──────────────────────────────────────────────────────────────

@router.get("/{audience_id}/correlations")
async def get_correlations(audience_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(VariableCorrelation).where(VariableCorrelation.audience_id == audience_id)
    )
    return [
        {"var_a_id": c.var_a_id, "var_b_id": c.var_b_id, "correlation": c.correlation}
        for c in result.scalars().all()
    ]


@router.put("/{audience_id}/correlations", status_code=200)
async def upsert_correlations(audience_id: str, body: CorrelationUpsert, db: AsyncSession = Depends(get_db)):
    audience = await db.get(Audience, audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")

    # Delete existing
    existing = await db.execute(
        select(VariableCorrelation).where(VariableCorrelation.audience_id == audience_id)
    )
    for corr in existing.scalars().all():
        await db.delete(corr)

    # Insert new (ensure upper triangle: var_a_id < var_b_id lexicographically)
    for entry in body.correlations:
        a, b = sorted([entry.var_a_id, entry.var_b_id])
        corr = VariableCorrelation(
            audience_id=audience_id,
            var_a_id=a,
            var_b_id=b,
            correlation=entry.correlation,
        )
        db.add(corr)

    await db.commit()
    return {"status": "ok", "count": len(body.correlations)}


# ── Conditional Rules ─────────────────────────────────────────────────────────

@router.post("/{audience_id}/conditional-rules", response_model=ConditionalRuleOut, status_code=201)
async def add_conditional_rule(
    audience_id: str, body: ConditionalRuleCreate, db: AsyncSession = Depends(get_db)
):
    audience = await db.get(Audience, audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")
    rule = ConditionalRule(id=str(uuid.uuid4()), audience_id=audience_id, **body.model_dump())
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return rule


@router.put("/{audience_id}/conditional-rules/{rule_id}", response_model=ConditionalRuleOut)
async def update_conditional_rule(
    audience_id: str, rule_id: str, body: ConditionalRuleCreate, db: AsyncSession = Depends(get_db)
):
    rule = await db.get(ConditionalRule, rule_id)
    if not rule or rule.audience_id != audience_id:
        raise HTTPException(status_code=404, detail="Rule not found")
    for field, value in body.model_dump().items():
        setattr(rule, field, value)
    await db.commit()
    await db.refresh(rule)
    return rule


@router.delete("/{audience_id}/conditional-rules/{rule_id}", status_code=204)
async def delete_conditional_rule(audience_id: str, rule_id: str, db: AsyncSession = Depends(get_db)):
    rule = await db.get(ConditionalRule, rule_id)
    if not rule or rule.audience_id != audience_id:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.delete(rule)
    await db.commit()


# ── Persona Sampling ──────────────────────────────────────────────────────────

@router.post("/{audience_id}/sample", response_model=SamplingJobOut, status_code=202)
async def sample_personas(
    audience_id: str,
    body: SampleRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Start a background sampling job. Returns immediately with the job record."""
    audience = await db.get(Audience, audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")

    # Determine how many to sample
    if body.reuse_existing:
        existing_result = await db.execute(
            select(Persona).where(Persona.audience_id == audience_id)
        )
        existing_count = len(existing_result.scalars().all())
        n_needed = max(0, body.n - existing_count)
    else:
        n_needed = body.n

    if n_needed == 0:
        # Nothing to do — return a synthetic completed job
        job = SamplingJob(
            id=str(uuid.uuid4()),
            audience_id=audience_id,
            status="completed",
            n_requested=0,
            n_completed=0,
            backstory_mode=body.backstory_mode,
            validate_plausibility=body.validate_plausibility,
            llm_validation=body.llm_validation,
        )
        db.add(job)
        await db.commit()
        await db.refresh(job)
        return job

    job = SamplingJob(
        id=str(uuid.uuid4()),
        audience_id=audience_id,
        status="running",
        n_requested=n_needed,
        n_completed=0,
        backstory_mode=body.backstory_mode,
        validate_plausibility=body.validate_plausibility,
        llm_validation=body.llm_validation,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    background_tasks.add_task(run_sampling_job, job.id)
    return job


@router.post("/{audience_id}/sample/fresh", response_model=SamplingJobOut, status_code=202)
async def sample_personas_fresh(
    audience_id: str,
    body: SampleRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Delete all existing personas for this audience, then start a new sampling job."""
    audience = await db.get(Audience, audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")

    # Delete all existing personas
    await db.execute(delete(Persona).where(Persona.audience_id == audience_id))
    await db.commit()

    job = SamplingJob(
        id=str(uuid.uuid4()),
        audience_id=audience_id,
        status="running",
        n_requested=body.n,
        n_completed=0,
        backstory_mode=body.backstory_mode,
        validate_plausibility=body.validate_plausibility,
        llm_validation=body.llm_validation,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    background_tasks.add_task(run_sampling_job, job.id)
    return job


# ── Sampling Jobs ─────────────────────────────────────────────────────────────

@router.get("/{audience_id}/sampling-jobs", response_model=List[SamplingJobOut])
async def list_sampling_jobs(audience_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SamplingJob)
        .where(SamplingJob.audience_id == audience_id)
        .order_by(SamplingJob.created_at.desc())
    )
    return result.scalars().all()


@router.get("/{audience_id}/sampling-jobs/{job_id}", response_model=SamplingJobOut)
async def get_sampling_job(audience_id: str, job_id: str, db: AsyncSession = Depends(get_db)):
    job = await db.get(SamplingJob, job_id)
    if not job or job.audience_id != audience_id:
        raise HTTPException(status_code=404, detail="Sampling job not found")
    return job


@router.post("/{audience_id}/sampling-jobs/{job_id}/stop", response_model=SamplingJobOut)
async def stop_sampling_job(audience_id: str, job_id: str, db: AsyncSession = Depends(get_db)):
    job = await db.get(SamplingJob, job_id)
    if not job or job.audience_id != audience_id:
        raise HTTPException(status_code=404, detail="Sampling job not found")
    if job.status == "running":
        job.status = "stopped"
        await db.commit()
        await db.refresh(job)
    return job


@router.post("/{audience_id}/sampling-jobs/{job_id}/resume", response_model=SamplingJobOut, status_code=202)
async def resume_sampling_job(
    audience_id: str,
    job_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    job = await db.get(SamplingJob, job_id)
    if not job or job.audience_id != audience_id:
        raise HTTPException(status_code=404, detail="Sampling job not found")
    if job.status != "stopped":
        raise HTTPException(status_code=400, detail=f"Job is not stopped (status: {job.status})")
    job.status = "running"
    await db.commit()
    await db.refresh(job)
    background_tasks.add_task(run_sampling_job, job.id)
    return job


@router.get("/{audience_id}/personas", response_model=List[PersonaOut])
async def list_personas(audience_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Persona).where(Persona.audience_id == audience_id).order_by(Persona.created_at.desc())
    )
    return result.scalars().all()


@router.delete("/{audience_id}/personas/{persona_id}", status_code=204)
async def delete_persona(audience_id: str, persona_id: str, db: AsyncSession = Depends(get_db)):
    persona = await db.get(Persona, persona_id)
    if not persona or persona.audience_id != audience_id:
        raise HTTPException(status_code=404, detail="Persona not found")
    await db.delete(persona)
    await db.commit()


# ── Export ─────────────────────────────────────────────────────────────────────

@router.get("/{audience_id}/export")
async def export_audience(
    audience_id: str,
    include_personas: bool = True,
    db: AsyncSession = Depends(get_db),
):
    """
    Export an audience (variables, correlations, optional personas) as a JSON bundle.
    Correlations are stored by variable NAME so they survive import into a new audience.
    """
    audience = await db.get(Audience, audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")

    # Variables
    vars_result = await db.execute(
        select(AudienceVariable)
        .where(AudienceVariable.audience_id == audience_id)
        .order_by(AudienceVariable.sort_order)
    )
    variables = vars_result.scalars().all()
    var_id_to_name = {v.id: v.name for v in variables}

    # Correlations (stored with var names for portability)
    corr_result = await db.execute(
        select(VariableCorrelation).where(VariableCorrelation.audience_id == audience_id)
    )
    correlations = [
        {
            "var_a_name": var_id_to_name.get(c.var_a_id, c.var_a_id),
            "var_b_name": var_id_to_name.get(c.var_b_id, c.var_b_id),
            "correlation": c.correlation,
        }
        for c in corr_result.scalars().all()
    ]

    # Personas (optional)
    personas: list[dict[str, Any]] = []
    if include_personas:
        p_result = await db.execute(
            select(Persona)
            .where(Persona.audience_id == audience_id)
            .order_by(Persona.created_at)
        )
        personas = [
            {
                "traits_json": p.traits_json,
                "backstory": p.backstory,
                "plausibility": p.plausibility,
                "flagged": p.flagged,
            }
            for p in p_result.scalars().all()
        ]

    bundle: dict[str, Any] = {
        "version": "1",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "audience": {
            "name": audience.name,
            "description": audience.description,
            "backstory_prompt_template": audience.backstory_prompt_template,
        },
        "variables": [
            {
                "name": v.name,
                "var_type": v.var_type,
                "distribution": v.distribution,
                "sort_order": v.sort_order,
            }
            for v in variables
        ],
        "correlations": correlations,
        "personas": personas,
    }

    safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in audience.name).strip()
    filename = f"audience_{safe_name}.json"

    return JSONResponse(
        content=bundle,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


