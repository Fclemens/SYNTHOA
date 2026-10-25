"""
Test harness: a throwaway SQLite database and a fake LLM, so the whole
pipeline (sampling → launch → interview → extraction → analysis) runs offline.
"""
import json
import os
import re
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmp}/test.db"

import httpx  # noqa: E402
import pytest  # noqa: E402

from app import database  # noqa: E402
from app.main import app  # noqa: E402
from app.services import interview, llm_client  # noqa: E402


class FakeLLM:
    """Records every call; answers interviews in prose and extractions with schema-valid JSON."""

    def __init__(self):
        self.calls: list[dict] = []
        self.fail_extraction = False

    async def __call__(self, messages, model, provider="openai", temperature=0.7,
                       max_tokens=4096, json_mode=False, json_schema=None):
        self.calls.append({"messages": messages, "model": model, "provider": provider,
                           "json_schema": json_schema, "json_mode": json_mode})
        if json_schema is not None:
            if self.fail_extraction:
                return "not json at all", 50, 5
            data = {}
            for key, prop in json_schema["properties"]["data"]["properties"].items():
                if "enum" in prop:
                    data[key] = prop["enum"][0]
                elif prop["type"] == "integer":
                    data[key] = 7
                elif prop["type"] == "number":
                    data[key] = 1.5
                elif prop["type"] == "boolean":
                    data[key] = True
                else:
                    data[key] = "because, it is \"fine\"\nreally"
            conf = {k: 0.9 for k in data}
            return json.dumps({"data": data, "confidence": conf}), 100, 20
        if json_mode:
            return json.dumps({"score": 0.95, "drift_indicators": []}), 30, 10
        last = messages[-1]["content"]
        return f"My answer to: {last[:40]}", 200, 40


@pytest.fixture
def fake_llm(monkeypatch):
    fake = FakeLLM()
    monkeypatch.setattr(llm_client, "call_llm_messages", fake)
    monkeypatch.setattr(interview, "call_llm_messages", fake)
    return fake


@pytest.fixture
async def client(fake_llm):
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c
    await database.engine.dispose()


async def make_audience(client, n_personas=6, backstory_mode="template"):
    a = (await client.post("/api/audiences", json={"name": "Shoppers"})).json()
    await client.post(f"/api/audiences/{a['id']}/variables", json={
        "name": "age", "var_type": "continuous",
        "distribution": {"type": "truncated_normal", "mean": 40, "std": 12, "min": 18, "max": 80, "round_to_int": True},
    })
    await client.post(f"/api/audiences/{a['id']}/variables", json={
        "name": "region", "var_type": "categorical",
        "distribution": {"type": "categorical", "options": [
            {"label": "North", "weight": 1}, {"label": "South", "weight": 1}, {"label": "East", "weight": 1}]},
    })
    r = await client.post(f"/api/audiences/{a['id']}/sample",
                          json={"n": n_personas, "backstory_mode": backstory_mode})
    assert r.status_code == 202, r.text
    return a


async def make_experiment(client, audience_id, mode="pooled"):
    e = (await client.post("/api/experiments", json={
        "audience_id": audience_id, "name": "Pricing test",
        "global_context": "We are testing a {plan} subscription.", "execution_mode": mode,
    })).json()
    await client.post(f"/api/experiments/{e['id']}/dist-variables", json={
        "name": "plan", "var_type": "categorical",
        "distribution": {"type": "categorical", "options": [{"label": "Basic", "weight": 1}, {"label": "Pro", "weight": 1}]},
    })
    for i, q in enumerate([
        {"question_type": "scale", "question_text": "How likely are you to buy {plan}?",
         "scale_min": 1, "scale_max": 7, "scale_anchor_low": "Not at all", "scale_anchor_high": "Certainly"},
        {"question_type": "single_choice", "question_text": "Which channel?", "choices": ["Web", "Store"]},
        {"question_type": "open_ended", "question_text": "Why?"},
        {"question_type": "open_ended", "question_text": "Anything else?", "ask_why": True},
    ]):
        r = await client.post(f"/api/experiments/{e['id']}/questions", json={"sort_order": i + 1, **q})
        assert r.status_code == 201, r.text
    r = await client.post(f"/api/experiments/{e['id']}/output-schema", json={"schema_json": [
        {"key": "likelihood", "type": "scale"},
        {"key": "channel", "type": "enum", "values": ["Web", "Store"]},
        {"key": "reason", "type": "string"},
    ]})
    assert r.status_code == 201, r.text
    return e


def prompts_text(fake):
    return "\n".join(m["content"] for c in fake.calls if c["json_schema"] is None and not c["json_mode"]
                     for m in c["messages"])


def find(pattern, text):
    return re.search(pattern, text) is not None
