"""
The single interview engine: resolves an experiment's variables and runs a
pooled or dedicated interview. Used by simulation runs, the single-persona
preview, and pre-flight estimates, so all three send identical prompts.
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.experiment import Experiment, ExperimentDistVariable, OutputSchema, Question
from .drift_detection import (
    DRIFT_SCORE_THRESHOLD,
    build_grounding_refresh,
    get_checkpoint_prompt,
    score_adherence,
    should_inject_checkpoint,
)
from .llm_client import call_llm_messages
from .prompt_assembly import build_pooled_prompt, dedicated_system_prompt, format_question, truncate_if_needed
from .variable_resolution import resolve_dist_variables

logger = logging.getLogger(__name__)

INTERVIEW_TEMPERATURE = 0.7


class InterviewCancelled(Exception):
    pass


@dataclass
class ExperimentConfig:
    experiment: Experiment
    dist_vars: list[ExperimentDistVariable]
    questions: list[Question]
    output_schema: list[dict[str, Any]]


@dataclass
class InterviewResult:
    transcript: str
    assembled_prompt: str
    tokens_in: int = 0
    tokens_out: int = 0
    drift_scores: list[float] = field(default_factory=list)
    drift_flagged: bool = False


async def load_experiment_config(experiment_id: str, db: AsyncSession) -> ExperimentConfig:
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise ValueError(f"Experiment {experiment_id} not found")
    dist_vars = (await db.execute(
        select(ExperimentDistVariable).where(ExperimentDistVariable.experiment_id == experiment_id)
    )).scalars().all()
    questions = (await db.execute(
        select(Question).where(Question.experiment_id == experiment_id).order_by(Question.sort_order)
    )).scalars().all()
    schema = (await db.execute(
        select(OutputSchema).where(OutputSchema.experiment_id == experiment_id)
        .order_by(OutputSchema.version.desc())
    )).scalars().first()
    return ExperimentConfig(
        experiment=exp,
        dist_vars=list(dist_vars),
        questions=list(questions),
        output_schema=schema.schema_json if schema else [],
    )


def resolve_interview(
    config: ExperimentConfig, injected_vars: Optional[dict[str, str]] = None
) -> tuple[str, list[dict[str, Any]], dict[str, str]]:
    """
    Substitute {variable} tokens in the global context and every question.
    `injected_vars` pins previously sampled values (a task's stored draw); any
    variable not pinned is sampled fresh. Returns (context, questions, values_used).
    """
    cache: dict[str, str] = dict(injected_vars or {})
    context = resolve_dist_variables(config.experiment.global_context, config.dist_vars, cache)
    questions = [
        {
            "sort_order": q.sort_order,
            "text": resolve_dist_variables(q.question_text, config.dist_vars, cache),
            "type": q.question_type,
            "ask_why": q.ask_why,
            "scale_min": q.scale_min,
            "scale_max": q.scale_max,
            "scale_anchor_low": q.scale_anchor_low,
            "scale_anchor_high": q.scale_anchor_high,
            "choices": q.choices,
        }
        for q in config.questions
    ]
    return context, questions, cache


async def run_pooled_interview(
    backstory: str,
    context: str,
    questions: list[dict[str, Any]],
    model: str,
    provider: str,
) -> InterviewResult:
    messages, assembled = build_pooled_prompt(backstory, context, questions, model)
    response, tin, tout = await call_llm_messages(
        messages, model=model, provider=provider, temperature=INTERVIEW_TEMPERATURE
    )
    return InterviewResult(transcript=response, assembled_prompt=assembled, tokens_in=tin, tokens_out=tout)


async def run_dedicated_interview(
    backstory: str,
    traits: dict[str, Any],
    context: str,
    questions: list[dict[str, Any]],
    model: str,
    provider: str,
    *,
    drift_detection: bool = False,
    scorer_model: Optional[str] = None,
    scorer_provider: Optional[str] = None,
    is_cancelled: Optional[Callable[[], Awaitable[bool]]] = None,
) -> InterviewResult:
    """Multi-turn interview, one question per turn, with optional drift checkpoints."""
    system_content = dedicated_system_prompt(backstory, context)
    conversation: list[dict[str, str]] = [{"role": "system", "content": system_content}]
    parts = [f"[SYSTEM]\n{system_content}"]
    result = InterviewResult(transcript="", assembled_prompt=parts[0])

    async def ask(messages: list[dict[str, str]]) -> str:
        text, tin, tout = await call_llm_messages(
            truncate_if_needed(messages, model), model=model, provider=provider,
            temperature=INTERVIEW_TEMPERATURE,
        )
        result.tokens_in += tin
        result.tokens_out += tout
        return text

    for idx, q in enumerate(questions):
        if is_cancelled and await is_cancelled():
            raise InterviewCancelled()

        if drift_detection and should_inject_checkpoint(idx):
            conversation.append({"role": "user", "content": get_checkpoint_prompt()})
            cp_response = await ask(conversation)
            conversation.append({"role": "assistant", "content": cp_response})
            score, _ = await score_adherence(
                cp_response, traits, backstory, scorer_model or model, scorer_provider or provider
            )
            result.drift_scores.append(score)
            if score < DRIFT_SCORE_THRESHOLD:
                result.drift_flagged = True
                conversation.append(build_grounding_refresh(traits))
                parts.append("[GROUNDING REFRESH — hidden from transcript]")

        q_text = format_question(q, pooled=False)
        conversation.append({"role": "user", "content": q_text})
        parts.append(f"\n[Q{q['sort_order']}] {q_text}")
        response = await ask(conversation)
        conversation.append({"role": "assistant", "content": response})
        parts.append(f"[A{q['sort_order']}] {response}")

    result.transcript = "\n".join(parts)
    return result


async def run_interview(
    mode: str,
    backstory: str,
    traits: dict[str, Any],
    context: str,
    questions: list[dict[str, Any]],
    model: str,
    provider: str,
    **dedicated_kwargs: Any,
) -> InterviewResult:
    if mode == "dedicated":
        return await run_dedicated_interview(
            backstory, traits, context, questions, model, provider, **dedicated_kwargs
        )
    return await run_pooled_interview(backstory, context, questions, model, provider)
