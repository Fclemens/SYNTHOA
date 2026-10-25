"""
Module 2: Prompt Assembly
Builds the final LLM payloads for pooled and dedicated interview modes.
Includes token estimation with truncation guard.
"""
from __future__ import annotations
import functools
import logging
from typing import Any, Optional

import tiktoken

from ..config import settings

logger = logging.getLogger(__name__)

POOLED_INSTRUCTION = "Answer the survey above as the person described, in the exact format requested."

DEDICATED_INSTRUCTIONS = (
    "You are in a research interview. Answer each question naturally and conversationally. "
    "Wait for each question before responding."
)


@functools.lru_cache(maxsize=None)
def _get_encoder(model: str) -> Optional[tiktoken.Encoding]:
    """
    tiktoken downloads encodings on first use; offline installs (or blocked
    networks) fall back to a ~4 chars/token heuristic instead of failing calls.
    """
    try:
        try:
            return tiktoken.encoding_for_model(model)
        except KeyError:
            return tiktoken.get_encoding("o200k_base")
    except Exception as e:
        logger.warning(f"tiktoken unavailable ({e.__class__.__name__}); estimating tokens from length")
        return None


def _count(text: str, model: str) -> int:
    enc = _get_encoder(model)
    return len(enc.encode(text)) if enc else len(text) // 4 + 1


def estimate_message_tokens(messages: list[dict[str, str]], model: str) -> int:
    total = 0
    for msg in messages:
        total += 4  # per-message overhead
        total += _count(msg.get("content", ""), model)
    total += 2  # reply primer
    return total


def truncate_if_needed(messages: list[dict[str, Any]], model: str) -> list[dict[str, Any]]:
    """
    If token count exceeds max_context_tokens, trim the persona's backstory
    (the first message not marked as a shared, cached prefix).
    """
    total = estimate_message_tokens(messages, model)
    if total <= settings.max_context_tokens:
        return messages

    logger.warning(
        f"Prompt exceeds {settings.max_context_tokens} tokens ({total}). "
        "Truncating backstory/context."
    )
    enc = _get_encoder(model)
    budget = settings.max_context_tokens - total  # negative = how much to cut
    messages = list(messages)
    idx = next((i for i, m in enumerate(messages) if not m.get("cache")), 0)
    content = messages[idx]["content"]
    if enc:
        tokens = enc.encode(content)
        content = enc.decode(tokens[:max(100, len(tokens) + budget)])
    else:
        content = content[:max(400, len(content) + budget * 4)]
    messages[idx] = {**messages[idx], "content": content + "\n[...truncated for context window...]"}
    return messages


def format_question(q: dict[str, Any], *, pooled: bool) -> str:
    """
    Render one resolved question with its answer format (scale range + anchors,
    choices, reasoning request). Shared by pooled and dedicated modes so both
    tell the respondent exactly the same thing.
    """
    indent = "  " if pooled else ""
    lines = [f"Q{q['sort_order']}: {q['text']}" if pooled else q["text"]]

    if q["type"] == "scale":
        lo = q.get("scale_min") if q.get("scale_min") is not None else 1
        hi = q.get("scale_max") if q.get("scale_max") is not None else 10
        anchors = []
        if q.get("scale_anchor_low"):
            anchors.append(f'{lo} = "{q["scale_anchor_low"]}"')
        if q.get("scale_anchor_high"):
            anchors.append(f'{hi} = "{q["scale_anchor_high"]}"')
        where = f", where {' and '.join(anchors)}" if anchors else ""
        lines.append(f"{indent}(Answer on a scale of {lo} to {hi}{where})")
    elif q["type"] == "single_choice" and q.get("choices"):
        lines.append(f"{indent}Select ONE option: {', '.join(q['choices'])}")
    elif q["type"] == "multiple_choice" and q.get("choices"):
        lines.append(f"{indent}Options (select all that apply): {', '.join(q['choices'])}")

    if q.get("ask_why"):
        lines.append(
            f"{indent}IMPORTANT: Before giving your answer, explain your reasoning step by step."
            if pooled else "Please think through your reasoning before answering."
        )
    return "\n".join(lines)


def build_pooled_prompt(
    backstory: str,
    global_context: str,
    questions: list[dict[str, Any]],
    model: str,
) -> tuple[list[dict[str, str]], str]:
    """
    Build a single-turn pooled prompt.
    Returns (messages, assembled_text_for_audit).
    """
    q_lines = [format_question(q, pooled=True) for q in questions]
    format_example = "\n".join(
        f"Q{q['sort_order']}_REASONING: <your reasoning if asked>\n"
        f"Q{q['sort_order']}_ANSWER: <your answer>\n"
        f"Q{q['sort_order']}_MOTIVATION: <brief explanation>"
        for q in questions
    )
    survey = (
        f"{global_context}\n\n"
        "---\n"
        "Please answer the following questions in order. For each question, provide:\n"
        "1. Your honest answer\n"
        "2. A brief motivation (1-2 sentences explaining why)\n\n"
        + "\n\n".join(q_lines)
        + f"\n\nRespond in this exact format for each question:\n{format_example}"
    )

    # The survey is identical for every persona, so it goes first and is marked
    # as a cacheable prefix; only the backstory differs per request.
    messages: list[dict[str, Any]] = [{"role": "system", "content": survey, "cache": True}]
    if backstory:
        messages.append({"role": "system", "content": f"Your identity for this interview:\n\n{backstory}"})
    messages.append({"role": "user", "content": POOLED_INSTRUCTION})
    messages = truncate_if_needed(messages, model)
    assembled = "\n\n".join(f"[{m['role'].upper()}]\n{m['content']}" for m in messages)
    return messages, assembled


def dedicated_system_messages(backstory: str, global_context: str) -> list[dict[str, Any]]:
    """Shared instructions + context first (cacheable across personas), then the backstory."""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": f"{DEDICATED_INSTRUCTIONS}\n\n{global_context}", "cache": True}
    ]
    if backstory:
        messages.append({"role": "system", "content": f"Your identity for this interview:\n\n{backstory}"})
    return messages


def dedicated_system_prompt(backstory: str, global_context: str) -> str:
    return "\n\n".join(m["content"] for m in dedicated_system_messages(backstory, global_context))


def estimate_dedicated_tokens(
    backstory: str,
    global_context: str,
    questions: list[dict[str, Any]],
    model: str,
    answer_tokens: int = 120,
) -> int:
    """Sum of input tokens across all turns (the conversation grows each turn)."""
    history: list[dict[str, Any]] = dedicated_system_messages(backstory, global_context)
    total = 0
    placeholder_answer = "x " * answer_tokens
    for q in questions:
        history.append({"role": "user", "content": format_question(q, pooled=False)})
        total += estimate_message_tokens(history, model)
        history.append({"role": "assistant", "content": placeholder_answer})
    return total
