"""
LLM client abstraction.

Supports three provider backends (selected per-call via the `provider` parameter):
  "openai"    — OpenAI API direct (uses openai_api_key, standard base URL)
  "lmstudio"  — LM Studio / Ollama / vLLM (uses openai_api_key + lmstudio_base_url)
  "anthropic" — Anthropic Claude API native (uses anthropic_api_key)

Public surface:
  call_llm(prompt, model, provider, …)            → (text, tokens_in, tokens_out)
  call_llm_messages(messages, model, provider, …) → (text, tokens_in, tokens_out)
  get_price(model, tokens_in, tokens_out)         → float
  parse_json_response(text)                       → dict
"""
from __future__ import annotations
import asyncio
import json
import logging
import re
import time
from collections import deque
from typing import Any, Optional

from ..config import settings

logger = logging.getLogger(__name__)


# ── Global rate limiter ────────────────────────────────────────────────────────
# Applied inside call_llm_messages so EVERY LLM call — simulation tasks,
# backstory generation, preview interviews, drift scoring, extraction — is
# automatically subject to max_concurrent_tasks and tpm_limit.

class _GlobalLimiter:
    """
    Enforces two constraints read live from settings on every LLM call:
      • max_concurrent_tasks  — max parallel in-flight API calls
      • tpm_limit             — tokens per minute (sliding 60-second window)

    Uses a single asyncio.Lock for the critical section plus a counter
    (instead of a Semaphore) so that the limit is always read from current
    settings without needing to recreate the primitive.
    """

    def __init__(self) -> None:
        self._lock: asyncio.Lock | None = None
        self._active: int = 0
        self._tpm_log: deque[tuple[float, int, int]] = deque()  # (timestamp, tokens, slot_id)

    @property
    def _l(self) -> asyncio.Lock:
        # Lazily created so the event loop is already running
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def acquire(self, estimated_tokens: int) -> int:
        """
        Block until both the concurrency slot and TPM budget are available.
        Returns a slot_id that must be passed to release() with the actual
        token count so the TPM window stays accurate.
        """
        while True:
            async with self._l:
                now = time.monotonic()
                # Evict token-log entries older than 60 s
                while self._tpm_log and self._tpm_log[0][0] < now - 60.0:
                    self._tpm_log.popleft()
                used_tpm = sum(t for _, t, _ in self._tpm_log)
                max_conc = settings.max_concurrent_tasks
                tpm_cap  = settings.tpm_limit
                if self._active < max_conc and used_tpm + estimated_tokens <= tpm_cap:
                    self._active += 1
                    slot_id = id(object())          # unique key for this slot
                    self._tpm_log.append((now, estimated_tokens, slot_id))
                    return slot_id
            await asyncio.sleep(0.25)

    async def release(self, slot_id: int, actual_tokens: int) -> None:
        """Decrement active counter and correct the TPM entry with real token count."""
        async with self._l:
            self._active = max(0, self._active - 1)
            # Replace the estimate with the real usage so future TPM checks are accurate
            for i, entry in enumerate(self._tpm_log):
                if entry[2] == slot_id:
                    self._tpm_log[i] = (entry[0], actual_tokens, slot_id)
                    break


_limiter = _GlobalLimiter()


# ── Error helpers ─────────────────────────────────────────────────────────────

def _is_context_error(e: Exception) -> bool:
    msg = str(e).lower()
    return any(kw in msg for kw in (
        "context", "context_length", "maximum context", "too long", "context size",
        "prompt is too long", "input is too long",
    ))


def _is_structured_format_error(e: Exception) -> bool:
    msg = str(e).lower()
    return any(kw in msg for kw in (
        "response_format", "json_object", "json_schema", "structured",
        "tool_choice", "tools",
    ))


_is_json_mode_error = _is_structured_format_error   # backwards-compat alias


