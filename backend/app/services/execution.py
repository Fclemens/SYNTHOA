"""
Module 4: Execution Engine
RateLimitedExecutor + full pass1/pass2 orchestration + smart retry + re-extract.
"""
from __future__ import annotations
import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models.experiment import Experiment, ExperimentDistVariable, ExperimentVariable, OutputSchema, Question, SynonymSet
from ..models.audience import Persona
from ..models.simulation import SimulationRun, SimulationTask
from ..services.backstory import _build_default_backstory, generate_backstory
from ..services.drift_detection import (
    DRIFT_SCORE_THRESHOLD,
    build_grounding_refresh,
    get_checkpoint_prompt,
    score_adherence,
    should_inject_checkpoint,
)
from ..services.extraction import extract_with_confidence
from ..services.llm_client import call_llm_messages, get_price
from ..services.prompt_assembly import build_dedicated_messages, build_pooled_prompt, estimate_message_tokens
from ..services.variable_resolution import apply_synonym_injection, resolve_dist_variables, resolve_variables

logger = logging.getLogger(__name__)

class RateLimitedExecutor:
    """
    Dispatches simulation tasks concurrently via asyncio.gather.
    Rate limiting (max_concurrent_tasks + tpm_limit) is now enforced globally
    inside llm_client.call_llm_messages, so every LLM call — whether it comes
    from a simulation task, backstory generation, preview interview, or drift
    scoring — is subject to the same limits without double-counting.
    """

    async def execute_batch(
        self,
        tasks: list[SimulationTask],
        run_config: dict[str, Any],
        db_factory: Any,
    ) -> None:
        """Launch all tasks concurrently; rate limiting happens inside each LLM call."""
        async def _run_one(task: SimulationTask) -> None:
            # Cancellation check before starting any LLM work
            async with db_factory() as db:
                run = await db.get(SimulationRun, task.run_id)
                if not run or run.status == "cancelled":
                    return
            async with db_factory() as db:
                await _execute_task(task.id, run_config, db)

        await asyncio.gather(*[_run_one(t) for t in tasks], return_exceptions=True)


async def _load_experiment_config(experiment_id: str, db: AsyncSession) -> dict[str, Any]:
    """Load all experiment-related objects for task execution."""
    exp = await db.get(Experiment, experiment_id)

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

    schema_result = await db.execute(
        select(OutputSchema)
        .where(OutputSchema.experiment_id == experiment_id)
        .order_by(OutputSchema.version.desc())
    )
    schema = schema_result.scalars().first()

    return {
        "experiment": exp,
        "exp_vars": exp_vars,
        "dist_vars": dist_vars,
        "synonym_sets": synonym_sets,
        "questions": questions,
        "output_schema": schema.schema_json if schema else [],
    }


async def _run_pooled_interview(
    backstory: str,
    traits: dict[str, Any],
    config: dict[str, Any],
    model: str,
    provider: str = "openai",
    injected_vars: dict[str, str] | None = None,
) -> tuple[str, int, int, str]:
    """
    Run a pooled (single-prompt) interview.
    Returns (transcript, tokens_in, tokens_out, assembled_prompt).
    injected_vars pre-seeds both resolution caches so the LLM sees exactly the
    values that were stored on the task at launch time.
    """
    exp = config["experiment"]
    exp_vars = config["exp_vars"]
    dist_vars = config.get("dist_vars", [])
    synonym_sets = config["synonym_sets"]
    questions = config["questions"]

    # Pre-seed from stored injected_vars — both caches use the same dict because
    # exp-var placeholder keys and dist-var name keys never overlap.
    resolved_cache: dict[str, str] = dict(injected_vars) if injected_vars else {}
    dist_cache: dict[str, str] = dict(injected_vars) if injected_vars else {}
    resolved_context = resolve_variables(exp.global_context, exp_vars, resolved_cache)

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
            "scale_min": q.scale_min,
            "scale_max": q.scale_max,
            "choices": q.choices,
        })

    messages, assembled = build_pooled_prompt(backstory, resolved_context, q_dicts, model)
    response, tin, tout = await call_llm_messages(messages, model=model, provider=provider, temperature=0.7)
    return response, tin, tout, assembled


class _RunCancelled(Exception):
    pass


