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

    Waiters block on a Condition and are woken on every release; a short
    timeout also re-checks as old TPM entries age out of the window.
    """

    def __init__(self) -> None:
        self._cond: asyncio.Condition | None = None
        self._active: int = 0
        self._tpm_log: deque[list] = deque()  # [timestamp, tokens]

    @property
    def _c(self) -> asyncio.Condition:
        # Lazily created so the event loop is already running
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    def _has_capacity(self, estimated_tokens: int) -> bool:
        now = time.monotonic()
        while self._tpm_log and self._tpm_log[0][0] < now - 60.0:
            self._tpm_log.popleft()
        used_tpm = sum(t for _, t in self._tpm_log)
        return (
            self._active < settings.max_concurrent_tasks
            and used_tpm + estimated_tokens <= settings.tpm_limit
        )

    async def acquire(self, estimated_tokens: int) -> list:
        """Block until a concurrency slot and TPM budget are free; returns the log entry."""
        async with self._c:
            while not self._has_capacity(estimated_tokens):
                try:
                    await asyncio.wait_for(self._c.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
            self._active += 1
            entry = [time.monotonic(), estimated_tokens]
            self._tpm_log.append(entry)
            return entry

    async def release(self, entry: list, actual_tokens: int) -> None:
        """Free the slot and replace the estimate with real usage."""
        async with self._c:
            self._active = max(0, self._active - 1)
            entry[1] = actual_tokens
            self._c.notify_all()


_limiter = _GlobalLimiter()


# ── Error helpers ─────────────────────────────────────────────────────────────

def _is_context_error(e: Exception) -> bool:
    msg = str(e).lower()
    return any(kw in msg for kw in (
        "context_length", "maximum context", "too long", "context size",
        "prompt is too long", "input is too long", "context window",
    ))


def _is_structured_format_error(e: Exception) -> bool:
    msg = str(e).lower()
    return any(kw in msg for kw in (
        "response_format", "json_object", "json_schema", "output_config", "structured",
    ))


# Request parameters some models reject (e.g. GPT-5.x rejects temperature unless
# reasoning is off; older models reject reasoning_effort). When the API names one
# of these in a 400, we drop it for that model for the rest of the process.
_OPTIONAL_PARAMS = ("temperature", "reasoning_effort", "effort")
_unsupported: dict[tuple[str, str], set[str]] = {}


def _rejected_param(e: Exception) -> Optional[str]:
    msg = str(e).lower()
    if "unsupported" not in msg and "not supported" not in msg and "extra inputs" not in msg \
            and "unrecognized" not in msg and "unknown" not in msg and "invalid" not in msg:
        return None
    for param in _OPTIONAL_PARAMS:
        if f"'{param}'" in msg or f'"{param}"' in msg or f"{param}:" in msg or f".{param}" in msg:
            return param
    return None


def _truncate_messages(
    messages: list[dict[str, Any]], ratio: float = 0.6
) -> list[dict[str, Any]]:
    """Truncate the longest message by `ratio` to recover from context-exceeded errors."""
    if not messages:
        return messages
    longest_idx = max(range(len(messages)), key=lambda i: len(str(messages[i].get("content", ""))))
    msg = messages[longest_idx]
    content = str(msg.get("content", ""))
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


# ── Clients (cached; rebuilt when keys / base URL change in Settings) ─────────

_clients: dict[tuple, Any] = {}


def _get_openai_client(provider: str):
    from openai import AsyncOpenAI
    base_url = settings.lmstudio_base_url if provider == "lmstudio" else None
    key = ("openai", provider, settings.openai_api_key, base_url)
    if key not in _clients:
        _clients[key] = AsyncOpenAI(api_key=settings.openai_api_key, base_url=base_url)
    return _clients[key]


def _get_anthropic_client():
    import anthropic
    key = ("anthropic", settings.anthropic_api_key)
    if key not in _clients:
        _clients[key] = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    return _clients[key]


# ── OpenAI-compatible backend (openai + lmstudio) ────────────────────────────

def _is_openai_reasoning_model(model: str) -> bool:
    return model.startswith(("gpt-5", "o1", "o3", "o4"))


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
    dropped = _unsupported.setdefault((provider, model), set())
    reasoning = provider == "openai" and _is_openai_reasoning_model(model)

    if json_schema is not None:
        current_format: Optional[str] = "json_schema"
    elif json_mode:
        current_format = "json_object"
    else:
        current_format = None

    for _attempt in range(5):
        kwargs: dict[str, Any] = {"model": model, "messages": current_messages}
        if provider == "openai":
            # Reasoning tokens count against the completion budget; leave headroom
            # so short outputs (backstories, scores) are not cut to nothing.
            kwargs["max_completion_tokens"] = max(max_tokens, 8000) if reasoning else max_tokens
        else:
            kwargs["max_tokens"] = max_tokens
        if reasoning and "reasoning_effort" not in dropped:
            # Survey answers need sampling diversity; GPT-5.x only honours
            # temperature with reasoning switched off.
            kwargs["reasoning_effort"] = "none"
        if "temperature" not in dropped:
            kwargs["temperature"] = temperature
        if current_format == "json_schema" and json_schema is not None:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "structured_output", "schema": json_schema, "strict": True},
            }
        elif current_format == "json_object":
            kwargs["response_format"] = {"type": "json_object"}

        try:
            response = await client.chat.completions.create(**kwargs)
            text = response.choices[0].message.content or ""
            tokens_in = response.usage.prompt_tokens if response.usage else 0
            tokens_out = response.usage.completion_tokens if response.usage else 0
            return text, tokens_in, tokens_out

        except BadRequestError as e:
            param = _rejected_param(e)
            if param and param in kwargs and param not in dropped:
                logger.warning(f"[{provider}] Model '{model}' rejected '{param}' — retrying without it")
                dropped.add(param)
            elif _is_context_error(e):
                current_messages = _truncate_messages(current_messages, ratio=0.6)
            elif _is_structured_format_error(e) and current_format is not None:
                current_format = "json_object" if current_format == "json_schema" else None
                logger.warning(f"[{provider}] Model '{model}' rejected structured output — falling back to {current_format or 'prompt-only'}")
            else:
                raise

    raise RuntimeError(f"_call_openai ({provider}): exceeded retry limit")


# ── Anthropic backend ─────────────────────────────────────────────────────────

async def _call_anthropic(
    messages: list[dict[str, Any]],
    model: str,
    max_tokens: int,
    json_schema: Optional[dict],
) -> tuple[str, int, int]:
    """
    Current Claude models fix their own sampling (no temperature) and think
    adaptively, so `max_tokens` gets generous headroom; structured output uses
    output_config.format rather than forced tool use (which newer models reject).
    """
    import anthropic

    client = _get_anthropic_client()
    current_messages = list(messages)
    dropped = _unsupported.setdefault(("anthropic", model), set())

    def _split(msgs: list[dict[str, Any]]):
        sys_parts = [m["content"] for m in msgs if m["role"] == "system"]
        convo = [m for m in msgs if m["role"] != "system"]
        return ("\n\n".join(sys_parts) if sys_parts else anthropic.NOT_GIVEN), convo

    use_schema = json_schema is not None

    for _attempt in range(5):
        system_text, convo = _split(current_messages)
        output_config: dict[str, Any] = {}
        if "effort" not in dropped:
            output_config["effort"] = "low"   # simple, high-volume tasks
        if use_schema:
            output_config["format"] = {"type": "json_schema", "schema": json_schema}
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=max(max_tokens, 16000),
                system=system_text,
                messages=convo,
                **({"output_config": output_config} if output_config else {}),
            )
            if response.stop_reason == "refusal":
                raise RuntimeError(f"Model '{model}' declined the request")
            text = "".join(b.text for b in response.content if b.type == "text")
            return text, response.usage.input_tokens, response.usage.output_tokens

        except anthropic.BadRequestError as e:
            param = _rejected_param(e)
            if param == "effort" and "effort" not in dropped:
                logger.warning(f"[anthropic] Model '{model}' rejected effort — retrying without it")
                dropped.add("effort")
            elif _is_context_error(e):
                current_messages = _truncate_messages(current_messages, ratio=0.6)
            elif use_schema and _is_structured_format_error(e):
                logger.warning(f"[anthropic] Model '{model}' rejected structured output — falling back to prompt-only")
                use_schema = False
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

    `temperature` is honoured where the model supports it (OpenAI-compatible
    providers); current Claude models use fixed sampling and ignore it.
    """
    # Estimate input tokens to gate admission; actual usage corrects the log on release.
    est_tokens = max(100, sum(len(str(m.get("content", ""))) // 4 for m in messages) + 500)
    entry = await _limiter.acquire(est_tokens)
    actual_in = actual_out = 0
    try:
        if provider == "anthropic":
            text, actual_in, actual_out = await _call_anthropic(
                messages, model=model, max_tokens=max_tokens, json_schema=json_schema,
            )
        else:
            text, actual_in, actual_out = await _call_openai(
                messages, model=model, temperature=temperature,
                max_tokens=max_tokens, json_mode=json_mode, json_schema=json_schema,
                provider=provider,
            )
        return text, actual_in, actual_out
    finally:
        await _limiter.release(entry, actual_in + actual_out)


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
    return json.loads(_strip_json_comments(text))
