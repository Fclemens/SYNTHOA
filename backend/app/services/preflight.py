"""
Module 3: Pre-Flight Validation & Economics
Generates sample payloads WITHOUT executing LLM calls.
Uses the existing audience persona panel — does NOT resample.
"""
from __future__ import annotations
import logging
import random
from collections import Counter, defaultdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models.audience import Persona
from ..schemas.experiment import (
    CostEstimate, PersonaPayload, PreflightReport,
    ResolvedQuestion, TokenEstimate,
)
from .interview import load_experiment_config, resolve_interview
from .prompt_assembly import build_pooled_prompt, estimate_dedicated_tokens, estimate_message_tokens

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
    config = await load_experiment_config(experiment_id, db)
    exp = config.experiment

    all_personas = (await db.execute(
        select(Persona).where(Persona.audience_id == exp.audience_id, Persona.archived.is_(False))
    )).scalars().all()
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

    payloads: list[PersonaPayload] = []
    variable_distribution_tracker: dict[str, Counter] = defaultdict(Counter)
    first_resolved = None
    for persona in random.sample(list(all_personas), sample_size):
        context, questions, values = resolve_interview(config)
        first_resolved = first_resolved or (context, questions)
        for var_name, var_value in values.items():
            variable_distribution_tracker[var_name][var_value] += 1
        payloads.append(PersonaPayload(
            persona_traits=persona.traits_json,
            backstory_preview=persona.backstory or "",
            resolved_variables=values,
            questions=[ResolvedQuestion(text=q["text"], type=q["type"], ask_why=q["ask_why"]) for q in questions],
        ))

    # Token estimation from one fully formatted sample payload
    context, questions = first_resolved
    backstory = all_personas[0].backstory or "[backstory placeholder]"
    if exp.execution_mode == "dedicated":
        pass1_in = estimate_dedicated_tokens(backstory, context, questions, model_pass1)
        pass1_out = max(200, len(questions) * 120)  # dedicated answers tend to be longer
    else:
        sample_msgs, _ = build_pooled_prompt(backstory, context, questions, model_pass1)
        pass1_in = estimate_message_tokens(sample_msgs, model_pass1)
        pass1_out = max(200, len(questions) * 80)

    # Pass 2 input = transcript (pass1_out) + schema overhead
    n_fields = len(config.output_schema)
    pass2_in = pass1_out + (n_fields * 30 if n_fields else 50) + 200
    pass2_out = n_fields * 20 if n_fields else 50

    token_est = TokenEstimate(
        pass1_input_tokens=pass1_in,
        pass1_output_tokens=pass1_out,
        pass2_input_tokens=pass2_in,
        pass2_output_tokens=pass2_out,
    )
    return PreflightReport(
        payloads=payloads,
        variable_distributions={k: dict(v) for k, v in variable_distribution_tracker.items()},
        token_estimate=token_est,
        cost_estimate=calculate_cost(token_est, model_pass1, model_pass2, dual_extraction, sample_size),
        sample_size=sample_size,
    )