async def _run_dedicated_interview(
    backstory: str,
    traits: dict[str, Any],
    config: dict[str, Any],
    model: str,
    model_pass2: str,
    provider: str = "openai",
    provider_pass2: str = "openai",
    run_id: str | None = None,
    db: AsyncSession | None = None,
    injected_vars: dict[str, str] | None = None,
) -> tuple[str, int, int, list[float], bool, str]:
    """
    Run a multi-turn dedicated interview with drift detection.
    Returns (transcript, tokens_in, tokens_out, drift_scores, drift_flagged, assembled_prompt).
    injected_vars pre-seeds resolution caches for consistency with stored task values.
    """
    exp = config["experiment"]
    exp_vars = config["exp_vars"]
    dist_vars = config.get("dist_vars", [])
    synonym_sets = config["synonym_sets"]
    questions = config["questions"]

    resolved_cache: dict[str, str] = dict(injected_vars) if injected_vars else {}
    dist_cache: dict[str, str] = dict(injected_vars) if injected_vars else {}
    resolved_context = resolve_variables(exp.global_context, exp_vars, resolved_cache)

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

    total_in = total_out = 0
    drift_scores: list[float] = []
    drift_flagged = False

    backstory_part = f"{backstory}\n\n" if backstory else ""
    system_content = (
        f"{backstory_part}{resolved_context}\n\n"
        "You are in a research interview. Answer each question naturally and conversationally. "
        "Wait for each question before responding."
    )
    conversation: list[dict[str, str]] = [{"role": "system", "content": system_content}]
    assembled_parts = [f"[SYSTEM]\n{system_content}"]

    for idx, q in enumerate(q_dicts):
        # Cancel check between turns
        if run_id and db:
            run_check = await db.get(SimulationRun, run_id)
            if run_check and run_check.status == "cancelled":
                raise _RunCancelled()

        # Drift checkpoint injection
        if should_inject_checkpoint(idx):
            checkpoint_q = get_checkpoint_prompt()
            conversation.append({"role": "user", "content": checkpoint_q})
            cp_response, cp_in, cp_out = await call_llm_messages(
                conversation, model=model, provider=provider, temperature=0.7
            )
            total_in += cp_in
            total_out += cp_out
            conversation.append({"role": "assistant", "content": cp_response})

            # Score adherence (uses pass2 model/provider)
            score, _ = await score_adherence(cp_response, traits, backstory, model_pass2, provider_pass2)
            drift_scores.append(score)

            if score < DRIFT_SCORE_THRESHOLD:
                drift_flagged = True
                refresh_msg = build_grounding_refresh(traits)
                conversation.append(refresh_msg)
                assembled_parts.append(f"[GROUNDING REFRESH — hidden from transcript]")

        # Actual question
        q_text = q["text"]
        if q.get("ask_why"):
            q_text += "\nPlease think through your reasoning before answering."

        conversation.append({"role": "user", "content": q_text})
        assembled_parts.append(f"\n[Q{q['sort_order']}] {q_text}")

        response, tin, tout = await call_llm_messages(
            conversation, model=model, provider=provider, temperature=0.7
        )
        total_in += tin
        total_out += tout
        conversation.append({"role": "assistant", "content": response})
        assembled_parts.append(f"[A{q['sort_order']}] {response}")

    transcript = "\n".join(assembled_parts)
    assembled_prompt = assembled_parts[0]  # system message
    return transcript, total_in, total_out, drift_scores, drift_flagged, assembled_prompt


