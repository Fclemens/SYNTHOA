"""
Algorithm 6: Dual-Extraction with Confidence Scoring (Pass 2)
Runs extraction twice at different temperatures; flags disagreements.
"""
from __future__ import annotations
import json
import logging
import re
from typing import Any

from .llm_client import call_llm, get_price, parse_json_response

logger = logging.getLogger(__name__)


_FIELD_TYPE_MAP: dict[str, dict] = {
    "string":  {"type": "string"},
    "integer": {"type": "integer"},
    "float":   {"type": "number"},
    "boolean": {"type": "boolean"},
    "scale":   {"type": "integer", "description": "Rating on a 1-10 scale"},
}

_LEGACY_ENUM = re.compile(r"^enum\((.*)\)$")


def normalize_field(field: dict[str, Any]) -> dict[str, Any]:
    """Accept the legacy `type: "enum(a,b)"` spelling alongside `type: "enum", values: [...]`."""
    m = _LEGACY_ENUM.match(str(field.get("type", "")))
    if m:
        values = [v.strip() for v in m.group(1).split(",") if v.strip()]
        return {**field, "type": "enum", "values": values}
    return field


def _build_response_json_schema(output_schema: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Build a JSON Schema for structured output from our output_schema field list.
    Produces: {"data": {field: typed_value, ...}, "confidence": {field: number, ...}}
    Every object lists all its keys as required — OpenAI strict mode rejects it otherwise.
    """
    data_props: dict[str, Any] = {}
    keys: list[str] = []
    for raw in output_schema:
        field = normalize_field(raw)
        key = field.get("key", "")
        if not key:
            continue
        if field.get("type") == "enum" and field.get("values"):
            prop: dict[str, Any] = {"type": "string", "enum": list(field["values"])}
        else:
            prop = dict(_FIELD_TYPE_MAP.get(field.get("type", "string"), {"type": "string"}))
        if field.get("description"):
            prop["description"] = field["description"]
        data_props[key] = prop
        keys.append(key)

    return {
        "type": "object",
        "properties": {
            "data": {
                "type": "object",
                "properties": data_props,
                "required": keys,
                "additionalProperties": False,
            },
            "confidence": {
                "type": "object",
                "properties": {k: {"type": "number"} for k in keys},
                "required": keys,
                "additionalProperties": False,
            },
        },
        "required": ["data", "confidence"],
        "additionalProperties": False,
    }


def _build_extraction_prompt(transcript: str, output_schema: list[dict[str, Any]]) -> str:
    schema_str = json.dumps([normalize_field(f) for f in output_schema], indent=2)
    return (
        "You are a precise data extraction engine. Read the following interview transcript "
        "and extract the requested data points. Return ONLY valid JSON matching this schema.\n\n"
        f"Schema:\n{schema_str}\n\n"
        "For each field, also provide a confidence score (0.0–1.0) indicating how clearly "
        "the transcript supports your extraction.\n\n"
        f"Transcript:\n---\n{transcript}\n---\n\n"
        'Return JSON: {"data": {...}, "confidence": {...}}'
    )


def _parse_result(text: str) -> dict[str, Any] | None:
    try:
        result = parse_json_response(text)
    except Exception:
        return None
    if not isinstance(result, dict) or not isinstance(result.get("data"), dict):
        return None
    if not isinstance(result.get("confidence"), dict):
        result["confidence"] = {}
    return result


def _conf(result: dict[str, Any], key: str) -> float:
    try:
        return float(result["confidence"].get(key, 0.5))
    except (TypeError, ValueError):
        return 0.5


async def extract_with_confidence(
    transcript: str,
    output_schema: list[dict[str, Any]],
    model: str,
    provider: str = "openai",
    dual: bool = True,
) -> dict[str, Any]:
    """
    Run extraction once (dual=False) or twice (dual=True) with different temperatures.
    Raises ValueError when no run returned parseable JSON, so the task is marked
    failed (and retryable) instead of "completed" with empty data.
    """
    prompt = _build_extraction_prompt(transcript, output_schema)
    resp_schema = _build_response_json_schema(output_schema)

    temperatures = [0.0, 0.3] if dual else [0.0]
    results: list[dict[str, Any] | None] = []
    total_in = total_out = 0
    for temp in temperatures:
        text, tin, tout = await call_llm(
            prompt, model=model, provider=provider, temperature=temp, json_schema=resp_schema
        )
        total_in += tin
        total_out += tout
        results.append(_parse_result(text))

    usable = [r for r in results if r is not None]
    if not usable:
        raise ValueError("Extraction returned no parseable JSON")

    final_data: dict[str, Any] = {}
    final_confidence: dict[str, float] = {}
    disagreements: dict[str, Any] = {}

    if len(usable) == 1:
        only = usable[0]
        for field in output_schema:
            key = field["key"]
            final_data[key] = only["data"].get(key)
            final_confidence[key] = _conf(only, key)
    else:
        result_a, result_b = usable
        for field in output_schema:
            key = field["key"]
            val_a, val_b = result_a["data"].get(key), result_b["data"].get(key)
            conf_a, conf_b = _conf(result_a, key), _conf(result_b, key)
            if val_a == val_b:
                final_data[key] = val_a
                final_confidence[key] = max(conf_a, conf_b)
            else:
                disagreements[key] = {"run_a": val_a, "run_b": val_b, "conf_a": conf_a, "conf_b": conf_b}
                winner_val, winner_conf = (val_a, conf_a) if conf_a >= conf_b else (val_b, conf_b)
                final_data[key] = winner_val
                final_confidence[key] = round(winner_conf * 0.7, 4)  # penalise for disagreement

    return {
        "extracted_json": final_data,
        "extraction_confidence": final_confidence,
        "extraction_disagreements": disagreements,
        "pass2_tokens_in": total_in,
        "pass2_tokens_out": total_out,
        "pass2_cost_usd": get_price(model, total_in, total_out),
    }
