"""
Module 4: Execution Engine
Pass 1 / Pass 2 orchestration, smart retry, resume, re-extract.

Run progress (completed / failed / cost / final status) is always recomputed
from the task rows by refresh_run_progress, never incremented in place, so
concurrent tasks cannot lose updates and re-running a pass cannot double-count.
LLM calls happen outside DB sessions; sessions are opened only to read and
write task state.
"""
from __future__ import annotations
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, case, func, or_, select, update

from ..config import settings
from ..database import AsyncSessionLocal
from ..models.audience import Audience, Persona
from ..models.experiment import OutputSchema
from ..models.simulation import SimulationRun, SimulationTask
from .backstory import build_default_backstory, generate_backstory
from .extraction import extract_with_confidence
from .interview import InterviewCancelled, load_experiment_config, resolve_interview, run_interview
from .llm_client import get_price

logger = logging.getLogger(__name__)

ACTIVE_STATUSES = ("pending", "running")
FINISHED_STATUSES = ("completed", "completed_with_errors", "failed", "cancelled")


def run_settings(run: SimulationRun) -> dict[str, Any]:
    """Execution parameters locked at launch (older runs fall back to current settings)."""
    locked = run.locked_config or {}
    return {
        "model_pass1": run.model_pass1,
        "model_pass2": run.model_pass2,
        "provider_pass1": locked.get("provider_pass1", settings.provider_pass1),
        "provider_pass2": locked.get("provider_pass2", settings.provider_pass2),
        "dual_extraction": locked.get("dual_extraction", True),
        "execution_mode": locked.get("execution_mode", "pooled"),
        "output_schema": locked.get("output_schema", []),
        "drift_detection_enabled": locked.get("drift_detection_enabled", True),
    }


# ── Progress ──────────────────────────────────────────────────────────────────

async def refresh_run_progress(run_id: str) -> None:
    """Recompute counters and cost from tasks; finalise the run when nothing is left."""
    t = SimulationTask
    is_completed = and_(t.pass1_status == "completed", t.pass2_status == "completed")
    is_failed = or_(t.pass1_status == "failed", t.pass2_status == "failed")
    is_cancelled = or_(t.pass1_status == "cancelled", t.pass2_status == "cancelled")
    async with AsyncSessionLocal() as db:
        row = (await db.execute(
            select(
                func.count().label("total"),
                func.sum(case((is_completed, 1), else_=0)).label("completed"),
                func.sum(case((is_failed, 1), else_=0)).label("failed"),
                func.sum(case((and_(~is_failed, is_cancelled), 1), else_=0)).label("cancelled"),
                func.coalesce(func.sum(t.pass1_cost_usd), 0.0).label("cost1"),
                func.coalesce(func.sum(t.pass2_cost_usd), 0.0).label("cost2"),
            ).where(t.run_id == run_id)
        )).one()
        completed, failed = int(row.completed or 0), int(row.failed or 0)
        remaining = row.total - completed - failed - int(row.cancelled or 0)

        values: dict[str, Any] = {
            "completed_tasks": completed,
            "failed_tasks": failed,
            "total_cost_usd": float(row.cost1) + float(row.cost2),
        }
        await db.execute(update(SimulationRun).where(SimulationRun.id == run_id).values(**values))

        if remaining <= 0:
            final = "completed" if failed == 0 else ("failed" if completed == 0 else "completed_with_errors")
            await db.execute(
                update(SimulationRun)
                .where(SimulationRun.id == run_id, SimulationRun.status == "running")
                .values(status=final, completed_at=datetime.now(timezone.utc))
            )
        await db.commit()


async def _run_is_cancelled(run_id: str) -> bool:
    async with AsyncSessionLocal() as db:
        status = await db.scalar(select(SimulationRun.status).where(SimulationRun.id == run_id))
    return status is None or status == "cancelled"


# ── Single task ───────────────────────────────────────────────────────────────

async def _update_task(task_id: str, **values: Any) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(update(SimulationTask).where(SimulationTask.id == task_id).values(**values))
        await db.commit()