async def _execute_task(
    task_id: str,
    run_config: dict[str, Any],
    db: AsyncSession,
) -> None:
    """
    Full execution of a single simulation task (Pass 1 + Pass 2).
    Updates the task record in-place.
    """
    task = await db.get(SimulationTask, task_id)
    if not task:
        return

    # Decide what needs to run:
    #   pass2_only = Pass 1 already completed, only Pass 2 needs (re-)running
    #   Otherwise, Pass 1 must be pending/failed to proceed
    pass2_only = (
        task.pass1_status == "completed"
        and task.pass2_status in ("pending", "failed")
    )
    if not pass2_only and task.pass1_status not in ("pending", "failed"):
        return  # nothing to do (completed, running, cancelled, etc.)

    run = await db.get(SimulationRun, task.run_id)
    if not run or run.status == "cancelled":
        return

    persona = await db.get(Persona, task.persona_id)
    if not persona:
        task.pass1_status = "failed"
        task.pass1_error = "Persona not found"
        await db.commit()
        return

    model_pass1 = run_config.get("model_pass1", settings.model_pass1)
    model_pass2 = run_config.get("model_pass2", settings.model_pass2)
    provider_pass1 = run_config.get("provider_pass1", settings.provider_pass1)
    provider_pass2 = run_config.get("provider_pass2", settings.provider_pass2)
    dual_extraction = run_config.get("dual_extraction", True)
    execution_mode = run_config.get("execution_mode", "pooled")
    exp_config = run_config.get("exp_config", {})

    traits = persona.traits_json
    backstory = persona.backstory or ""

    # ── Pass 1 ────────────────────────────────────────────────────────────────
    if not pass2_only:
        task.pass1_status = "running"
        await db.commit()

        try:
            stored_vars = task.injected_vars or {}
            if execution_mode == "dedicated":
                transcript, tin, tout, drift_scores, drift_flagged, assembled = await _run_dedicated_interview(
                    backstory, traits, exp_config, model_pass1, model_pass2,
                    provider=provider_pass1, provider_pass2=provider_pass2,
                    run_id=task.run_id, db=db,
                    injected_vars=stored_vars,
                )
                task.drift_scores = drift_scores
                task.drift_flagged = drift_flagged
            else:
                transcript, tin, tout, assembled = await _run_pooled_interview(
                    backstory, traits, exp_config, model_pass1, provider=provider_pass1,
                    injected_vars=stored_vars,
                )

            task.raw_transcript = transcript
            task.pass1_prompt = assembled
            task.pass1_tokens_in = tin
            task.pass1_tokens_out = tout
            task.pass1_cost_usd = get_price(model_pass1, tin, tout)
            task.pass1_status = "completed"
            await db.commit()

        except _RunCancelled:
            task.pass1_status = "cancelled"
            await db.commit()
            return

        except Exception as e:
            task.pass1_status = "failed"
            task.pass1_error = str(e)
            await db.commit()
            logger.error(f"Task {task_id} Pass 1 failed: {e}")
            run.failed_tasks = (run.failed_tasks or 0) + 1
            await db.commit()
            return

    # ── Cancellation check between passes ────────────────────────────────────
    await db.refresh(run)
    if run.status == "cancelled":
        task.pass2_status = "cancelled"
        await db.commit()
        return

    # ── Pass 2 ────────────────────────────────────────────────────────────────
    output_schema = run_config.get("output_schema", [])
    if not output_schema:
        task.pass2_status = "completed"
        task.extracted_json = {}
        await db.commit()
        return

    task.pass2_status = "running"
    await db.commit()

    try:
        result = await extract_with_confidence(
            transcript=task.raw_transcript,
            output_schema=output_schema,
            model=model_pass2,
            provider=provider_pass2,
            dual=dual_extraction,
        )
        task.extracted_json = result["extracted_json"]
        task.extraction_confidence = result["extraction_confidence"]
        task.extraction_disagreements = result["extraction_disagreements"]
        task.pass2_tokens_in = result["pass2_tokens_in"]
        task.pass2_tokens_out = result["pass2_tokens_out"]
        task.pass2_cost_usd = result["pass2_cost_usd"]
        task.pass2_status = "completed"

    except Exception as e:
        task.pass2_status = "failed"
        task.pass2_error = str(e)
        logger.error(f"Task {task_id} Pass 2 failed: {e}")
        run.failed_tasks = (run.failed_tasks or 0) + 1
        await db.commit()
        return

    # ── Update run progress ───────────────────────────────────────────────────
    await db.refresh(run)
    if run.status == "cancelled":
        # Don't overwrite cancelled status
        await db.commit()
        return

    run.completed_tasks = (run.completed_tasks or 0) + 1
    run.total_cost_usd = (run.total_cost_usd or 0.0) + (task.pass1_cost_usd or 0.0) + (task.pass2_cost_usd or 0.0)

    all_done = run.completed_tasks + run.failed_tasks >= run.total_tasks
    if all_done:
        run.status = "completed" if run.failed_tasks == 0 else "failed"
        run.completed_at = datetime.now(timezone.utc)

    await db.commit()


async def launch_run(
    run_id: str,
    db_factory: Any,
) -> None:
    """Background task entry point. Runs all tasks in the simulation run."""
    from ..database import AsyncSessionLocal
    try:
        async with AsyncSessionLocal() as db:
            run = await db.get(SimulationRun, run_id)
            if not run:
                logger.warning(f"launch_run: run {run_id} not found")
                return

            run.status = "running"
            await db.commit()

            # Load tasks
            tasks_result = await db.execute(
                select(SimulationTask).where(SimulationTask.run_id == run_id)
            )
            tasks = tasks_result.scalars().all()

            # ── Generate any missing backstories before execution ─────────────
            # Personas created via fresh-sample during launch have backstory=None.
            # Generate them here in the background so the HTTP response was instant.
            persona_ids_needed = list({t.persona_id for t in tasks})
            personas_result = await db.execute(
                select(Persona).where(Persona.id.in_(persona_ids_needed))
            )
            personas_map = {p.id: p for p in personas_result.scalars().all()}
            missing = [p for p in personas_map.values() if not p.backstory]
            if missing:
                logger.info(f"launch_run: generating backstories for {len(missing)} personas")
                for p in missing:
                    try:
                        p.backstory = await generate_backstory(
                            p.traits_json,
                            settings.effective_backstory_model,
                            provider=settings.effective_backstory_provider,
                        )
                    except Exception as be:
                        logger.warning(f"Backstory generation failed for persona {p.id}: {be}")
                        p.backstory = _build_default_backstory(p.traits_json)  # trait profile fallback
                await db.commit()

            # Reconstruct run config from locked_config
            locked = run.locked_config
            exp_config = await _load_experiment_config(run.experiment_id, db)

        # Build full run_config — providers read from live settings so retries
        # pick up any provider changes the user made since the run was created.
        run_config = {
            "model_pass1": run.model_pass1,
            "model_pass2": run.model_pass2,
            "provider_pass1": settings.provider_pass1,
            "provider_pass2": settings.provider_pass2,
            "dual_extraction": locked.get("dual_extraction", True),
            "execution_mode": locked.get("execution_mode", "pooled"),
            "output_schema": locked.get("output_schema", []),
            "exp_config": exp_config,
            "est_tokens_per_task": locked.get("est_tokens_per_task", 2000),
        }

        pending_tasks = [t for t in tasks if t.pass1_status in ("pending", "failed")]
        logger.info(
            f"launch_run: run={run_id} model_pass1={run.model_pass1} "
            f"total_tasks={len(tasks)} pending={len(pending_tasks)}"
        )

        executor = RateLimitedExecutor()
        await executor.execute_batch(tasks, run_config, db_factory=AsyncSessionLocal)
    except Exception as e:
        logger.error(f"launch_run: unexpected error for run {run_id}: {e}", exc_info=True)


