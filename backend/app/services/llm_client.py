"""
LLM client abstraction.

Supports three provider backends (selected per-call via the `provider` parameter):
  "openai"    — OpenAI API direct (uses openai_api_key, standard base URL)
  "lmstudio"  — LM Studio / Ollama / vLLM (uses openai_api_key + lmstudio_base_url)
  "anthropic" — Anthropic Claude API native (uses anthropic_api_key)

Public surface:
  call_llm(prompt, model, provider, …)            → LLMResult
  call_llm_messages(messages, model, provider, …) → LLMResult
  get_price(model, tokens_in, tokens_out, …)      → float
  parse_json_response(text)                       → dict

LLMResult unpacks as (text, tokens_in, tokens_out) and also carries cached /
cache-write token counts, so costs reflect prompt-caching discounts.

Prompt caching: a message dict may carry "cache": True to mark the end of a
prefix shared by many requests (the survey block, the extraction schema).
It is stripped before sending; OpenAI caches shared prefixes automatically
(helped by prompt_cache_key), Anthropic gets an explicit cache breakpoint.
"""
from __future__ import annotations
import asyncio
import hashlib
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
_OPTIONAL_PARAMS = ("temperature", "reasoning_effort", "effort", "prompt_cache_key")
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


# ── Results & pricing ─────────────────────────────────────────────────────────

class LLMResult(tuple):
    """(text, tokens_in, tokens_out) plus cache details. tokens_in includes cached tokens."""

    def __new__(cls, text: str, tokens_in: int, tokens_out: int,
                cached_tokens: int = 0, cache_write_tokens: int = 0, batch: bool = False):
        obj = super().__new__(cls, (text, tokens_in, tokens_out))
        obj.cached_tokens = cached_tokens
        obj.cache_write_tokens = cache_write_tokens
        obj.batch = batch
        return obj

    text = property(lambda self: self[0])
    tokens_in = property(lambda self: self[1])
    tokens_out = property(lambda self: self[2])

    def cost(self, model: str) -> float:
        return get_price(model, self.tokens_in, self.tokens_out,
                         self.cached_tokens, self.cache_write_tokens, self.batch)


def get_price(model: str, tokens_in: int, tokens_out: int,
              cached_tokens: int = 0, cache_write_tokens: int = 0, batch: bool = False) -> float:
    """
    Cost in USD from per-model pricing ($ per 1M tokens). Cached input is billed
    at `cached_input` (default 10% of input), cache writes at `cache_write`
    (default 125% of input); batch requests cost half.
    """
    table = settings.model_pricing
    p = table.get(model) or table.get("default") or {"input": 0.0, "output": 0.0}
    cached_price = p.get("cached_input", p["input"] * 0.1)
    write_price = p.get("cache_write", p["input"] * 1.25)
    fresh = max(tokens_in - cached_tokens - cache_write_tokens, 0)
    usd = (fresh * p["input"] + cached_tokens * cached_price
           + cache_write_tokens * write_price + tokens_out * p["output"]) / 1_000_000
    return usd * 0.5 if batch else usd


def result_cost(result: Any, model: str) -> float:
    """Cost of a call result; plain (text, in, out) tuples are priced without cache discounts."""
    if isinstance(result, LLMResult):
        return result.cost(model)
    return get_price(model, result[1], result[2])


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