async def _execute_task(task_id: str, cfg: dict[str, Any], exp_config: Any) -> None:
    """Run whatever is still pending for one task (Pass 1 + Pass 2, or Pass 2 only)."""
    async with AsyncSessionLocal() as db:
        task = await db.get(SimulationTask, task_id)
        if not task:
            return
        run_pass1 = task.pass1_status in ("pending", "failed")
        run_pass2 = run_pass1 or (task.pass1_status == "completed" and task.pass2_status in ("pending", "failed"))
        if not run_pass2:
            return
        if await _run_is_cancelled(task.run_id):
            return
        persona = await db.get(Persona, task.persona_id)
        run_id, injected_vars, transcript = task.run_id, dict(task.injected_vars or {}), task.raw_transcript
        traits = persona.traits_json if persona else {}
        backstory = (persona.backstory or "") if persona else ""

    if run_pass1:
        if exp_config is None:
            await _update_task(task_id, pass1_status="failed", pass1_error="Experiment not found")
            return
        if persona is None:
            await _update_task(task_id, pass1_status="failed", pass1_error="Persona not found")
            return
        await _update_task(task_id, pass1_status="running", pass1_error=None)
        try:
            context, questions, _ = resolve_interview(exp_config, injected_vars)
            result = await run_interview(
                cfg["execution_mode"], backstory, traits, context, questions,
                cfg["model_pass1"], cfg["provider_pass1"],
                **({
                    "drift_detection": cfg["drift_detection_enabled"],
                    "scorer_model": cfg["model_pass2"],
                    "scorer_provider": cfg["provider_pass2"],
                    "is_cancelled": lambda: _run_is_cancelled(run_id),
                } if cfg["execution_mode"] == "dedicated" else {}),
            )
        except InterviewCancelled:
            await _update_task(task_id, pass1_status="cancelled", pass2_status="cancelled")
            return
        except Exception as e:
            logger.error(f"Task {task_id} Pass 1 failed: {e}")
            await _update_task(task_id, pass1_status="failed", pass1_error=str(e))
            return

        transcript = result.transcript
        await _update_task(
            task_id,
            raw_transcript=transcript,
            pass1_prompt=result.assembled_prompt,
            pass1_tokens_in=result.tokens_in,
            pass1_tokens_out=result.tokens_out,
            pass1_cost_usd=get_price(cfg["model_pass1"], result.tokens_in, result.tokens_out),
            drift_scores=result.drift_scores or None,
            drift_flagged=result.drift_flagged,
            pass1_status="completed",
        )

    if await _run_is_cancelled(run_id):
        await _update_task(task_id, pass2_status="cancelled")
        return

    output_schema = cfg["output_schema"]
    if not output_schema:
        await _update_task(task_id, pass2_status="completed", extracted_json={})
        return

    await _update_task(task_id, pass2_status="running", pass2_error=None)
    try:
        ext = await extract_with_confidence(
            transcript=transcript or "",
            output_schema=output_schema,
            model=cfg["model_pass2"],
            provider=cfg["provider_pass2"],
            dual=cfg["dual_extraction"],
        )
    except Exception as e:
        logger.error(f"Task {task_id} Pass 2 failed: {e}")
        await _update_task(task_id, pass2_status="failed", pass2_error=str(e))
        return

    await _update_task(
        task_id,
        extracted_json=ext["extracted_json"],
        extraction_confidence=ext["extraction_confidence"],
        extraction_disagreements=ext["extraction_disagreements"],
        pass2_tokens_in=ext["pass2_tokens_in"],
        pass2_tokens_out=ext["pass2_tokens_out"],
        pass2_cost_usd=ext["pass2_cost_usd"],
        pass2_status="completed",
    )


async def _execute_tasks(run_id: str, task_ids: list[str], cfg: dict[str, Any], exp_config: Any) -> None:
    """
    Run tasks with bounded parallelism. The global LLM limiter caps API calls;
    this cap keeps the number of in-flight tasks (and DB sessions) in step.
    """
    sem = asyncio.Semaphore(max(1, settings.max_concurrent_tasks))
    last_refresh = 0.0

    async def one(task_id: str) -> None:
        nonlocal last_refresh
        async with sem:
            try:
                await _execute_task(task_id, cfg, exp_config)
            except Exception:
                logger.exception(f"Task {task_id}: unexpected error")
        now = time.monotonic()
        if now - last_refresh >= 1.0:   # progress is a full recount; throttle it
            last_refresh = now
            await refresh_run_progress(run_id)

    await asyncio.gather(*(one(tid) for tid in task_ids))
    await refresh_run_progress(run_id)


# ── Backstories for personas created at launch ────────────────────────────────

async def _fill_missing_backstories(run_id: str) -> None:
    async with AsyncSessionLocal() as db:
        run = await db.get(SimulationRun, run_id)
        audience = await db.get(Audience, (run.locked_config or {}).get("audience_id", "")) if run else None
        personas = (await db.execute(
            select(Persona)
            .join(SimulationTask, SimulationTask.persona_id == Persona.id)
            .where(SimulationTask.run_id == run_id, Persona.backstory.is_(None))
            .distinct()
        )).scalars().all()
        targets = [(p.id, p.traits_json) for p in personas]
    if not targets:
        return

    template = audience.backstory_prompt_template if audience else None
    logger.info(f"Run {run_id}: generating backstories for {len(targets)} personas")

    async def make(traits: dict[str, Any]) -> str:
        try:
            return await generate_backstory(
                traits, settings.step_model("backstory"),
                provider=settings.step_provider("backstory"), custom_template=template,
            )
        except Exception as e:
            logger.warning(f"Backstory generation failed: {e}")
            return build_default_backstory(traits)

    stories = await asyncio.gather(*(make(traits) for _, traits in targets))
    async with AsyncSessionLocal() as db:
        for (pid, _), story in zip(targets, stories):
            await db.execute(update(Persona).where(Persona.id == pid).values(backstory=story))
        await db.commit()


# ── Entry points (background tasks) ───────────────────────────────────────────

