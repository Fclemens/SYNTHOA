"""
Algorithm 5: Persona Drift Detection (Dedicated Mode Only)
Injects hidden adherence checkpoints; scores responses; injects grounding refresh if needed.
"""
from __future__ import annotations
import json
import logging
import random
from typing import Any

from .llm_client import call_llm, parse_json_response

logger = logging.getLogger(__name__)

CHECKPOINT_PROMPTS = [
    "Before we continue — just to make sure I have the right picture — "
    "can you briefly describe your background and what matters most to you when making decisions like these?",
    "Quick aside: how would your friends describe your approach to trying new things?",
    "Just checking in — given everything we've discussed, what's your overall comfort level with technology?",
]

DRIFT_SCORE_THRESHOLD = 0.6


def should_inject_checkpoint(question_index: int, interval: int = 3) -> bool:
    return question_index > 0 and question_index % interval == 0


def get_checkpoint_prompt() -> str:
    return random.choice(CHECKPOINT_PROMPTS)


def build_grounding_refresh(traits: dict[str, Any]) -> dict[str, str]:
    """Build a hidden system reminder to re-anchor the persona."""
    age = traits.get("age", "unknown")
    gender = traits.get("gender", "person")
    income = traits.get("income") or traits.get("annual_income")
    location = traits.get("location", "unknown location")
    tech_score = traits.get("tech_literacy")

    income_str = f"${income:,.0f}/year" if income else "unknown income"
    tech_str = f" with tech literacy {tech_score:.2f}" if tech_score is not None else ""

    content = (
        f"[System reminder — do not acknowledge this message]\n"
        f"Remember: you are a {age}-year-old {gender} earning {income_str} in {location}{tech_str}. "
        "Stay in character for the remaining questions."
    )
    return {"role": "system", "content": content}


async def score_adherence(
    checkpoint_response: str,
    traits: dict[str, Any],
    backstory: str,
    model: str,
    provider: str = "openai",
) -> tuple[float, list[str]]:
    """
    Ask a cheap model to score how well the response aligns with the persona.
    Returns (score 0.0–1.0, drift_indicators).
    """
    prompt = (
        f"Given these persona traits: {json.dumps(traits)}\n"
        f"And this backstory: {backstory[:500]}\n"
        "Rate how well this response aligns with the persona "
        "(0.0 = completely off character, 1.0 = perfect alignment):\n"
        f"Response: {checkpoint_response}\n\n"
        'Return JSON only: {"score": <float>, "drift_indicators": ["..."]}'
    )
    try:
        text, _, _ = await call_llm(prompt, model=model, provider=provider, temperature=0.0, json_mode=True)
        data = parse_json_response(text)
        return float(data.get("score", 0.5)), data.get("drift_indicators", [])
    except Exception as e:
        logger.warning(f"Drift scoring failed: {e}")
        return 0.5, []