def _plain(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop our internal "cache" marker before sending."""
    return [{k: v for k, v in m.items() if k != "cache"} for m in messages]


def _cache_key(messages: list[dict[str, Any]]) -> Optional[str]:
    """Stable key for the shared prefix, so OpenAI routes same-prefix requests together."""
    for i, m in enumerate(messages):
        if m.get("cache"):
            prefix = "\n".join(str(x.get("content", "")) for x in messages[: i + 1])
            return "synthoa-" + hashlib.sha256(prefix.encode()).hexdigest()[:24]
    return None


# ── OpenAI-compatible backend (openai + lmstudio) ────────────────────────────

def _is_openai_reasoning_model(model: str) -> bool:
    """Everything after the GPT-4 generation (GPT-5.x, GPT-6.x, o-series) reasons."""
    return not model.startswith(("gpt-4", "gpt-3", "chatgpt-4o"))


def openai_request(
    messages: list[dict[str, Any]], model: str, provider: str, temperature: float,
    max_tokens: int, json_mode: bool = False, json_schema: Optional[dict] = None,
) -> dict[str, Any]:
    """Chat Completions request body, adapted to what this model is known to accept."""
    dropped = _unsupported.setdefault((provider, model), set())
    reasoning = provider == "openai" and _is_openai_reasoning_model(model)
    body: dict[str, Any] = {"model": model, "messages": _plain(messages)}
    if provider == "openai":
        # Reasoning tokens count against the completion budget; leave headroom
        # so short outputs (backstories, scores) are not cut to nothing.
        body["max_completion_tokens"] = max(max_tokens, 8000) if reasoning else max_tokens
        if (key := _cache_key(messages)):
            body["prompt_cache_key"] = key
    else:
        body["max_tokens"] = max_tokens
    if reasoning and "reasoning_effort" not in dropped:
        # Survey answers need sampling diversity; GPT-5.x only honours
        # temperature with reasoning switched off.
        body["reasoning_effort"] = "none"
    if "temperature" not in dropped:
        body["temperature"] = temperature
    fmt = "json_schema" if json_schema is not None else "json_object" if json_mode else None
    if fmt == "json_schema" and "json_schema" in dropped:
        fmt = "json_object"
    if fmt == "json_object" and "json_object" in dropped:
        fmt = None
    if fmt == "json_schema":
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "structured_output", "schema": json_schema, "strict": True},
        }
    elif fmt == "json_object":
        body["response_format"] = {"type": "json_object"}
    return body


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Field access that works on SDK objects and on the plain dicts a batch file holds."""
    if obj is None:
        return default
    value = obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)
    return default if value is None else value


def openai_result(response: Any, batch: bool = False) -> LLMResult:
    """Parse a chat completion (SDK object or the JSON dict a batch returns)."""
    choices = _get(response, "choices", [])
    text = _get(_get(choices[0], "message") if choices else None, "content", "")
    usage = _get(response, "usage")
    details = _get(usage, "prompt_tokens_details")
    return LLMResult(
        text, _get(usage, "prompt_tokens", 0), _get(usage, "completion_tokens", 0),
        cached_tokens=_get(details, "cached_tokens", 0),
        cache_write_tokens=_get(details, "cache_write_tokens", 0),
        batch=batch,
    )


async def _call_openai(
    messages: list[dict[str, Any]], model: str, temperature: float, max_tokens: int,
    json_mode: bool, json_schema: Optional[dict], provider: str,
) -> LLMResult:
    from openai import BadRequestError

    client = _get_openai_client(provider)
    current = list(messages)
    dropped = _unsupported.setdefault((provider, model), set())
    for _attempt in range(6):
        body = openai_request(current, model, provider, temperature, max_tokens, json_mode, json_schema)
        try:
            return openai_result(await client.chat.completions.create(**body))
        except BadRequestError as e:
            param = _rejected_param(e)
            fmt = (body.get("response_format") or {}).get("type")
            if param and param in body and param not in dropped:
                logger.warning(f"[{provider}] Model '{model}' rejected '{param}' — retrying without it")
                dropped.add(param)
            elif _is_context_error(e):
                current = _truncate_messages(current, ratio=0.6)
            elif _is_structured_format_error(e) and fmt:
                logger.warning(f"[{provider}] Model '{model}' rejected {fmt} — falling back")
                dropped.add(fmt)
            elif "prompt_cache_key" in body and "prompt_cache_key" in str(e):
                current = [{k: v for k, v in m.items() if k != "cache"} for m in current]
            else:
                raise
    raise RuntimeError(f"_call_openai ({provider}): exceeded retry limit")


# ── Anthropic backend ─────────────────────────────────────────────────────────
# Current Claude models fix their own sampling (no temperature) and think
# adaptively, so max_tokens gets generous headroom; structured output uses
# output_config.format rather than forced tool use (which newer models reject).

