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
from . import batch
from .extraction import (
    _build_response_json_schema, build_extraction_messages, combine_extractions, extract_with_confidence,
    extraction_temperatures,
)
from .interview import (
    INTERVIEW_TEMPERATURE, InterviewCancelled, config_from_snapshot, load_experiment_config,
    resolve_interview, run_interview,
)
from .llm_client import LLMResult, request_body
from .prompt_assembly import build_pooled_prompt

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
            pass1_cost_usd=result.cost_usd,
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

async def _experiment_config(run: SimulationRun, cfg: dict[str, Any], db: Any) -> Any:
    protocol = (run.locked_config or {}).get("protocol")
    if protocol:
        return config_from_snapshot(protocol, cfg["output_schema"])
    try:   # runs launched before protocols were frozen
        return await load_experiment_config(run.experiment_id, db)
    except ValueError:
        return None


async def launch_run(run_id: str) -> None:
    """Run every task of a run that still has work to do."""
    try:
        async with AsyncSessionLocal() as db:
            run = await db.get(SimulationRun, run_id)
            if not run or run.status == "cancelled":
                return
            batch_mode = run.batch_mode
            if not batch_mode:
                run.status = "running"
                run.completed_at = None
                await db.commit()
                cfg = run_settings(run)
                exp_config = await _experiment_config(run, cfg, db)
                task_ids = list((await db.execute(
                    select(SimulationTask.id).where(SimulationTask.run_id == run_id)
                )).scalars().all())
        if batch_mode:
            await run_batch(run_id)
            return

        await _fill_missing_backstories(run_id)
        logger.info(f"launch_run: run={run_id} model_pass1={cfg['model_pass1']} tasks={len(task_ids)}")
        await _execute_tasks(run_id, task_ids, cfg, exp_config)
    except Exception as e:
        logger.error(f"launch_run: unexpected error for run {run_id}: {e}", exc_info=True)


# ── Batch API runs ────────────────────────────────────────────────────────────
# Pooled interviews are submitted as one provider batch, then extraction as a
# second. The batch ids live in run.batch_state, so a restart resumes polling
# instead of resubmitting. Tasks waiting on a batch are marked "running".

async def _set_batch_state(run_id: str, state: dict[str, Any] | None) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(update(SimulationRun).where(SimulationRun.id == run_id).values(batch_state=state))
        await db.commit()


async def _submit(run_id: str, phase: str, provider: str, requests: list[tuple[str, dict[str, Any]]]) -> dict[str, Any]:
    backend = batch.get_backend(provider)
    state: dict[str, Any] = {
        "phase": phase, "provider": provider, "batches": [],
        "submitted_at": datetime.now(timezone.utc).isoformat(), "total": len(requests), "done": 0, "failed": 0,
    }
    for i in range(0, len(requests), batch.MAX_REQUESTS_PER_BATCH):
        state["batches"].append(await backend.submit(requests[i:i + batch.MAX_REQUESTS_PER_BATCH]))
        await _set_batch_state(run_id, dict(state))   # saved per chunk: never lose a submitted batch
    logger.info(f"Run {run_id}: submitted {len(requests)} {phase} requests in {len(state['batches'])} batch(es)")
    return state


async def _cancel_waiting_tasks(run_id: str) -> None:
    async with AsyncSessionLocal() as db:
        t = SimulationTask
        await db.execute(update(t).where(t.run_id == run_id, t.pass1_status == "running")
                         .values(pass1_status="cancelled", pass2_status="cancelled"))
        await db.execute(update(t).where(t.run_id == run_id, t.pass2_status == "running")
                         .values(pass2_status="cancelled"))
        await db.commit()


async def _await_batches(run_id: str, state: dict[str, Any]) -> tuple[dict[str, batch.Outcome], str] | None:
    """Poll until every batch has ended; returns (outcomes by custom_id, fallback error), or None if cancelled."""
    backend = batch.get_backend(state["provider"])
    poll_errors = 0
    while True:
        if await _run_is_cancelled(run_id):
            for batch_id in state["batches"]:
                try:
                    await backend.cancel(batch_id)
                except Exception as e:
                    logger.warning(f"Could not cancel batch {batch_id}: {e}")
            await _cancel_waiting_tasks(run_id)
            await _set_batch_state(run_id, None)
            return None
        try:
            statuses = [await backend.status(b) for b in state["batches"]]
            poll_errors = 0
        except Exception as e:
            poll_errors += 1
            if poll_errors >= 10:
                raise
            logger.warning(f"Run {run_id}: batch status check failed ({e}); retrying")
            await asyncio.sleep(settings.batch_poll_seconds)
            continue
        state.update(done=sum(s.done for s in statuses), failed=sum(s.failed for s in statuses))
        await _set_batch_state(run_id, dict(state))
        if all(s.ended for s in statuses):
            break
        await asyncio.sleep(settings.batch_poll_seconds)

    outcomes: dict[str, batch.Outcome] = {}
    for batch_id in state["batches"]:
        outcomes.update(await backend.results(batch_id))
    fallback = next((s.error for s in statuses if s.error), None) or "No result returned by the batch"
    return outcomes, fallback