async def launch_run(run_id: str) -> None:
    """Run every task of a run that still has work to do."""
    try:
        async with AsyncSessionLocal() as db:
            run = await db.get(SimulationRun, run_id)
            if not run or run.status == "cancelled":
                return
            run.status = "running"
            run.completed_at = None
            await db.commit()
            cfg = run_settings(run)
            try:
                exp_config = await load_experiment_config(run.experiment_id, db)
            except ValueError:
                exp_config = None
            task_ids = list((await db.execute(
                select(SimulationTask.id).where(SimulationTask.run_id == run_id)
            )).scalars().all())

        await _fill_missing_backstories(run_id)
        logger.info(f"launch_run: run={run_id} model_pass1={cfg['model_pass1']} tasks={len(task_ids)}")
        await _execute_tasks(run_id, task_ids, cfg, exp_config)
    except Exception as e:
        logger.error(f"launch_run: unexpected error for run {run_id}: {e}", exc_info=True)


async def retry_failed_tasks(run_id: str) -> None:
    """Smart retry: Pass 1 failures → full retry. Pass 2 failures → extraction only."""
    async with AsyncSessionLocal() as db:
        t = SimulationTask
        await db.execute(
            update(t).where(t.run_id == run_id, t.pass1_status == "failed")
            .values(pass1_status="pending", pass2_status="pending", raw_transcript=None,
                    extracted_json=None, pass1_error=None)
        )
        await db.execute(
            update(t).where(t.run_id == run_id, t.pass1_status == "completed", t.pass2_status == "failed")
            .values(pass2_status="pending", extracted_json=None, pass2_error=None)
        )
        await db.execute(update(SimulationRun).where(SimulationRun.id == run_id).values(status="running"))
        await db.commit()
    await refresh_run_progress(run_id)
    await launch_run(run_id)


async def resume_run(run_id: str) -> None:
    """Re-queue tasks that were cancelled or interrupted mid-flight, then continue the run."""
    async with AsyncSessionLocal() as db:
        t = SimulationTask
        await db.execute(
            update(t).where(t.run_id == run_id, t.pass1_status.in_(("cancelled", "running")))
            .values(pass1_status="pending", pass2_status="pending")
        )
        await db.execute(
            update(t).where(t.run_id == run_id, t.pass1_status == "completed",
                            t.pass2_status.in_(("cancelled", "running")))
            .values(pass2_status="pending")
        )
        await db.execute(update(SimulationRun).where(SimulationRun.id == run_id).values(status="running"))
        await db.commit()
    await refresh_run_progress(run_id)
    await launch_run(run_id)


async def re_extract_run(run_id: str, schema_version: int | None = None) -> None:
    """Re-run Pass 2 for all completed interviews using the latest (or given) schema."""
    async with AsyncSessionLocal() as db:
        run = await db.get(SimulationRun, run_id)
        if not run:
            return
        q = select(OutputSchema).where(OutputSchema.experiment_id == run.experiment_id)
        q = q.where(OutputSchema.version == schema_version) if schema_version else q.order_by(OutputSchema.version.desc())
        schema = (await db.execute(q)).scalars().first()
        if not schema:
            return
        # The run's locked schema drives analysis field types, so it must follow the re-extraction.
        run.locked_config = {**(run.locked_config or {}), "output_schema": schema.schema_json,
                             "schema_version": schema.version}
        run.status = "running"
        await db.execute(
            update(SimulationTask)
            .where(SimulationTask.run_id == run_id, SimulationTask.pass1_status == "completed")
            .values(pass2_status="pending", extracted_json=None, extraction_confidence=None,
                    extraction_disagreements=None, pass2_error=None, pass2_cost_usd=None)
        )
        await db.commit()
        cfg = run_settings(run)
        task_ids = list((await db.execute(
            select(SimulationTask.id).where(SimulationTask.run_id == run_id, SimulationTask.pass2_status == "pending")
        )).scalars().all())

    await _execute_tasks(run_id, task_ids, cfg, exp_config=None)


async def recover_interrupted_runs() -> None:
    """
    Background tasks die with the process. On startup, mark runs that were still
    active as cancelled (with their in-flight tasks) so they can be resumed —
    without silently spending money on restart.
    """
    async with AsyncSessionLocal() as db:
        run_ids = list((await db.execute(
            select(SimulationRun.id).where(SimulationRun.status.in_(ACTIVE_STATUSES))
        )).scalars().all())
        if not run_ids:
            return
        t = SimulationTask
        await db.execute(update(t).where(t.run_id.in_(run_ids), t.pass1_status == "running")
                         .values(pass1_status="cancelled", pass2_status="cancelled"))
        await db.execute(update(t).where(t.run_id.in_(run_ids), t.pass2_status == "running")
                         .values(pass2_status="cancelled"))
        await db.execute(update(SimulationRun).where(SimulationRun.id.in_(run_ids)).values(status="cancelled"))
        await db.commit()
    logger.warning(f"Marked {len(run_ids)} interrupted run(s) as cancelled; resume them from the run page")
