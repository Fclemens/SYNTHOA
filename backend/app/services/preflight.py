"""
Module 3: Pre-Flight Validation & Economics
Generates sample payloads WITHOUT executing LLM calls.
Uses the existing audience persona panel — does NOT resample.
"""
from __future__ import annotations
import logging
import random
from collections import Counter, defaultdict
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models.experiment import Experiment, ExperimentDistVariable, ExperimentVariable, OutputSchema, Question
from ..models.audience import Audience, Persona
from ..schemas.experiment import (
    CostEstimate, PersonaPayload, PreflightReport,
    ResolvedQuestion, TokenEstimate,
)
from .prompt_assembly import build_pooled_prompt, build_dedicated_messages, estimate_message_tokens
from .variable_resolution import resolve_dist_variables, resolve_variables

logger = logging.getLogger(__name__)


def calculate_cost(
    token_est: TokenEstimate,
    model_pass1: str,
    model_pass2: str,
    dual_extraction: bool,
    population_size: int,
) -> CostEstimate:
    pricing_table = settings.model_pricing
    default_price = pricing_table.get("default") or {"input": 0.0, "output": 0.0}
    p1 = pricing_table.get(model_pass1) or default_price
    p2 = pricing_table.get(model_pass2) or default_price

    pass1_cost = (
        (token_est.pass1_input_tokens * p1["input"] / 1_000_000)
        + (token_est.pass1_output_tokens * p1["output"] / 1_000_000)
    ) * population_size

    extraction_multiplier = 2 if dual_extraction else 1
    pass2_cost = (
        (token_est.pass2_input_tokens * p2["input"] / 1_000_000)
        + (token_est.pass2_output_tokens * p2["output"] / 1_000_000)
    ) * population_size * extraction_multiplier

    grand = pass1_cost + pass2_cost
    return CostEstimate(
        pass1_total=round(pass1_cost, 4),
        pass2_total=round(pass2_cost, 4),
        grand_total=round(grand, 4),
        per_persona=round(grand / max(population_size, 1), 6),
    )


async def run_preflight(
    experiment_id: str,
    sample_size: int,
    model_pass1: str,
    model_pass2: str,
    dual_extraction: bool,
    db: AsyncSession,
) -> PreflightReport:
    # Load experiment
    exp = await db.get(Experiment, experiment_id)
    if not exp:
        raise ValueError(f"Experiment {experiment_id} not found")

    # Load related entities
    vars_result = await db.execute(
        select(ExperimentVariable).where(ExperimentVariable.experiment_id == experiment_id)
    )
    exp_vars = vars_result.scalars().all()

    dist_vars_result = await db.execute(
        select(ExperimentDistVariable).where(ExperimentDistVariable.experiment_id == experiment_id)
    )
    dist_vars = dist_vars_result.scalars().all()

    q_result = await db.execute(
        select(Question).where(Question.experiment_id == experiment_id).order_by(Question.sort_order)
    )
    questions = q_result.scalars().all()

    # Load existing persona panel — preflight uses the already-sampled audience, no re-sampling
    personas_result = await db.execute(
        select(Persona).where(Persona.audience_id == exp.audience_id)
    )
    all_personas = personas_result.scalars().all()

    if not all_personas:
        raise ValueError(
            "No personas found in this audience. "
            "Run the audience sampling job first before running preflight."
        )

    if sample_size > len(all_personas):
        raise ValueError(
            f"Population size ({sample_size}) exceeds the audience panel size ({len(all_personas)}). "
            f"Reduce population size or sample more personas in the audience first."
        )

    selected_personas = random.sample(list(all_personas), sample_size)
    # Build raw trait dicts (no plausibility re-check — personas were already validated at sampling time)
    raw_personas = [{"_persona_id": p.id, **p.traits_json} for p in selected_personas]

    # Resolve variables + build payloads
    payloads: list[PersonaPayload] = []
    variable_distribution_tracker: dict[str, Counter] = defaultdict(Counter)

    # Build a lookup for stored backstories
    backstory_by_id = {p.id: p.backstory for p in selected_personas}

    for persona_traits in raw_personas:
        persona_id = persona_traits.get("_persona_id")
        resolved_cache: dict[str, str] = {}
        dist_cache: dict[str, str] = {}
        ctx = resolve_variables(exp.global_context, exp_vars, resolved_cache)

        resolved_qs: list[ResolvedQuestion] = []
        for q in questions:
            q_text = resolve_variables(q.question_text, exp_vars, resolved_cache)
            q_text = resolve_dist_variables(q_text, dist_vars, dist_cache)
            resolved_qs.append(ResolvedQuestion(text=q_text, type=q.question_type, ask_why=q.ask_why))

        for var_name, var_value in resolved_cache.items():
            variable_distribution_tracker[var_name][var_value] += 1
        for var_name, var_value in dist_cache.items():
            variable_distribution_tracker[var_name][var_value] += 1

        stored_backstory = backstory_by_id.get(persona_id) or ""

        payloads.append(PersonaPayload(
            persona_traits={k: v for k, v in persona_traits.items() if not k.startswith("_")},
            backstory_preview=stored_backstory,
            resolved_variables=resolved_cache,
            questions=resolved_qs,
        ))

    # Token estimation — use one sample payload
    if payloads:
        sample_q_dicts = [
            {
                "sort_order": i + 1,
                "text": rq.text,
                "type": rq.type,
                "ask_why": rq.ask_why,
                "scale_min": None,
                "scale_max": None,
                "choices": None,
            }
            for i, rq in enumerate(payloads[0].questions)
        ]
        if exp.execution_mode == "dedicated":
            # Dedicated: sum input tokens across all turns (context grows each turn)
            turn_snapshots = build_dedicated_messages(
                backstory="[backstory placeholder]",
                global_context=exp.global_context,
                questions=sample_q_dicts,
                model=model_pass1,
            )
            pass1_in = sum(estimate_message_tokens(snap, model_pass1) for snap in turn_snapshots)
            pass1_out = max(200, len(payloads[0].questions) * 120)  # dedicated answers tend to be longer
        else:
            sample_msgs, _ = build_pooled_prompt(
                backstory="[backstory placeholder]",
                global_context=exp.global_context,
                questions=sample_q_dicts,
                model=model_pass1,
            )
            pass1_in = estimate_message_tokens(sample_msgs, model_pass1)
            pass1_out = max(200, len(payloads[0].questions) * 80)  # rough estimate per answer

        # Pass 2 input = transcript (pass1_out) + schema overhead
        schema_result = await db.execute(
            select(OutputSchema)
            .where(OutputSchema.experiment_id == experiment_id)
            .order_by(OutputSchema.version.desc())
        )
        schema = schema_result.scalars().first()
        schema_overhead = len(schema.schema_json) * 30 if schema else 50
        pass2_in = pass1_out + schema_overhead + 200
        pass2_out = len(schema.schema_json) * 20 if schema else 50
    else:
        pass1_in = pass1_out = pass2_in = pass2_out = 0

    token_est = TokenEstimate(
        pass1_input_tokens=pass1_in,
        pass1_output_tokens=pass1_out,
        pass2_input_tokens=pass2_in,
        pass2_output_tokens=pass2_out,
    )

    cost_est = calculate_cost(token_est, model_pass1, model_pass2, dual_extraction, sample_size)

    return PreflightReport(
        payloads=payloads,
        variable_distributions={k: dict(v) for k, v in variable_distribution_tracker.items()},
        token_estimate=token_est,
        cost_estimate=cost_est,
        sample_size=sample_size,
    )
