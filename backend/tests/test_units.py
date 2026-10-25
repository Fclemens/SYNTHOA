import json

import httpx
import openai
import pytest
from sqlalchemy import create_engine, text

from app import config
from app.main import _migrate
from app.services import llm_client
from app.services.extraction import _build_response_json_schema, normalize_field
from app.services.drift_detection import build_grounding_refresh
from app.services.sampling import evaluate_condition
from app.services.variable_resolution import sample_from_distribution


def test_legacy_enum_spelling_is_normalised():
    assert normalize_field({"key": "k", "type": "enum(a, b)"})["values"] == ["a", "b"]
    schema = _build_response_json_schema([{"key": "k", "type": "enum(a,b)"}])
    assert schema["properties"]["data"]["properties"]["k"]["enum"] == ["a", "b"]


def test_grounding_refresh_is_generic_and_handles_strings():
    msg = build_grounding_refresh({"income": "High", "favourite_colour": "teal"})
    assert "Income: High" in msg["content"] and "Favourite Colour: teal" in msg["content"]


def test_conditions_never_raise_on_type_mismatch():
    assert evaluate_condition({"var": "income", "op": ">", "value": 10}, {"income": "High"}) is False
    assert evaluate_condition({"var": "age", "op": "<", "value": 30}, {"age": 25}) is True


def test_experiment_sampler_supports_all_distributions():
    for dist in [{"type": "truncated_normal", "mean": 5, "std": 2, "min": 0, "max": 10},
                 {"type": "poisson", "lambda": 3}, {"type": "weibull", "shape": 1.5, "scale": 2},
                 {"type": "uniform", "min": 1, "max": 2, "round_to_int": True}]:
        float(sample_from_distribution(dist))


def test_pricing_overrides_merge_with_defaults():
    config._apply({"model_pricing": {"my-local-model": {"input": 0, "output": 0}}})
    assert "gpt-5.4" in config.settings.model_pricing and "my-local-model" in config.settings.model_pricing
    assert config.settings.model_pass1.startswith("gpt-5")


class _FakeCompletions:
    def __init__(self, reject):
        self.reject, self.seen = set(reject), []

    async def create(self, **kwargs):
        self.seen.append(kwargs)
        for p in self.reject:
            if p in kwargs:
                req = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
                raise openai.BadRequestError(
                    f"Unsupported parameter: '{p}' is not supported with this model.",
                    response=httpx.Response(400, request=req), body=None)

        class R:
            choices = [type("C", (), {"message": type("M", (), {"content": "ok"})()})()]
            usage = type("U", (), {"prompt_tokens": 3, "completion_tokens": 1})()
        return R()


async def test_openai_drops_rejected_params_and_uses_completion_tokens(monkeypatch):
    fake = _FakeCompletions(reject=["temperature"])
    client = type("Cl", (), {"chat": type("Ch", (), {"completions": fake})()})()
    monkeypatch.setattr(llm_client, "_get_openai_client", lambda provider: client)
    llm_client._unsupported.clear()

    text, tin, tout = await llm_client.call_llm("hi", model="gpt-5.4", provider="openai", max_tokens=400)
    assert (text, tin, tout) == ("ok", 3, 1)
    assert "max_tokens" not in fake.seen[0] and fake.seen[0]["max_completion_tokens"] >= 400
    assert fake.seen[0]["reasoning_effort"] == "none"
    assert "temperature" not in fake.seen[-1]
    # Remembered per model: the next call does not retry the rejected parameter.
    await llm_client.call_llm("hi", model="gpt-5.4", provider="openai")
    assert len(fake.seen) == 3


def test_migration_converts_placeholders_and_drops_legacy(tmp_path):
    from app.database import Base
    from app import models  # noqa: F401
    engine = create_engine(f"sqlite:///{tmp_path}/legacy.db")
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE personas ADD COLUMN plausibility FLOAT"))
        conn.execute(text("CREATE TABLE experiment_variables (id TEXT PRIMARY KEY, experiment_id TEXT, placeholder TEXT, attributes JSON)"))
        conn.execute(text("CREATE TABLE calibration_status (experiment_id TEXT PRIMARY KEY)"))
        conn.execute(text("INSERT INTO audiences (id, name) VALUES ('a', 'A')"))
        conn.execute(text("INSERT INTO experiments (id, audience_id, name, global_context, execution_mode, drift_detection_enabled) "
                          "VALUES ('e', 'a', 'E', 'Try {{brand}} now', 'pooled', 1)"))
        conn.execute(text("INSERT INTO questions (id, experiment_id, sort_order, question_type, question_text, ask_why) "
                          "VALUES ('q', 'e', 1, 'open_ended', 'Do you like {{brand}}?', 0)"))
        conn.execute(text("INSERT INTO experiment_variables VALUES ('v', 'e', 'brand', :a)"),
                     {"a": json.dumps([{"value": "Acme", "weight": 2}])})
        _migrate(conn)
        tables = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        assert "experiment_variables" not in tables and "calibration_status" not in tables
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(personas)"))}
        assert "plausibility" not in cols and "archived" in cols
        assert conn.execute(text("SELECT global_context FROM experiments")).scalar() == "Try {brand} now"
        assert conn.execute(text("SELECT question_text FROM questions")).scalar() == "Do you like {brand}?"
        dist = json.loads(conn.execute(text("SELECT distribution FROM experiment_dist_variables")).scalar())
        assert dist["options"] == [{"label": "Acme", "weight": 2.0}]
        _migrate(conn)   # idempotent


async def test_anthropic_uses_output_config_and_no_temperature(monkeypatch):
    seen = []

    class Messages:
        async def create(self, **kwargs):
            seen.append(kwargs)
            block = type("B", (), {"type": "text", "text": '{"data": {}, "confidence": {}}'})()
            usage = type("U", (), {"input_tokens": 5, "output_tokens": 2})()
            return type("R", (), {"content": [block], "usage": usage, "stop_reason": "end_turn"})()

    client = type("C", (), {"messages": Messages()})()
    monkeypatch.setattr(llm_client, "_get_anthropic_client", lambda: client)
    schema = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
    text, tin, tout = await llm_client.call_llm(
        "extract", model="claude-haiku-5-5", provider="anthropic", system="sys",
        temperature=0.0, max_tokens=400, json_schema=schema,
    )
    kwargs = seen[0]
    assert "temperature" not in kwargs and "tools" not in kwargs and "tool_choice" not in kwargs
    assert kwargs["output_config"]["format"] == {"type": "json_schema", "schema": schema}
    assert kwargs["system"] == "sys" and kwargs["max_tokens"] >= 400
    assert (tin, tout) == (5, 2)