def _truncate_messages(
    messages: list[dict[str, Any]], ratio: float = 0.6
) -> list[dict[str, Any]]:
    """Truncate the longest message by `ratio` to recover from context-exceeded errors."""
    if not messages:
        return messages
    longest_idx = max(range(len(messages)), key=lambda i: len(str(messages[i].get("content", ""))))
    msg = messages[longest_idx]
    content = msg.get("content", "")
    if not isinstance(content, str):
        content = str(content)
    cut = int(len(content) * ratio)
    truncated = list(messages)
    truncated[longest_idx] = {
        **msg,
        "content": content[:cut] + "\n[...truncated: context window exceeded...]",
    }
    logger.warning(
        f"Context window exceeded — truncated message[{longest_idx}] "
        f"from {len(content)} to {cut} chars"
    )
    return truncated


# ── Pricing ───────────────────────────────────────────────────────────────────

def get_price(model: str, tokens_in: int, tokens_out: int) -> float:
    """Calculate cost using per-model pricing from settings ($ per 1M tokens)."""
    pricing_table = settings.model_pricing
    pricing = pricing_table.get(model) or pricing_table.get("default") or {"input": 0.0, "output": 0.0}
    return (tokens_in * pricing["input"] + tokens_out * pricing["output"]) / 1_000_000


# ── OpenAI-compatible backend (openai + lmstudio) ────────────────────────────

def _get_openai_client(provider: str):
    from openai import AsyncOpenAI
    kwargs: dict[str, Any] = {"api_key": settings.openai_api_key}
    if provider == "lmstudio":
        kwargs["base_url"] = settings.lmstudio_base_url
    # "openai" → no base_url override, goes to api.openai.com
    return AsyncOpenAI(**kwargs)


async def _call_openai(
    messages: list[dict[str, Any]],
    model: str,
    temperature: float,
    max_tokens: int,
    json_mode: bool,
    json_schema: Optional[dict],
    provider: str,
) -> tuple[str, int, int]:
    from openai import BadRequestError

    client = _get_openai_client(provider)
    current_messages = list(messages)

    if json_schema is not None:
        current_format: Optional[str] = "json_schema"
    elif json_mode:
        current_format = "json_object"
    else:
        current_format = None

    for attempt in range(3):
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": current_messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if current_format == "json_schema" and json_schema is not None:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "structured_output",
                    "schema": json_schema,
                    "strict": True,
                },
            }
        elif current_format == "json_object":
            kwargs["response_format"] = {"type": "json_object"}

        try:
            response = await client.chat.completions.create(**kwargs)
            text = response.choices[0].message.content or ""
            tokens_in = response.usage.prompt_tokens if response.usage else 0
            tokens_out = response.usage.completion_tokens if response.usage else 0
            return text, tokens_in, tokens_out

        except Exception as e:
            is_bad = isinstance(e, BadRequestError)
            if is_bad and _is_context_error(e) and attempt < 2:
                current_messages = _truncate_messages(current_messages, ratio=0.6)
            elif is_bad and _is_structured_format_error(e) and current_format is not None:
                if current_format == "json_schema":
                    logger.warning(f"[{provider}] Model '{model}' rejected json_schema — falling back to json_object")
                    current_format = "json_object"
                else:
                    logger.warning(f"[{provider}] Model '{model}' rejected json_object — falling back to prompt-only")
                    current_format = None
            else:
                raise

    raise RuntimeError(f"_call_openai ({provider}): exceeded retry limit")


# ── Anthropic backend ─────────────────────────────────────────────────────────

def _get_anthropic_client():
    import anthropic
    return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)


