"""
Algorithm 2: Plausibility Validation
Rule-based + optional LLM-assisted validation.
"""
from __future__ import annotations
import json
import logging
from typing import Any, Callable

from .llm_client import call_llm, parse_json_response

logger = logging.getLogger(__name__)

# ── Built-in hard rules ────────────────────────────────────────────────────────

HARD_RULES: list[tuple[Callable[[dict], bool], str]] = [
    (
        lambda p: p.get("age", 999) < 22 and p.get("income", 0) > 150_000,
        "Under-22 with income > $150k is implausible unless specified",
    ),
    (
        lambda p: p.get("age", 0) > 70 and p.get("tech_literacy", 0) > 0.9,
        "Over-70 with top-decile tech literacy is rare",
    ),
    (
        lambda p: p.get("age", 999) < 16,
        "Age below 16 is outside typical research demographic",
    ),
    (
        lambda p: p.get("income", 0) < 0,
        "Negative income is impossible",
    ),
]


def validate_persona(
    traits: dict[str, Any],
    custom_rules: list[tuple[Callable[[dict], bool], str]] | None = None,
) -> tuple[float, list[str]]:
    """
    Returns (plausibility_score 0.0–1.0, list_of_flag_descriptions).
    Score = 1.0 - (penalties / total_rules_checked).
    """
    all_rules = HARD_RULES + (custom_rules or [])
    flags: list[str] = []
    for condition, desc in all_rules:
        try:
            if condition(traits):
                flags.append(desc)
        except Exception:
            pass
    score = 1.0 - (len(flags) / max(len(all_rules), 1))
    return score, flags


async def validate_persona_llm(traits: dict[str, Any], model: str) -> tuple[float, list[str]]:
    """
    Optional LLM-assisted plausibility check. Returns (score, concerns).
    """
    prompt = (
        "You are a demographic plausibility checker. Given the following persona traits, "
        "rate from 0.0 to 1.0 how plausible this combination is for a real person. "
        'Respond with JSON only: {"score": <float>, "concerns": ["...", ...]}.\n\n'
        f"Traits: {json.dumps(traits)}"
    )
    try:
        text, _, _ = await call_llm(prompt, model=model, temperature=0.0, json_mode=True)
        data = parse_json_response(text)
        return float(data.get("score", 0.5)), data.get("concerns", [])
    except Exception as e:
        logger.warning(f"LLM plausibility validation failed: {e}")
        return 0.5, []
