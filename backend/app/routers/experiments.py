from __future__ import annotations
import io
import json
import re
import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings  # noqa: used by preflight + preview
from ..database import get_db
from ..models.audience import Persona
from ..models.experiment import (
    Experiment, ExperimentVariable, ExperimentDistVariable, OutputSchema, Question, SynonymSet,
)
from ..schemas.experiment import (
    ExperimentCreate, ExperimentOut, ExperimentUpdate,
    ExperimentDistVariableCreate, ExperimentDistVariableOut, ExperimentDistVariableUpdate,
    ExperimentImportRequest, ExperimentImportResult, ExperimentProtocolBundle,
    ExperimentVariableCreate, ExperimentVariableOut,
    OutputSchemaCreate, OutputSchemaOut,
    PreflightReport, PreflightRequest,
    PreviewInterviewRequest, PreviewInterviewResult,
    QuestionCreate, QuestionOut, QuestionReorder, QuestionUpdate,
    SynonymSetCreate, SynonymSetOut,
)
from ..services.backstory import generate_backstory
from ..services.extraction import extract_with_confidence
from ..services.preflight import run_preflight
from ..services.prompt_assembly import build_dedicated_messages, estimate_message_tokens
from ..services.variable_resolution import apply_synonym_injection, resolve_dist_variables, resolve_variables
from ..services.llm_client import call_llm_messages, get_price

router = APIRouter(prefix="/api/experiments", tags=["experiments"])