def anthropic_request(
    messages: list[dict[str, Any]], model: str, max_tokens: int, json_schema: Optional[dict] = None,
) -> dict[str, Any]:
    dropped = _unsupported.setdefault(("anthropic", model), set())
    system_msgs = [m for m in messages if m["role"] == "system"]
    convo = _plain([m for m in messages if m["role"] != "system"])
    body: dict[str, Any] = {"model": model, "max_tokens": max(max_tokens, 16000), "messages": convo}
    if system_msgs:
        blocks = []
        for m in system_msgs:
            block: dict[str, Any] = {"type": "text", "text": str(m["content"])}
            if m.get("cache"):
                block["cache_control"] = {"type": "ephemeral"}   # end of the shared prefix
            blocks.append(block)
        body["system"] = blocks
    if len(convo) >= 3:
        # Multi-turn interview: cache the growing conversation between turns.
        body["cache_control"] = {"type": "ephemeral"}
    output_config: dict[str, Any] = {}
    if "effort" not in dropped:
        output_config["effort"] = "low"   # simple, high-volume tasks
    if json_schema is not None and "json_schema" not in dropped:
        output_config["format"] = {"type": "json_schema", "schema": json_schema}
    if output_config:
        body["output_config"] = output_config
    return body


def anthropic_result(message: Any, batch: bool = False) -> LLMResult:
    """Parse a Claude message (SDK object or a batch result's message dict)."""
    if _get(message, "stop_reason") == "refusal":
        raise RuntimeError(f"Model '{_get(message, 'model', '?')}' declined the request")
    text = "".join(_get(b, "text", "") for b in _get(message, "content", []) if _get(b, "type") == "text")
    u = _get(message, "usage")
    cached = _get(u, "cache_read_input_tokens", 0)
    written = _get(u, "cache_creation_input_tokens", 0)
    # Anthropic reports uncached input separately from cache reads/writes.
    return LLMResult(text, _get(u, "input_tokens", 0) + cached + written, _get(u, "output_tokens", 0),
                     cached_tokens=cached, cache_write_tokens=written, batch=batch)


async def _call_anthropic(
    messages: list[dict[str, Any]], model: str, max_tokens: int, json_schema: Optional[dict],
) -> LLMResult:
    import anthropic

    client = _get_anthropic_client()
    current = list(messages)
    dropped = _unsupported.setdefault(("anthropic", model), set())
    for _attempt in range(5):
        body = anthropic_request(current, model, max_tokens, json_schema)
        try:
            return anthropic_result(await client.messages.create(**body))
        except anthropic.BadRequestError as e:
            param = _rejected_param(e)
            if param == "effort" and "effort" not in dropped:
                logger.warning(f"[anthropic] Model '{model}' rejected effort — retrying without it")
                dropped.add("effort")
            elif _is_context_error(e):
                current = _truncate_messages(current, ratio=0.6)
            elif json_schema is not None and "json_schema" not in dropped and _is_structured_format_error(e):
                logger.warning(f"[anthropic] Model '{model}' rejected structured output — falling back to prompt-only")
                dropped.add("json_schema")
            else:
                raise
    raise RuntimeError("_call_anthropic: exceeded retry limit")


def request_body(
    provider: str, messages: list[dict[str, Any]], model: str, temperature: float,
    max_tokens: int = 4096, json_schema: Optional[dict] = None,
) -> dict[str, Any]:
    """The request a live call would send first — used to build Batch API requests."""
    if provider == "anthropic":
        return anthropic_request(messages, model, max_tokens, json_schema)
    return openai_request(messages, model, provider, temperature, max_tokens, json_schema=json_schema)


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
    cache_system: bool = False,
) -> LLMResult:
    """Single-turn convenience wrapper. cache_system marks the system prompt as a shared prefix."""
    messages: list[dict[str, Any]] = []
    if system:
        messages.append({"role": "system", "content": system, **({"cache": True} if cache_system else {})})
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
) -> LLMResult:
    """
    Route to the correct provider backend.
    provider: "openai" | "lmstudio" | "anthropic"

    `temperature` is honoured where the model supports it (OpenAI-compatible
    providers); current Claude models use fixed sampling and ignore it.
    Every call passes the global limiter (max_concurrent_tasks, tpm_limit).
    """
    est_tokens = max(100, sum(len(str(m.get("content", ""))) // 4 for m in messages) + 500)
    entry = await _limiter.acquire(est_tokens)
    result: Optional[LLMResult] = None
    try:
        if provider == "anthropic":
            result = await _call_anthropic(messages, model=model, max_tokens=max_tokens, json_schema=json_schema)
        else:
            result = await _call_openai(
                messages, model=model, temperature=temperature, max_tokens=max_tokens,
                json_mode=json_mode, json_schema=json_schema, provider=provider,
            )
        return result
    finally:
        await _limiter.release(entry, (result.tokens_in + result.tokens_out) if result else 0)


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
