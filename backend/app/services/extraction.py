"""
Algorithm 6: Dual-Extraction with Confidence Scoring (Pass 2)
Runs extraction twice at different temperatures; flags disagreements.
"""
from __future__ import annotations
import json
import logging
from typing import Any

from .llm_client import call_llm, get_price, parse_json_response

logger = logging.getLogger(__name__)


_FIELD_TYPE_MAP: dict[str, dict] = {
    "string":  {"type": "string"},
    "integer": {"type": "integer"},
    "float":   {"type": "number"},
    "boolean": {"type": "boolean"},
    "scale":   {"type": "integer", "minimum": 1, "maximum": 10},
}


def _build_response_json_schema(output_schema: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Build a JSON Schema for response_format from our output_schema field list.
    Produces: {"data": {field: typed_value, ...}, "confidence": {field: number, ...}}
    Compatible with OpenAI structured outputs and LM Studio json_schema mode.
    """
    data_props: dict[str, Any] = {}
    keys: list[str] = []
    for field in output_schema:
        key = field.get("key", "")
        if not key:
            continue
        ftype = field.get("type", "string")
        if ftype == "enum":
            values = field.get("values") or []
            data_props[key] = {"type": "string", "enum": values} if values else {"type": "string"}
        else:
            data_props[key] = _FIELD_TYPE_MAP.get(ftype, {"type": "string"})
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
                "additionalProperties": False,
            },
        },
        "required": ["data", "confidence"],
        "additionalProperties": False,
    }


def _build_extraction_prompt(transcript: str, output_schema: list[dict[str, Any]]) -> str:
    schema_str = json.dumps(output_schema, indent=2)
    return (
        "You are a precise data extraction engine. Read the following interview transcript "
        "and extract the requested data points. Return ONLY valid JSON matching this schema.\n\n"
        f"Schema:\n{schema_str}\n\n"
        "For each field, also provide a confidence score (0.0–1.0) indicating how clearly "
        "the transcript supports your extraction.\n\n"
        f"Transcript:\n---\n{transcript}\n---\n\n"
        'Return JSON: {"data": {...}, "confidence": {...}}'
    )


async def extract_with_confidence(
    transcript: str,
    output_schema: list[dict[str, Any]],
    model: str = "gpt-4o-mini",
    provider: str = "openai",
    dual: bool = True,
) -> dict[str, Any]:
    """
    Run extraction once (dual=False) or twice (dual=True) with different temperatures.
    Uses response_format=json_schema (compatible with LM Studio + OpenAI).
    Falls back to json_object then prompt-only if the model rejects structured formats.
    Returns {extracted_json, extraction_confidence, extraction_disagreements,
             tokens_in, tokens_out, cost_usd}.
    """
    prompt = _build_extraction_prompt(transcript, output_schema)
    resp_schema = _build_response_json_schema(output_schema)

    text_a, tin_a, tout_a = await call_llm(
        prompt, model=model, provider=provider, temperature=0.0, json_schema=resp_schema
    )
    total_in = tin_a
    total_out = tout_a

    try:
        result_a = parse_json_response(text_a)
    except Exception:
        result_a = {"data": {}, "confidence": {}}

    if not dual:
        cost = get_price(model, total_in, total_out)
        return {
            "extracted_json": result_a.get("data", {}),
            "extraction_confidence": result_a.get("confidence", {}),
            "extraction_disagreements": {},
            "pass2_tokens_in": total_in,
            "pass2_tokens_out": total_out,
            "pass2_cost_usd": cost,
        }

    # Second extraction at temperature=0.3
    text_b, tin_b, tout_b = await call_llm(
        prompt, model=model, provider=provider, temperature=0.3, json_schema=resp_schema
    )
    total_in += tin_b
    total_out += tout_b

    try:
        result_b = parse_json_response(text_b)
    except Exception:
        result_b = {"data": {}, "confidence": {}}

    # Compare field by field
    final_data: dict[str, Any] = {}
    final_confidence: dict[str, float] = {}
    disagreements: dict[str, Any] = {}

    for field in output_schema:
        key = field["key"]
        val_a = result_a["data"].get(key)
        val_b = result_b["data"].get(key)
        conf_a = float(result_a["confidence"].get(key, 0.5))
        conf_b = float(result_b["confidence"].get(key, 0.5))

        if val_a == val_b:
            final_data[key] = val_a
            final_confidence[key] = max(conf_a, conf_b)
        else:
            disagreements[key] = {
                "run_a": val_a, "run_b": val_b,
                "conf_a": conf_a, "conf_b": conf_b,
            }
            if conf_a >= conf_b:
                final_data[key] = val_a
                final_confidence[key] = round(conf_a * 0.7, 4)  # penalise for disagreement
            else:
                final_data[key] = val_b
                final_confidence[key] = round(conf_b * 0.7, 4)

    cost = get_price(model, total_in, total_out)
    return {
        "extracted_json": final_data,
        "extraction_confidence": final_confidence,
        "extraction_disagreements": disagreements,
        "pass2_tokens_in": total_in,
        "pass2_tokens_out": total_out,
        "pass2_cost_usd": cost,
    }