EXP_LOAD = [
    selectinload(Experiment.variables),
    selectinload(Experiment.dist_variables),
    selectinload(Experiment.synonym_sets),
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
    (questions, variables, synonyms, output schema) — no run data included.
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
            "synonym_injection_enabled": exp.synonym_injection_enabled,
        },
        "variables": [
            {"placeholder": v.placeholder, "attributes": v.attributes}
            for v in exp.variables
        ],
        "dist_variables": [
            {
                "name": v.name,
                "var_type": v.var_type,
                "distribution": v.distribution,
                "sort_order": v.sort_order,
            }
            for v in exp.dist_variables
        ],
        "synonym_sets": [
            {"canonical": ss.canonical, "synonyms": ss.synonyms}
            for ss in exp.synonym_sets
        ],
        "questions": [
            {
                "sort_order": q.sort_order,
                "question_type": q.question_type,
                "question_text": q.question_text,
                "scale_min": q.scale_min,
                "scale_max": q.scale_max,
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
    All sub-entities (questions, variables, synonyms, output schema) are recreated
    with fresh UUIDs — the original experiment is never modified.
    """
    from ..models.audience import Audience
    audience = await db.get(Audience, body.audience_id)
    if not audience:
        raise HTTPException(status_code=404, detail="Audience not found")

    b = body.bundle
    meta = b.experiment

    exp = Experiment(
        id=str(uuid.uuid4()),
        audience_id=body.audience_id,
        name=meta.name,
        global_context=meta.global_context,
        execution_mode=meta.execution_mode,
        synonym_injection_enabled=meta.synonym_injection_enabled,
    )
    db.add(exp)

    for v in b.variables:
        db.add(ExperimentVariable(
            id=str(uuid.uuid4()),
            experiment_id=exp.id,
            placeholder=v.placeholder,
            attributes=v.attributes,
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

    for ss in b.synonym_sets:
        db.add(SynonymSet(
            id=str(uuid.uuid4()),
            experiment_id=exp.id,
            canonical=ss.canonical,
            synonyms=ss.synonyms,
        ))

    for q in b.questions:
        db.add(Question(
            id=str(uuid.uuid4()),
            experiment_id=exp.id,
            sort_order=q.sort_order,
            question_type=q.question_type,
            question_text=q.question_text,
            scale_min=q.scale_min,
            scale_max=q.scale_max,
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
        variables_imported=len(b.variables),
        dist_variables_imported=len(b.dist_variables),
        synonym_sets_imported=len(b.synonym_sets),
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


# ── Experiment Variables ──────────────────────────────────────────────────────

@router.post("/{experiment_id}/variables", response_model=ExperimentVariableOut, status_code=201)
async def add_exp_variable(
    experiment_id: str, body: ExperimentVariableCreate, db: AsyncSession = Depends(get_db)
):
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")
    var = ExperimentVariable(
        id=str(uuid.uuid4()),
        experiment_id=experiment_id,
        placeholder=body.placeholder,
        attributes=[a.model_dump() for a in body.attributes],
    )
    db.add(var)
    await db.commit()
    await db.refresh(var)
    return var


@router.put("/{experiment_id}/variables/{var_id}", response_model=ExperimentVariableOut)
async def update_exp_variable(
    experiment_id: str, var_id: str, body: ExperimentVariableCreate, db: AsyncSession = Depends(get_db)
):
    var = await db.get(ExperimentVariable, var_id)
    if not var or var.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Variable not found")
    var.placeholder = body.placeholder
    var.attributes = [a.model_dump() for a in body.attributes]
    await db.commit()
    await db.refresh(var)
    return var


@router.delete("/{experiment_id}/variables/{var_id}", status_code=204)
async def delete_exp_variable(experiment_id: str, var_id: str, db: AsyncSession = Depends(get_db)):
    var = await db.get(ExperimentVariable, var_id)
    if not var or var.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Variable not found")
    await db.delete(var)
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


# ── Synonym Sets ──────────────────────────────────────────────────────────────

@router.post("/{experiment_id}/synonym-sets", response_model=SynonymSetOut, status_code=201)
async def add_synonym_set(
    experiment_id: str, body: SynonymSetCreate, db: AsyncSession = Depends(get_db)
):
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")
    ss = SynonymSet(
        id=str(uuid.uuid4()),
        experiment_id=experiment_id,
        canonical=body.canonical,
        synonyms=body.synonyms,
    )
    db.add(ss)
    await db.commit()
    await db.refresh(ss)
    return ss


@router.delete("/{experiment_id}/synonym-sets/{ss_id}", status_code=204)
async def delete_synonym_set(experiment_id: str, ss_id: str, db: AsyncSession = Depends(get_db)):
    ss = await db.get(SynonymSet, ss_id)
    if not ss or ss.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Synonym set not found")
    await db.delete(ss)
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
    for field, value in body.model_dump(exclude_none=True).items():
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
        headers = trait_keys + ["plausibility", "flags", "resolved_vars"] + q_headers
        ws.append(headers)
        for payload in report.payloads:
            row = [payload.persona_traits.get(k) for k in trait_keys]
            row += [
                payload.plausibility,
                "; ".join(payload.flags),
                str(payload.resolved_variables),
            ]
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
    Run a single dedicated-mode interview for debugging.
    Returns the assembled prompt + transcript + extraction so researchers can
    inspect exactly how Algorithm 3 (backstory) and Algorithm 4 (variable resolution) merged.
    """
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise HTTPException(status_code=404, detail="Experiment not found")

    persona = await db.get(Persona, body.persona_id)
    if not persona:
        raise HTTPException(status_code=404, detail="Persona not found")

    backstory = persona.backstory
    if not backstory:
        backstory = await generate_backstory(persona.traits_json, settings.model_pass2)

    # Load questions and variables
    vars_result = await db.execute(
        select(ExperimentVariable).where(ExperimentVariable.experiment_id == experiment_id)
    )
    exp_vars = vars_result.scalars().all()

    dist_vars_result = await db.execute(
        select(ExperimentDistVariable).where(ExperimentDistVariable.experiment_id == experiment_id)
    )
    dist_vars = dist_vars_result.scalars().all()

    syn_result = await db.execute(
        select(SynonymSet).where(SynonymSet.experiment_id == experiment_id)
    )
    synonym_sets = syn_result.scalars().all()

    q_result = await db.execute(
        select(Question).where(Question.experiment_id == experiment_id).order_by(Question.sort_order)
    )
    questions = q_result.scalars().all()

    resolved_cache: dict[str, str] = {}
    dist_cache: dict[str, str] = {}
    q_dicts = []
    for q in questions:
        q_text = resolve_variables(q.question_text, exp_vars, resolved_cache)
        q_text = resolve_dist_variables(q_text, dist_vars, dist_cache)
        if exp.synonym_injection_enabled:
            q_text = apply_synonym_injection(q_text, synonym_sets)
        q_dicts.append({
            "sort_order": q.sort_order,
            "text": q_text,
            "type": q.question_type,
            "ask_why": q.ask_why,
        })

    # Build dedicated messages and run turn by turn
    system_msg = {
        "role": "system",
        "content": (
            f"{backstory}\n\n{exp.global_context}\n\n"
            "You are in a research interview. Answer each question naturally and conversationally."
        ),
    }
    assembled_parts = [f"[SYSTEM]\n{system_msg['content']}"]
    conversation = [system_msg]
    total_in = total_out = 0

    for q in q_dicts:
        q_text = q["text"]
        if q.get("ask_why"):
            q_text += "\nPlease think through your reasoning before answering."
        conversation.append({"role": "user", "content": q_text})
        assembled_parts.append(f"\n[Q{q['sort_order']}] {q_text}")

        response, tin, tout = await call_llm_messages(conversation, model=body.model, temperature=0.7)
        total_in += tin
        total_out += tout
        conversation.append({"role": "assistant", "content": response})
        assembled_parts.append(f"[A{q['sort_order']}] {response}")

    transcript = "\n".join(assembled_parts)
    assembled_prompt = assembled_parts[0]

    # Optional extraction
    extracted_json = extraction_confidence = None
    schema_result = await db.execute(
        select(OutputSchema)
        .where(OutputSchema.experiment_id == experiment_id)
        .order_by(OutputSchema.version.desc())
    )
    schema = schema_result.scalars().first()
    if schema and schema.schema_json:
        ext = await extract_with_confidence(
            transcript=transcript,
            output_schema=schema.schema_json,
            model=settings.model_pass2,
            dual=body.dual_extraction,
        )
        extracted_json = ext["extracted_json"]
        extraction_confidence = ext["extraction_confidence"]

    cost = get_price(body.model, total_in, total_out)

    return PreviewInterviewResult(
        persona_id=body.persona_id,
        assembled_prompt=assembled_prompt,
        transcript=transcript,
        extracted_json=extracted_json,
        extraction_confidence=extraction_confidence,
        pass1_tokens_in=total_in,
        pass1_tokens_out=total_out,
        pass1_cost_usd=cost,
    )
