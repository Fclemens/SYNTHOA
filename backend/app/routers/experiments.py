from __future__ import annotations
import io
import json
import re
import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_db
from ..models.audience import Audience, Persona
from ..models.experiment import Experiment, ExperimentDistVariable, OutputSchema, Question
from ..schemas.experiment import (
    ExperimentCreate, ExperimentOut, ExperimentUpdate,
    ExperimentDistVariableCreate, ExperimentDistVariableOut, ExperimentDistVariableUpdate,
    ExperimentImportRequest, ExperimentImportResult,
    OutputSchemaCreate, OutputSchemaOut,
    PreflightReport, PreflightRequest,
    PreviewInterviewRequest, PreviewInterviewResult,
    QuestionCreate, QuestionOut, QuestionReorder, QuestionUpdate,
)
from ..services.backstory import generate_backstory
from ..services.extraction import extract_with_confidence
from ..services.interview import load_experiment_config, resolve_interview, run_interview
from ..services.llm_client import get_price
from ..services.preflight import run_preflight

router = APIRouter(prefix="/api/experiments", tags=["experiments"])

EXP_LOAD = [
    selectinload(Experiment.dist_variables),
    selectinload(Experiment.questions),
    selectinload(Experiment.output_schemas),
]


async def _get_experiment_full(experiment_id: str, db: AsyncSession) -> Experiment:
    result = await db.execute(
        select(Experiment).where(Experiment.id == experiment_id).options(*EXP_LOAD)
    )
    exp = result.scalars().first()
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")
    return exp


# ── Protocol Import / Export ─────────────────────────────────────────────────
# These two routes use static path segments and MUST be defined before any
# /{experiment_id} routes so FastAPI's router matches them first.

