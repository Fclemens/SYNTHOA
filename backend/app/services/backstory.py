"""
Algorithm 3: Meta-Prompting   Traits -> Backstory
Generates the system prompt used during Pass 1 interviews.
"""
from __future__ import annotations
import logging
import re
from pathlib import Path
from typing import Any

from .llm_client import call_llm

logger = logging.getLogger(__name__)

# ── Prompt template loading ──────────────────────────────────────────────────

_PROMPTS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "prompts"


def _load_template(filename: str) -> str:
    """Load a prompt template file. Falls back to a built-in default if missing."""
    path = _PROMPTS_DIR / filename
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        logger.warning(f"Prompt template not found: {path}. Using built-in default.")
        return ""


# ── Formatting helpers ────────────────────────────────────────────────────────

def _fmt_value(val: Any) -> str:
    """Format a trait value for display."""
    if isinstance(val, float):
        if abs(val) >= 1000:
            return f"{val:,.0f}"
        if 0.0 <= val <= 1.0:
            return f"{val:.2f}"
        return f"{val:.2f}".rstrip("0").rstrip(".")
    if isinstance(val, int) and abs(val) >= 1000:
        return f"{val:,d}"
    return str(val)


def _build_variables_list(traits: dict[str, Any]) -> str:
    """Build a bullet list from all traits present in the persona."""
    lines = []
    for key, value in traits.items():
        label = key.replace("_", " ").title()
        lines.append(f"- {label}: {_fmt_value(value)}")
    return "\n".join(lines)


# ── Profile builder ───────────────────────────────────────────────────────────

def _build_default_backstory(traits: dict[str, Any]) -> str:
    """
    Build a fully generic profile from whatever variables are present.
    Loads the template from prompts/backstory_profile.txt.
    No assumptions about specific variable names.
    """
    if not traits:
        return (
            "You are a synthetic research participant. Respond authentically "
            "and do NOT mention that you are an AI."
        )

    variables_list = _build_variables_list(traits)
    template = _load_template("backstory_profile.txt")

    if template and "{variables_list}" in template:
        return template.replace("{variables_list}", variables_list).strip()

    # Fallback if template file is missing or malformed
    return (
        "You are a synthetic research participant. Your task is to respond "
        "authentically based on the following profile. Do NOT break character. "
        "Do NOT mention that you are an AI. Answer as this person would, "
        "including realistic hesitations, preferences, and reasoning patterns.\n\n"
        f"PROFILE:\n{variables_list}"
    )


def _render_custom_template(template: str, traits: dict[str, Any]) -> str:
    """Substitute {variable_name} placeholders with actual trait values."""
    def replacer(m: re.Match) -> str:
        key = m.group(1).strip()
        if key in traits:
            return _fmt_value(traits[key])
        return m.group(0)
    return re.sub(r"\{(\w+)\}", replacer, template)


# ── Main entry point ──────────────────────────────────────────────────────────

async def generate_backstory(
    traits: dict[str, Any],
    model: str,
    provider: str = "openai",
    custom_template: str | None = None,
) -> str:
    """
    Generate a backstory system prompt from persona traits.
    If custom_template is set, uses it with variable substitution.
    Otherwise builds a generic profile from all present traits.
    """
    if custom_template and custom_template.strip():
        backstory_base = _render_custom_template(custom_template, traits)
    else:
        backstory_base = _build_default_backstory(traits)

    elaboration_template = _load_template("backstory_elaboration.txt")
    if elaboration_template and "{profile}" in elaboration_template:
        generation_prompt = elaboration_template.replace("{profile}", backstory_base).strip()
    else:
        generation_prompt = (
            "Based on the persona description below, write a concise but rich first-person "
            "system prompt (150-250 words) which this person would use to anchor their responses "
            "in a research interview. Preserve all factual details. Output ONLY the system prompt text.\n\n"
            f"{backstory_base}"
        )

    try:
        text, _, _ = await call_llm(
            generation_prompt, model=model, provider=provider, temperature=0.5, max_tokens=400
        )
        return text.strip()
    except Exception as e:
        logger.warning(f"Backstory generation failed, using template fallback: {e}")
        return backstory_base


def generate_backstory_preview(traits: dict[str, Any], max_chars: int = 200) -> str:
    """Quick preview without LLM call."""
    parts = [
        f"{k.replace('_', ' ').title()}: {_fmt_value(v)}"
        for k, v in list(traits.items())[:5]
    ]
    return ", ".join(parts)[:max_chars]