async def retry_failed_tasks(run_id: str) -> None:
    """
    Smart retry: Pass 1 failures → full retry. Pass 2 failures → extraction only.
    Always uses the current settings model names so provider changes take effect.
    """
    from ..database import AsyncSessionLocal
    try:
        async with AsyncSessionLocal() as db:
            run = await db.get(SimulationRun, run_id)
            if not run:
                logger.warning(f"retry_failed_tasks: run {run_id} not found")
                return

            tasks_result = await db.execute(
                select(SimulationTask)
                .where(SimulationTask.run_id == run_id)
                .where(
                    (SimulationTask.pass1_status == "failed") |
                    (SimulationTask.pass2_status == "failed")
                )
            )
            tasks = tasks_result.scalars().all()
            logger.info(f"retry_failed_tasks: found {len(tasks)} failed task(s) for run {run_id}")

            for task in tasks:
                if task.pass1_status == "failed":
                    task.pass1_status = "pending"
                    task.pass2_status = "pending"
                    task.raw_transcript = None
                    task.extracted_json = None
                    task.pass1_error = None
                elif task.pass2_status == "failed" and task.pass1_status == "completed":
                    task.pass2_status = "pending"
                    task.extracted_json = None
                    task.pass2_error = None

            run.status = "running"
            run.failed_tasks = 0
            # Use current settings models so retries hit the currently configured provider
            run.model_pass1 = settings.model_pass1
            run.model_pass2 = settings.model_pass2
            logger.info(f"retry_failed_tasks: using models pass1={run.model_pass1}, pass2={run.model_pass2}")
            await db.commit()

        await launch_run(run_id, db_factory=AsyncSessionLocal)
    except Exception as e:
        logger.error(f"retry_failed_tasks: unexpected error for run {run_id}: {e}", exc_info=True)


async def re_extract_run(run_id: str, schema_version: int | None = None) -> None:
    """Re-run Pass 2 only for all completed Pass 1 tasks, using the latest (or specified) schema."""
    from ..database import AsyncSessionLocal
    async with AsyncSessionLocal() as db:
        run = await db.get(SimulationRun, run_id)
        if not run:
            return

        # Find schema
        q = select(OutputSchema).where(OutputSchema.experiment_id == run.experiment_id)
        if schema_version:
            q = q.where(OutputSchema.version == schema_version)
        else:
            q = q.order_by(OutputSchema.version.desc())
        schema_result = await db.execute(q)
        schema = schema_result.scalars().first()
        if not schema:
            return

        tasks_result = await db.execute(
            select(SimulationTask)
            .where(SimulationTask.run_id == run_id)
            .where(SimulationTask.pass1_status == "completed")
        )
        tasks = tasks_result.scalars().all()

        for task in tasks:
            task.pass2_status = "pending"
            task.extracted_json = None
            task.pass2_error = None

        await db.commit()

    run_config = {
        "model_pass1": settings.model_pass1,
        "model_pass2": settings.model_pass2,
        "dual_extraction": True,
        "execution_mode": "pooled",
        "output_schema": schema.schema_json,
        "exp_config": {},
        "est_tokens_per_task": 1000,
    }

    executor = RateLimitedExecutor()
    async with AsyncSessionLocal() as db:
        tasks_result = await db.execute(
            select(SimulationTask)
            .where(SimulationTask.run_id == run_id)
            .where(SimulationTask.pass2_status == "pending")
        )
        pending_tasks = tasks_result.scalars().all()

    await executor.execute_batch(pending_tasks, run_config, db_factory=AsyncSessionLocal)