async def _call_anthropic(
    messages: list[dict[str, Any]],
    model: str,
    temperature: float,
    max_tokens: int,
    json_mode: bool,
    json_schema: Optional[dict],
) -> tuple[str, int, int]:
    import anthropic

    client = _get_anthropic_client()
    current_messages = list(messages)

    def _split(msgs: list[dict[str, Any]]):
        sys_parts = [m["content"] for m in msgs if m["role"] == "system"]
        convo = [m for m in msgs if m["role"] != "system"]
        sys_text: Any = "\n\n".join(sys_parts) if sys_parts else anthropic.NOT_GIVEN
        return sys_text, convo

    system_text, convo = _split(current_messages)
    use_tool = json_schema is not None

    for attempt in range(3):
        try:
            if use_tool:
                response = await client.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    system=system_text,
                    messages=convo,
                    tools=[{
                        "name": "structured_output",
                        "description": "Return the response as structured JSON matching the schema.",
                        "input_schema": json_schema,
                    }],
                    tool_choice={"type": "tool", "name": "structured_output"},
                )
                text = ""
                for block in response.content:
                    if block.type == "tool_use":
                        text = json.dumps(block.input)
                        break
                if not text:
                    text = "".join(b.text for b in response.content if hasattr(b, "text"))
            else:
                response = await client.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    system=system_text,
                    messages=convo,
                )
                text = "".join(b.text for b in response.content if hasattr(b, "text"))

            tokens_in = response.usage.input_tokens
            tokens_out = response.usage.output_tokens
            return text, tokens_in, tokens_out

        except Exception as e:
            is_api_err = hasattr(e, "status_code")
            if is_api_err and _is_context_error(e) and attempt < 2:
                current_messages = _truncate_messages(current_messages, ratio=0.6)
                system_text, convo = _split(current_messages)
            elif is_api_err and _is_structured_format_error(e) and use_tool:
                logger.warning(f"[anthropic] Model '{model}' rejected tool-use — falling back to prompt-only")
                use_tool = False
            else:
                raise

    raise RuntimeError("_call_anthropic: exceeded retry limit")


# ── Public interface ──────────────────────────────────────────────────────────

async def call_llm(
    prompt: str,
    model: str,
    provider: str = "openai",
    temperature: float = 0.7,
    system: Optional[str] = None,
    max_tokens: int = 4096,
    json_mode: bool = False,
    json_schema: Optional[dict] = None,
) -> tuple[str, int, int]:
    """Single-turn convenience wrapper around call_llm_messages."""
    messages: list[dict[str, Any]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return await call_llm_messages(
        messages, model=model, provider=provider, temperature=temperature,
        max_tokens=max_tokens, json_mode=json_mode, json_schema=json_schema,
    )


async def call_llm_messages(
    messages: list[dict[str, Any]],
    model: str,
    provider: str = "openai",
    temperature: float = 0.7,
    max_tokens: int = 4096,
    json_mode: bool = False,
    json_schema: Optional[dict] = None,
) -> tuple[str, int, int]:
    """
    Route to the correct provider backend.
    provider: "openai" | "lmstudio" | "anthropic"
    Returns (response_text, tokens_in, tokens_out).

    Every call passes through _limiter which enforces settings.max_concurrent_tasks
    (parallel calls) and settings.tpm_limit (tokens per minute).
    """
    # Estimate input tokens to gate admission; actual usage corrects the log on release.
    est_tokens = max(100, sum(len(str(m.get("content", ""))) // 4 for m in messages) + 500)
    slot_id = await _limiter.acquire(est_tokens)
    actual_in = actual_out = 0
    try:
        if provider == "anthropic":
            text, actual_in, actual_out = await _call_anthropic(
                messages, model=model, temperature=temperature,
                max_tokens=max_tokens, json_mode=json_mode, json_schema=json_schema,
            )
        else:
            # "openai" or "lmstudio" — both go through OpenAI client
            text, actual_in, actual_out = await _call_openai(
                messages, model=model, temperature=temperature,
                max_tokens=max_tokens, json_mode=json_mode, json_schema=json_schema,
                provider=provider,
            )
        return text, actual_in, actual_out
    finally:
        await _limiter.release(slot_id, actual_in + actual_out)


# ── JSON parsing ──────────────────────────────────────────────────────────────

def _strip_json_comments(text: str) -> str:
    return re.sub(r'(?<!:)//[^\n]*', '', text)


def parse_json_response(text: str) -> dict[str, Any]:
    """Parse JSON from LLM response, handling markdown fences and // comments."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]) if len(lines) > 2 else text
        text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    cleaned = _strip_json_comments(text)
    return json.loads(cleaned)