@router.get("/export-protocol/{experiment_id}")
async def export_experiment_protocol(
    experiment_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Download a portable JSON bundle containing the full experiment protocol
    (questions, variables, output schema) — no run data included.
    Can be imported into any audience via POST /api/experiments/import-protocol.
    """
    exp = await _get_experiment_full(experiment_id, db)

    # Latest output schema only
    schema_result = await db.execute(
        select(OutputSchema)
        .where(OutputSchema.experiment_id == experiment_id)
        .order_by(OutputSchema.version.desc())
    )
    latest_schema = schema_result.scalars().first()

    bundle = {
        "version": "1.0",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "experiment": {
            "name": exp.name,
            "global_context": exp.global_context,
            "execution_mode": exp.execution_mode,
            "drift_detection_enabled": exp.drift_detection_enabled,
        },
        "dist_variables": [
            {
                "name": v.name,
                "var_type": v.var_type,
                "distribution": v.distribution,
                "sort_order": v.sort_order,
            }
            for v in exp.dist_variables
        ],
        "questions": [
            {
                "sort_order": q.sort_order,
                "question_type": q.question_type,
                "question_text": q.question_text,
                "scale_min": q.scale_min,
                "scale_max": q.scale_max,
                "scale_anchor_low": q.scale_anchor_low,
                "scale_anchor_high": q.scale_anchor_high,
                "choices": q.choices,
                "ask_why": q.ask_why,
                "prompting_mode": q.prompting_mode,
            }
            for q in sorted(exp.questions, key=lambda q: q.sort_order)
        ],
        "output_schema": latest_schema.schema_json if latest_schema else [],
    }

    safe_name = re.sub(r"[^a-z0-9_-]", "_", exp.name.lower())[:40]
    filename = f"experiment_{safe_name}.json"

    return StreamingResponse(
        io.BytesIO(json.dumps(bundle, indent=2, ensure_ascii=False).encode()),
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/import-protocol", response_model=ExperimentImportResult, status_code=201)
async def import_experiment_protocol(
    body: ExperimentImportRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Create a new experiment from a protocol bundle exported by export_experiment_protocol.
    The bundle is audience-agnostic; supply the target audience_id in the request body.
    All sub-entities (questions, variables, output schema) are recreated
    with fresh UUIDs — the original experiment is never modified.
    Bundles from older versions with {{placeholder}} variables are converted to
    categorical {placeholder} variables.
    """
    audience = await db.get(Audience, body.audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")

    b = body.bundle
    meta = b.experiment

    def legacy_tokens(text: str) -> str:
        for v in b.variables:
            text = text.replace("{{" + v.placeholder + "}}", "{" + v.placeholder + "}")
        return text

    exp = Experiment(
        id=str(uuid.uuid4()),
        audience_id=body.audience_id,
        name=meta.name,
        global_context=legacy_tokens(meta.global_context),
        execution_mode=meta.execution_mode,
        drift_detection_enabled=meta.drift_detection_enabled,
    )
    db.add(exp)

    dist_names = {v.name for v in b.dist_variables}
    for v in b.variables:
        if v.placeholder in dist_names:
            continue
        db.add(ExperimentDistVariable(
            id=str(uuid.uuid4()),
            experiment_id=exp.id,
            name=v.placeholder,
            var_type="categorical",
            distribution={"type": "categorical", "options": [
                {"label": str(a.get("value")), "weight": float(a.get("weight", 1.0))} for a in v.attributes
            ]},
        ))

    for v in b.dist_variables:
        db.add(ExperimentDistVariable(
            id=str(uuid.uuid4()),
            experiment_id=exp.id,
            name=v.name,
            var_type=v.var_type,
            distribution=v.distribution,
            sort_order=v.sort_order,
        ))

    for q in b.questions:
        db.add(Question(
            id=str(uuid.uuid4()),
            experiment_id=exp.id,
            sort_order=q.sort_order,
            question_type=q.question_type,
            question_text=legacy_tokens(q.question_text),
            scale_min=q.scale_min,
            scale_max=q.scale_max,
            scale_anchor_low=q.scale_anchor_low,
            scale_anchor_high=q.scale_anchor_high,
            choices=q.choices,
            ask_why=q.ask_why,
            prompting_mode=q.prompting_mode,
        ))

    if b.output_schema:
        db.add(OutputSchema(
            id=str(uuid.uuid4()),
            experiment_id=exp.id,
            schema_json=[f if isinstance(f, dict) else f.model_dump() for f in b.output_schema],
            version=1,
        ))

    await db.commit()

    return ExperimentImportResult(
        experiment_id=exp.id,
        name=exp.name,
        dist_variables_imported=len(b.dist_variables) + len([v for v in b.variables if v.placeholder not in dist_names]),
        questions_imported=len(b.questions),
        output_schema_imported=bool(b.output_schema),
    )


# ── Experiment CRUD ───────────────────────────────────────────────────────────

@router.post("", response_model=ExperimentOut, status_code=201)
async def create_experiment(body: ExperimentCreate, db: AsyncSession = Depends(get_db)):
    exp = Experiment(id=str(uuid.uuid4()), **body.model_dump())
    db.add(exp)
    await db.commit()
    return await _get_experiment_full(exp.id, db)


@router.get("", response_model=List[ExperimentOut])
async def list_experiments(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Experiment).order_by(Experiment.created_at.desc()).options(*EXP_LOAD)
    )
    return result.scalars().all()


@router.get("/{experiment_id}", response_model=ExperimentOut)
async def get_experiment(experiment_id: str, db: AsyncSession = Depends(get_db)):
    return await _get_experiment_full(experiment_id, db)


@router.put("/{experiment_id}", response_model=ExperimentOut)
async def update_experiment(
    experiment_id: str, body: ExperimentUpdate, db: AsyncSession = Depends(get_db)
):
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(exp, field, value)
    await db.commit()
    return await _get_experiment_full(experiment_id, db)


@router.delete("/{experiment_id}", status_code=204)
async def delete_experiment(experiment_id: str, db: AsyncSession = Depends(get_db)):
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")
    await db.delete(exp)
    await db.commit()


# ── Experiment Dist Variables ─────────────────────────────────────────────────

@router.post("/{experiment_id}/dist-variables", response_model=ExperimentDistVariableOut, status_code=201)
async def add_dist_variable(
    experiment_id: str, body: ExperimentDistVariableCreate, db: AsyncSession = Depends(get_db)
):
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")
    var = ExperimentDistVariable(
        id=str(uuid.uuid4()),
        experiment_id=experiment_id,
        name=body.name,
        var_type=body.var_type,
        distribution=body.distribution,
        sort_order=body.sort_order,
    )
    db.add(var)
    await db.commit()
    await db.refresh(var)
    return var


@router.put("/{experiment_id}/dist-variables/{var_id}", response_model=ExperimentDistVariableOut)
async def update_dist_variable(
    experiment_id: str, var_id: str, body: ExperimentDistVariableUpdate, db: AsyncSession = Depends(get_db)
):
    var = await db.get(ExperimentDistVariable, var_id)
    if not var or var.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Variable not found")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(var, field, value)
    await db.commit()
    await db.refresh(var)
    return var


@router.delete("/{experiment_id}/dist-variables/{var_id}", status_code=204)
async def delete_dist_variable(experiment_id: str, var_id: str, db: AsyncSession = Depends(get_db)):
    var = await db.get(ExperimentDistVariable, var_id)
    if not var or var.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Variable not found")
    await db.delete(var)
    await db.commit()


# ── Questions ─────────────────────────────────────────────────────────────────

@router.post("/{experiment_id}/questions", response_model=QuestionOut, status_code=201)
async def add_question(
    experiment_id: str, body: QuestionCreate, db: AsyncSession = Depends(get_db)
):
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")
    q = Question(id=str(uuid.uuid4()), experiment_id=experiment_id, **body.model_dump())
    db.add(q)
    await db.commit()
    await db.refresh(q)
    return q


@router.put("/{experiment_id}/questions/reorder", status_code=200)
async def reorder_questions(
    experiment_id: str, body: QuestionReorder, db: AsyncSession = Depends(get_db)
):
    for new_order, q_id in enumerate(body.order):
        q = await db.get(Question, q_id)
        if q and q.experiment_id == experiment_id:
            q.sort_order = new_order
    await db.commit()
    return {"status": "ok"}


@router.put("/{experiment_id}/questions/{question_id}", response_model=QuestionOut)
async def update_question(
    experiment_id: str, question_id: str, body: QuestionUpdate, db: AsyncSession = Depends(get_db)
):
    q = await db.get(Question, question_id)
    if not q or q.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Question not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(q, field, value)
    await db.commit()
    await db.refresh(q)
    return q


@router.delete("/{experiment_id}/questions/{question_id}", status_code=204)
async def delete_question(experiment_id: str, question_id: str, db: AsyncSession = Depends(get_db)):
    q = await db.get(Question, question_id)
    if not q or q.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Question not found")
    await db.delete(q)
    await db.commit()


# ── Output Schema ─────────────────────────────────────────────────────────────

@router.post("/{experiment_id}/output-schema", response_model=OutputSchemaOut, status_code=201)
async def create_output_schema(
    experiment_id: str, body: OutputSchemaCreate, db: AsyncSession = Depends(get_db)
):
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")

    # Get latest version
    result = await db.execute(
        select(OutputSchema)
        .where(OutputSchema.experiment_id == experiment_id)
        .order_by(OutputSchema.version.desc())
    )
    latest = result.scalars().first()
    next_version = (latest.version + 1) if latest else 1

    schema = OutputSchema(
        id=str(uuid.uuid4()),
        experiment_id=experiment_id,
        schema_json=[f.model_dump() for f in body.schema_json],
        version=next_version,
    )
    db.add(schema)
    await db.commit()
    await db.refresh(schema)
    return schema


@router.get("/{experiment_id}/output-schema", response_model=OutputSchemaOut)
async def get_output_schema(experiment_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(OutputSchema)
        .where(OutputSchema.experiment_id == experiment_id)
        .order_by(OutputSchema.version.desc())
    )
    schema = result.scalars().first()
    if not schema:
        raise HTTPException(status_code=404, detail="No output schema defined")
    return schema


# ── Pre-flight ────────────────────────────────────────────────────────────────

@router.post("/{experiment_id}/preflight", response_model=PreflightReport)
async def preflight(
    experiment_id: str, body: PreflightRequest, db: AsyncSession = Depends(get_db)
):
    try:
        return await run_preflight(
            experiment_id=experiment_id,
            sample_size=body.sample_size,
            model_pass1=body.model_pass1 or settings.model_pass1,
            model_pass2=body.model_pass2 or settings.model_pass2,
            dual_extraction=body.dual_extraction,
            db=db,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{experiment_id}/preflight/export")
async def preflight_export(
    experiment_id: str, body: PreflightRequest, db: AsyncSession = Depends(get_db)
):
    """Download a .xlsx blueprint of the pre-flight report."""
    import openpyxl
    try:
        report = await run_preflight(
            experiment_id=experiment_id,
            sample_size=body.sample_size,
            model_pass1=body.model_pass1 or settings.model_pass1,
            model_pass2=body.model_pass2 or settings.model_pass2,
            dual_extraction=body.dual_extraction,
            db=db,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Pre-Flight Payloads"

    if report.payloads:
        trait_keys = list(report.payloads[0].persona_traits.keys())
        q_headers = [f"Q{i+1}" for i in range(len(report.payloads[0].questions))]
        headers = trait_keys + ["resolved_vars"] + q_headers
        ws.append(headers)
        for payload in report.payloads:
            row = [payload.persona_traits.get(k) for k in trait_keys]
            row.append(", ".join(f"{k}={v}" for k, v in payload.resolved_variables.items()))
            row += [q.text for q in payload.questions]
            ws.append(row)

    # Cost sheet
    ws_cost = wb.create_sheet("Cost Estimate")
    ws_cost.append(["Pass1 Total", "Pass2 Total", "Grand Total", "Per Persona"])
    ws_cost.append([
        report.cost_estimate.pass1_total,
        report.cost_estimate.pass2_total,
        report.cost_estimate.grand_total,
        report.cost_estimate.per_persona,
    ])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=preflight_{experiment_id}.xlsx"},
    )


# ── Preview Interview (single-persona simulator) ──────────────────────────────

@router.post("/{experiment_id}/preview-interview", response_model=PreviewInterviewResult)
async def preview_interview(
    experiment_id: str, body: PreviewInterviewRequest, db: AsyncSession = Depends(get_db)
):
    """
    Interview one persona with the experiment's current settings — same prompts,
    execution mode and providers as a real run — and return the assembled prompt,
    transcript and extraction so the protocol can be checked before launching.
    """
    try:
        config = await load_experiment_config(experiment_id, db)
    except ValueError:
        raise HTTPException(status_code=404, detail="Experiment not found")

    persona = await db.get(Persona, body.persona_id) if body.persona_id else None
    if body.persona_id and not persona:
        raise HTTPException(status_code=404, detail="Persona not found")
    if persona is None:
        persona = (await db.execute(
            select(Persona)
            .where(Persona.audience_id == config.experiment.audience_id, Persona.archived.is_(False))
            .order_by(func.random()).limit(1)
        )).scalars().first()
        if persona is None:
            raise HTTPException(status_code=400, detail="This audience has no personas yet. Sample some first.")

    model_pass1 = body.model or settings.model_pass1
    model_pass2 = settings.model_pass2
    backstory = persona.backstory
    if not backstory:
        audience = await db.get(Audience, persona.audience_id)
        backstory = await generate_backstory(
            persona.traits_json, settings.step_model("backstory"),
            provider=settings.step_provider("backstory"),
            custom_template=audience.backstory_prompt_template if audience else None,
        )

    context, questions, values = resolve_interview(config)
    try:
        result = await run_interview(
            config.experiment.execution_mode, backstory, persona.traits_json, context, questions,
            model_pass1, settings.provider_pass1,
        )
        extracted_json = extraction_confidence = None
        if config.output_schema:
            ext = await extract_with_confidence(
                transcript=result.transcript,
                output_schema=config.output_schema,
                model=model_pass2,
                provider=settings.provider_pass2,
                dual=body.dual_extraction,
            )
            extracted_json = ext["extracted_json"]
            extraction_confidence = ext["extraction_confidence"]
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM call failed: {e}")

    return PreviewInterviewResult(
        persona_id=persona.id,
        persona_traits=persona.traits_json,
        backstory=backstory,
        resolved_variables=values,
        assembled_prompt=result.assembled_prompt,
        transcript=result.transcript,
        extracted_json=extracted_json,
        extraction_confidence=extraction_confidence,
        pass1_tokens_in=result.tokens_in,
        pass1_tokens_out=result.tokens_out,
        pass1_cost_usd=get_price(model_pass1, result.tokens_in, result.tokens_out),
    )