async def _batch_interviews(run_id: str, cfg: dict[str, Any], exp_config: Any, state: dict[str, Any] | None) -> bool:
    """Pass 1 through the batch API. Returns False if the run was cancelled."""
    provider, model = cfg["provider_pass1"], cfg["model_pass1"]
    if state is None:
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(SimulationTask.id, SimulationTask.injected_vars, Persona.backstory)
                .outerjoin(Persona, Persona.id == SimulationTask.persona_id)
                .where(SimulationTask.run_id == run_id, SimulationTask.pass1_status.in_(("pending", "failed")))
            )).all()
        if not rows:
            return True
        # One live call first: it teaches the client which parameters this model
        # rejects, so every batched request is built in a shape the model accepts.
        probe_id = rows[0][0]
        await _execute_task(probe_id, cfg, exp_config)
        async with AsyncSessionLocal() as db:
            probe = await db.get(SimulationTask, probe_id)
            probe_error = probe.pass1_error if probe.pass1_status == "failed" else None
        rest = rows[1:]
        if probe_error:
            for tid, *_ in rest:
                await _update_task(tid, pass1_status="failed", pass2_status="pending",
                                   pass1_error=f"Not submitted, the first interview failed: {probe_error}")
            return True
        if not rest:
            return True

        requests = []
        for tid, injected, backstory in rest:
            context, questions, _ = resolve_interview(exp_config, dict(injected or {}))
            messages, assembled = build_pooled_prompt(backstory or "", context, questions, model)
            requests.append((f"{tid}__p1", request_body(provider, messages, model, INTERVIEW_TEMPERATURE)))
            await _update_task(tid, pass1_status="running", pass1_error=None, pass1_prompt=assembled)
        state = await _submit(run_id, "interviews", provider, requests)

    waited = await _await_batches(run_id, state)
    if waited is None:
        return False
    outcomes, fallback = waited
    async with AsyncSessionLocal() as db:
        waiting = (await db.execute(
            select(SimulationTask.id).where(SimulationTask.run_id == run_id, SimulationTask.pass1_status == "running")
        )).scalars().all()
    for tid in waiting:
        res = outcomes.get(f"{tid}__p1", fallback)
        if isinstance(res, LLMResult):
            await _update_task(
                tid, raw_transcript=res.text, pass1_tokens_in=res.tokens_in, pass1_tokens_out=res.tokens_out,
                pass1_cost_usd=res.cost(model), pass1_status="completed",
            )
        else:
            await _update_task(tid, pass1_status="failed", pass1_error=res)
    await _set_batch_state(run_id, None)
    await refresh_run_progress(run_id)
    return True


async def _batch_extractions(run_id: str, cfg: dict[str, Any], state: dict[str, Any] | None) -> bool:
    """Pass 2 through the batch API (one request per extraction temperature)."""
    provider, model, schema = cfg["provider_pass2"], cfg["model_pass2"], cfg["output_schema"]
    temperatures = extraction_temperatures(cfg["dual_extraction"])
    if state is None:
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(SimulationTask.id, SimulationTask.raw_transcript).where(
                    SimulationTask.run_id == run_id, SimulationTask.pass1_status == "completed",
                    SimulationTask.pass2_status.in_(("pending", "failed")),
                )
            )).all()
        if not rows:
            return True
        resp_schema = _build_response_json_schema(schema)
        requests = []
        for tid, transcript in rows:
            messages = build_extraction_messages(transcript or "", schema)
            requests += [
                (f"{tid}__x{i}", request_body(provider, messages, model, temp, json_schema=resp_schema))
                for i, temp in enumerate(temperatures)
            ]
            await _update_task(tid, pass2_status="running", pass2_error=None)
        state = await _submit(run_id, "extraction", provider, requests)

    waited = await _await_batches(run_id, state)
    if waited is None:
        return False
    outcomes, fallback = waited
    async with AsyncSessionLocal() as db:
        waiting = (await db.execute(
            select(SimulationTask.id).where(SimulationTask.run_id == run_id, SimulationTask.pass2_status == "running")
        )).scalars().all()
    for tid in waiting:
        results = [outcomes.get(f"{tid}__x{i}", fallback) for i in range(len(temperatures))]
        ok = [r for r in results if isinstance(r, LLMResult)]
        try:
            if not ok:
                raise ValueError(results[0])
            data, confidence, disagreements = combine_extractions([r.text for r in ok], schema)
        except ValueError as e:
            await _update_task(tid, pass2_status="failed", pass2_error=str(e))
            continue
        await _update_task(
            tid, extracted_json=data, extraction_confidence=confidence, extraction_disagreements=disagreements,
            pass2_tokens_in=sum(r.tokens_in for r in ok), pass2_tokens_out=sum(r.tokens_out for r in ok),
            pass2_cost_usd=sum(r.cost(model) for r in ok), pass2_status="completed",
        )
    await _set_batch_state(run_id, None)
    return True


