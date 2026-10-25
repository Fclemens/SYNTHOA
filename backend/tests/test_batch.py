"""Batch-mode runs against a fake provider batch API backed by the FakeLLM."""
import asyncio

import pytest

from app.config import settings
from app.database import AsyncSessionLocal
from app.models.simulation import SimulationRun, SimulationTask
from app.services import batch, execution
from app.services.batch import BatchStatus
from app.services.llm_client import LLMResult
from tests.conftest import make_audience, make_experiment
from tests.test_pipeline import launch


class SimulatedCrash(BaseException):
    """Escapes run_batch's error handling, like a process dying mid-poll."""


class FakeBatches:
    def __init__(self, llm):
        self.llm = llm
        self.batches: dict[str, list] = {}
        self.cancelled: list[str] = []
        self.on_status = None

    async def submit(self, requests):
        batch_id = f"batch_{len(self.batches)}"
        self.batches[batch_id] = requests
        return batch_id

    async def status(self, batch_id):
        ended = True
        if self.on_status:
            ended = await self.on_status(batch_id) is not False
        n = len(self.batches[batch_id])
        return BatchStatus(ended=ended, total=n, done=n if ended else 0)

    async def results(self, batch_id):
        out = {}
        for cid, body in self.batches[batch_id]:
            schema = (body.get("response_format") or {}).get("json_schema", {}).get("schema")
            text, tin, tout = await self.llm(body["messages"], body["model"], json_schema=schema)
            out[cid] = LLMResult(text, tin, tout, batch=True)
        return out

    async def cancel(self, batch_id):
        self.cancelled.append(batch_id)


@pytest.fixture
def fake_batches(fake_llm, monkeypatch):
    fake = FakeBatches(fake_llm)
    monkeypatch.setattr(batch, "get_backend", lambda provider: fake)
    monkeypatch.setattr(settings, "batch_poll_seconds", 0)
    monkeypatch.setattr(settings, "provider_pass1", "openai")
    monkeypatch.setattr(settings, "provider_pass2", "openai")
    return fake


async def _tasks(run_id):
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            SimulationTask.__table__.select().where(SimulationTask.run_id == run_id)
        )).all()


async def test_batch_run_probes_once_then_batches_both_passes_at_half_price(client, fake_batches):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    run = await launch(client, e["id"], n=4, batch_mode=True)

    assert run["status"] == "completed" and run["completed_tasks"] == 4
    assert run["batch_mode"] is True and run["batch_state"] is None
    # One task ran live to probe the model; the other three went through two batches.
    interviews, extractions = fake_batches.batches.values()
    assert len(interviews) == 3 and len(extractions) == 3 * 2   # dual extraction
    assert all(cid.endswith("__p1") for cid, _ in interviews)
    # The survey prefix depends only on the sampled {plan}, so requests share at most two cache keys.
    assert len({body["prompt_cache_key"] for _, body in interviews}) <= 2

    costs = sorted(t.pass1_cost_usd for t in await _tasks(run["id"]))
    assert costs[0] == pytest.approx(costs[-1] / 2)   # batched vs the live probe
    assert all(t.pass1_prompt and t.extracted_json for t in await _tasks(run["id"]))


async def test_batch_polling_resumes_after_a_restart_without_resubmitting(client, fake_batches):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])

    async def crash(_):
        raise SimulatedCrash()
    fake_batches.on_status = crash
    with pytest.raises(SimulatedCrash):
        await client.post(f"/api/experiments/{e['id']}/launch", json={"population_size": 3, "batch_mode": True})

    async with AsyncSessionLocal() as db:
        run = (await db.execute(SimulationRun.__table__.select())).all()[-1]
    assert run.status == "running" and run.batch_state["phase"] == "interviews"

    fake_batches.on_status = None
    await execution.recover_interrupted_runs()
    await asyncio.gather(*execution._background)

    final = (await client.get(f"/api/runs/{run.id}")).json()
    assert final["status"] == "completed" and final["completed_tasks"] == 3
    assert len(fake_batches.batches) == 2   # interviews once, extraction once


async def test_cancelling_a_batch_run_cancels_the_provider_batch(client, fake_batches):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])

    async def cancel_run(_):
        async with AsyncSessionLocal() as db:
            for r in (await db.execute(SimulationRun.__table__.select())).all():
                (await db.get(SimulationRun, r.id)).status = "cancelled"
            await db.commit()
        return False   # still processing when the user cancels
    fake_batches.on_status = cancel_run
    run = await launch(client, e["id"], n=3, batch_mode=True)

    assert run["status"] == "cancelled" and run["batch_state"] is None
    assert fake_batches.cancelled == ["batch_0"]
    statuses = sorted(t.pass1_status for t in await _tasks(run["id"]))
    assert statuses == ["cancelled", "cancelled", "completed"]   # the live probe had finished

    fake_batches.on_status = None
    assert (await client.post(f"/api/runs/{run['id']}/resume")).status_code == 202
    assert (await client.get(f"/api/runs/{run['id']}")).json()["completed_tasks"] == 3


async def test_batch_mode_requires_pooled_interviews(client, fake_batches):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"], mode="dedicated")
    r = await client.post(f"/api/experiments/{e['id']}/launch", json={"population_size": 2, "batch_mode": True})
    assert r.status_code == 400
