"""
Provider Batch APIs (OpenAI Batch, Anthropic Message Batches): half price,
results within 24h. Each adapter submits a list of (custom_id, request body)
built by llm_client's request builders and returns parsed LLMResults, so a
batched call is priced and parsed exactly like a live one.
"""
from __future__ import annotations
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Union

from .llm_client import (
    LLMResult, _get_anthropic_client, _get_openai_client, anthropic_result, openai_result,
)

logger = logging.getLogger(__name__)

BATCH_PROVIDERS = ("openai", "anthropic")
MAX_REQUESTS_PER_BATCH = 5000   # well under both providers' request and file-size caps

# A request's outcome: the parsed result, or an error message.
Outcome = Union[LLMResult, str]


@dataclass
class BatchStatus:
    ended: bool
    total: int = 0
    done: int = 0
    failed: int = 0
    error: str | None = None   # the whole batch was rejected (e.g. invalid input file)


@dataclass
class OpenAIBatches:
    endpoint: str = "/v1/chat/completions"
    _client: Any = field(default=None, repr=False)

    @property
    def client(self) -> Any:
        return self._client or _get_openai_client("openai")

    async def submit(self, requests: list[tuple[str, dict[str, Any]]]) -> str:
        lines = "\n".join(
            json.dumps({"custom_id": cid, "method": "POST", "url": self.endpoint, "body": body})
            for cid, body in requests
        )
        upload = await self.client.files.create(file=("synthoa-batch.jsonl", lines.encode()), purpose="batch")
        batch = await self.client.batches.create(
            input_file_id=upload.id, endpoint=self.endpoint, completion_window="24h",
        )
        return batch.id

    async def status(self, batch_id: str) -> BatchStatus:
        b = await self.client.batches.retrieve(batch_id)
        counts = b.request_counts
        error = None
        if b.status == "failed":
            errors = getattr(b.errors, "data", None) or []
            error = "; ".join(e.message for e in errors if getattr(e, "message", None)) or "Batch rejected"
        return BatchStatus(
            ended=b.status in ("completed", "failed", "expired", "cancelled"),
            total=getattr(counts, "total", 0) or 0,
            done=getattr(counts, "completed", 0) or 0,
            failed=getattr(counts, "failed", 0) or 0,
            error=error,
        )

    async def results(self, batch_id: str) -> dict[str, Outcome]:
        b = await self.client.batches.retrieve(batch_id)
        out: dict[str, Outcome] = {}
        for file_id in (b.output_file_id, b.error_file_id):
            if not file_id:
                continue
            content = await self.client.files.content(file_id)
            for line in content.text.splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                response, error = row.get("response") or {}, row.get("error")
                if error or response.get("status_code", 200) >= 400:
                    body_error = (response.get("body") or {}).get("error") or {}
                    out[row["custom_id"]] = (error or body_error).get("message") or "Request failed"
                else:
                    out[row["custom_id"]] = openai_result(response.get("body") or {}, batch=True)
        return out

    async def cancel(self, batch_id: str) -> None:
        await self.client.batches.cancel(batch_id)


@dataclass
class AnthropicBatches:
    _client: Any = field(default=None, repr=False)

    @property
    def client(self) -> Any:
        return self._client or _get_anthropic_client()

    async def submit(self, requests: list[tuple[str, dict[str, Any]]]) -> str:
        batch = await self.client.messages.batches.create(
            requests=[{"custom_id": cid, "params": body} for cid, body in requests]
        )
        return batch.id

    async def status(self, batch_id: str) -> BatchStatus:
        b = await self.client.messages.batches.retrieve(batch_id)
        c = b.request_counts
        failed = (c.errored or 0) + (c.canceled or 0) + (c.expired or 0)
        return BatchStatus(
            ended=b.processing_status == "ended",
            total=(c.processing or 0) + (c.succeeded or 0) + failed,
            done=c.succeeded or 0,
            failed=failed,
        )

    async def results(self, batch_id: str) -> dict[str, Outcome]:
        out: dict[str, Outcome] = {}
        async for entry in await self.client.messages.batches.results(batch_id):
            result = entry.result
            if result.type == "succeeded":
                try:
                    out[entry.custom_id] = anthropic_result(result.message, batch=True)
                except RuntimeError as e:   # refusal
                    out[entry.custom_id] = str(e)
            elif result.type == "errored":
                err = getattr(result.error, "error", None)
                out[entry.custom_id] = getattr(err, "message", None) or "Request failed"
            else:
                out[entry.custom_id] = f"Request {result.type}"
        return out

    async def cancel(self, batch_id: str) -> None:
        await self.client.messages.batches.cancel(batch_id)


def get_backend(provider: str) -> Any:
    if provider == "openai":
        return OpenAIBatches()
    if provider == "anthropic":
        return AnthropicBatches()
    raise ValueError(f"Provider '{provider}' has no batch API")
