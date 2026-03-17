"""
Module 2: Prompt Assembly
Builds the final LLM payloads for pooled and dedicated interview modes.
Includes token estimation with truncation guard.
"""
from __future__ import annotations
import logging
from typing import Any

import tiktoken

from ..config import settings

logger = logging.getLogger(__name__)


def _get_encoder(model: str) -> tiktoken.Encoding:
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError:
        return tiktoken.get_encoding("cl100k_base")


def estimate_message_tokens(messages: list[dict[str, str]], model: str) -> int:
    enc = _get_encoder(model)
    total = 0
    for msg in messages:
        total += 4  # per-message overhead
        total += len(enc.encode(msg.get("content", "")))
    total += 2  # reply primer
    return total


def _truncate_if_needed(messages: list[dict[str, str]], model: str) -> list[dict[str, str]]:
    """If token count exceeds MAX_CONTEXT_TOKENS, trim the first system message."""
    total = estimate_message_tokens(messages, model)
    if total <= settings.max_context_tokens:
        return messages

    logger.warning(
        f"Prompt exceeds {settings.max_context_tokens} tokens ({total}). "
        "Truncating backstory/context."
    )
    enc = _get_encoder(model)
    budget = settings.max_context_tokens - total  # negative = how much to cut

    # Truncate the system/first message
    if messages and messages[0]["role"] in ("system", "user"):
        tokens = enc.encode(messages[0]["content"])
        keep = max(100, len(tokens) + budget)
        messages[0] = {
            **messages[0],
            "content": enc.decode(tokens[:keep]) + "\n[...truncated for context window...]",
        }
    return messages


def build_pooled_prompt(
    backstory: str,
    global_context: str,
    questions: list[dict[str, Any]],  # resolved question dicts: {text, type, ask_why, scale_min, scale_max, choices}
    model: str = "gpt-4o",
) -> tuple[list[dict[str, str]], str]:
    """
    Build a single-turn pooled prompt.
    Returns (messages, assembled_text_for_audit).
    """
    q_lines = []
    for q in questions:
        line = f"Q{q['sort_order']}: {q['text']}"
        if q["type"] == "scale":
            line += f"\n  (Answer on a scale of {q.get('scale_min', 1)} to {q.get('scale_max', 10)})"
        elif q["type"] == "multiple_choice" and q.get("choices"):
            line += f"\n  Options: {', '.join(q['choices'])}"
        if q.get("ask_why"):
            line += "\n  IMPORTANT: Before giving your answer, explain your reasoning step by step."
        q_lines.append(line)

    format_example = "\n".join(
        f"Q{q['sort_order']}_REASONING: <your reasoning if asked>\n"
        f"Q{q['sort_order']}_ANSWER: <your answer>\n"
        f"Q{q['sort_order']}_MOTIVATION: <brief explanation>"
        for q in questions
    )

    user_content = (
        f"{global_context}\n\n"
        "---\n"
        "Please answer the following questions in order. For each question, provide:\n"
        "1. Your honest answer\n"
        "2. A brief motivation (1-2 sentences explaining why)\n\n"
        + "\n\n".join(q_lines)
        + f"\n\nRespond in this exact format for each question:\n{format_example}"
    )

    messages = []
    if backstory:
        messages.append({"role": "system", "content": backstory})
    messages.append({"role": "user", "content": user_content})
    messages = _truncate_if_needed(messages, model)
    system_part = messages[0]["content"] if messages[0]["role"] == "system" else ""
    user_part = messages[-1]["content"]
    assembled = f"[SYSTEM]\n{system_part}\n\n[USER]\n{user_part}" if system_part else f"[USER]\n{user_part}"
    return messages, assembled


def build_dedicated_messages(
    backstory: str,
    global_context: str,
    questions: list[dict[str, Any]],
    model: str = "gpt-4o",
) -> list[list[dict[str, str]]]:
    """
    Build the per-turn message lists for dedicated (interview) mode.
    Returns a list of message snapshots — one per question turn.
    Each snapshot is the full messages array to send for that turn.
    The caller appends the assistant response between turns.
    """
    backstory_part = f"{backstory}\n\n" if backstory else ""
    system_content = (
        f"{backstory_part}"
        f"{global_context}\n\n"
        "You are in a research interview. Answer each question naturally and conversationally. "
        "Wait for each question before responding."
    )
    system_msg = {"role": "system", "content": system_content}

    turn_snapshots = []
    history: list[dict[str, str]] = [system_msg]

    for q in questions:
        q_text = q["text"]
        if q.get("ask_why"):
            q_text += "\nPlease think through your reasoning before answering."

        history = history + [{"role": "user", "content": q_text}]
        snapshot = _truncate_if_needed(list(history), model)
        turn_snapshots.append(snapshot)
        # Caller will append assistant response here — we return snapshots only
        history = history + [{"role": "assistant", "content": "__PENDING__"}]

    return turn_snapshots