async def run_batch(run_id: str) -> None:
    """Run (or, after a restart, keep polling) a batch-mode run: interviews, then extraction."""
    try:
        async with AsyncSessionLocal() as db:
            run = await db.get(SimulationRun, run_id)
            if not run or run.status == "cancelled":
                return
            run.status = "running"
            run.completed_at = None
            await db.commit()
            cfg = run_settings(run)
            exp_config = await _experiment_config(run, cfg, db)
            state = run.batch_state
        phase = (state or {}).get("phase")

        if phase != "extraction":
            if state is None:
                await _fill_missing_backstories(run_id)
            if exp_config is None:
                async with AsyncSessionLocal() as db:
                    await db.execute(update(SimulationTask).where(
                        SimulationTask.run_id == run_id, SimulationTask.pass1_status.in_(("pending", "failed"))
                    ).values(pass1_status="failed", pass1_error="Experiment not found"))
                    await db.commit()
            elif not await _batch_interviews(run_id, cfg, exp_config, state):
                return
            state = None

        if await _run_is_cancelled(run_id):
            await _cancel_waiting_tasks(run_id)
        elif not cfg["output_schema"]:
            async with AsyncSessionLocal() as db:
                await db.execute(update(SimulationTask).where(
                    SimulationTask.run_id == run_id, SimulationTask.pass1_status == "completed",
                    SimulationTask.pass2_status.in_(("pending", "failed")),
                ).values(pass2_status="completed", extracted_json={}))
                await db.commit()
        elif cfg["provider_pass2"] in batch.BATCH_PROVIDERS:
            if not await _batch_extractions(run_id, cfg, state):
                return
        else:   # e.g. a local LM Studio extraction model: run it live
            async with AsyncSessionLocal() as db:
                task_ids = list((await db.execute(select(SimulationTask.id).where(
                    SimulationTask.run_id == run_id, SimulationTask.pass1_status == "completed",
                    SimulationTask.pass2_status.in_(("pending", "failed")),
                ))).scalars().all())
            await _execute_tasks(run_id, task_ids, cfg, exp_config)
    except Exception as e:
        logger.error(f"run_batch: unexpected error for run {run_id}: {e}", exc_info=True)
        async with AsyncSessionLocal() as db:
            t = SimulationTask
            await db.execute(update(t).where(t.run_id == run_id, t.pass1_status == "running")
                             .values(pass1_status="failed", pass1_error=f"Batch error: {e}"))
            await db.execute(update(t).where(t.run_id == run_id, t.pass2_status == "running")
                             .values(pass2_status="failed", pass2_error=f"Batch error: {e}"))
            await db.commit()
        await _set_batch_state(run_id, None)
    await refresh_run_progress(run_id)


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


_background: set[asyncio.Task] = set()


async def recover_interrupted_runs() -> None:
    """
    Background tasks die with the process. On startup, mark runs that were still
    active as cancelled (with their in-flight tasks) so they can be resumed —
    without silently spending money on restart. Runs waiting on a provider batch
    keep going: the work is already paid for, so polling simply resumes.
    """
    async with AsyncSessionLocal() as db:
        active = (await db.execute(
            select(SimulationRun.id, SimulationRun.batch_state).where(SimulationRun.status.in_(ACTIVE_STATUSES))
        )).all()
        run_ids = [rid for rid, state in active if not state]
        batch_ids = [rid for rid, state in active if state]
        if run_ids:
            t = SimulationTask
            await db.execute(update(t).where(t.run_id.in_(run_ids), t.pass1_status == "running")
                             .values(pass1_status="cancelled", pass2_status="cancelled"))
            await db.execute(update(t).where(t.run_id.in_(run_ids), t.pass2_status == "running")
                             .values(pass2_status="cancelled"))
            await db.execute(update(SimulationRun).where(SimulationRun.id.in_(run_ids)).values(status="cancelled"))
            await db.commit()
    if run_ids:
        logger.warning(f"Marked {len(run_ids)} interrupted run(s) as cancelled; resume them from the run page")
    for rid in batch_ids:
        logger.info(f"Resuming batch polling for run {rid}")
        task = asyncio.create_task(run_batch(rid))
        _background.add(task)
        task.add_done_callback(_background.discard)
