import csv
import io

import pytest

from app.services.execution import recover_interrupted_runs
from app.database import AsyncSessionLocal
from app.models.simulation import SimulationRun, SimulationTask
from tests.conftest import find, make_audience, make_experiment, prompts_text


async def launch(client, exp_id, n=4, **kw):
    r = await client.post(f"/api/experiments/{exp_id}/launch", json={"population_size": n, **kw})
    assert r.status_code == 202, r.text
    return (await client.get(f"/api/runs/{r.json()['id']}")).json()


@pytest.mark.parametrize("mode", ["pooled", "dedicated"])
async def test_run_completes_with_formats_and_counts(client, fake_llm, mode):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"], mode=mode)
    run = await launch(client, e["id"], n=4)

    assert run["status"] == "completed"
    assert run["completed_tasks"] == 4 and run["failed_tasks"] == 0
    assert run["total_cost_usd"] > 0

    text = prompts_text(fake_llm)
    # Both modes must carry scale range + anchors, choices, and resolved variables.
    assert find(r'scale of 1 to 7, where 1 = "Not at all" and 7 = "Certainly"', text)
    assert "Select ONE option: Web, Store" in text
    assert "{plan}" not in text and ("Basic" in text or "Pro" in text)

    # The enum constraint reaches the structured-output schema; strict mode needs required keys.
    schema = next(c["json_schema"] for c in fake_llm.calls if c["json_schema"])
    assert schema["properties"]["data"]["properties"]["channel"]["enum"] == ["Web", "Store"]
    assert set(schema["properties"]["confidence"]["required"]) == {"likelihood", "channel", "reason"}

    tasks = (await client.get(f"/api/runs/{run['id']}/respondents")).json()
    assert all(t["extracted_json"]["channel"] == "Web" for t in tasks)
    assert all(set(t["injected_vars"]) == {"plan"} for t in tasks)


async def test_extraction_parse_failure_marks_task_failed_and_retry_recovers(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    fake_llm.fail_extraction = True
    run = await launch(client, e["id"], n=3)
    assert run["status"] == "failed"
    assert run["failed_tasks"] == 3 and run["completed_tasks"] == 0

    fake_llm.fail_extraction = False
    interview_calls = sum(1 for c in fake_llm.calls if c["json_schema"] is None)
    assert (await client.post(f"/api/runs/{run['id']}/retry-failed")).status_code == 202
    run = (await client.get(f"/api/runs/{run['id']}")).json()
    assert run["status"] == "completed" and run["completed_tasks"] == 3 and run["failed_tasks"] == 0
    # Pass-2-only retry: no new interviews were run.
    assert sum(1 for c in fake_llm.calls if c["json_schema"] is None) == interview_calls


async def test_re_extract_does_not_double_count_and_updates_schema(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    run = await launch(client, e["id"], n=3)
    cost_before = run["total_cost_usd"]

    await client.post(f"/api/experiments/{e['id']}/output-schema",
                      json={"schema_json": [{"key": "would_buy", "type": "boolean"}]})
    assert (await client.post(f"/api/runs/{run['id']}/re-extract", json={})).status_code == 202
    run2 = (await client.get(f"/api/runs/{run['id']}")).json()
    assert run2["completed_tasks"] == 3 and run2["status"] == "completed"
    assert run2["total_cost_usd"] == pytest.approx(cost_before)   # pass-2 cost replaced, not added
    summary = (await client.get(f"/api/runs/{run['id']}/analysis/summary")).json()
    assert set(summary["fields"]) == {"would_buy"}


async def test_cancel_then_resume_and_startup_recovery(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    run = await launch(client, e["id"], n=3)

    # Simulate a crash mid-run: tasks left running, run left running.
    async with AsyncSessionLocal() as db:
        r = await db.get(SimulationRun, run["id"])
        r.status = "running"
        for t in (await db.execute(SimulationTask.__table__.select().where(SimulationTask.run_id == run["id"]))).all()[:2]:
            task = await db.get(SimulationTask, t.id)
            task.pass1_status, task.pass2_status = "running", "pending"
        await db.commit()

    await recover_interrupted_runs()
    assert (await client.get(f"/api/runs/{run['id']}")).json()["status"] == "cancelled"

    assert (await client.post(f"/api/runs/{run['id']}/resume")).status_code == 202
    run = (await client.get(f"/api/runs/{run['id']}")).json()
    assert run["status"] == "completed" and run["completed_tasks"] == 3


async def test_csv_export_quotes_commas_and_newlines(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    run = await launch(client, e["id"], n=2)
    r = await client.get(f"/api/runs/{run['id']}/export?format=csv")
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert len(rows) == 2
    assert rows[0]["reason"] == 'because, it is "fine"\nreally'
    xlsx = await client.get(f"/api/runs/{run['id']}/export?format=xlsx")
    assert xlsx.status_code == 200 and xlsx.content[:2] == b"PK"


async def test_start_fresh_archives_used_personas_and_deletes_are_safe(client, fake_llm):
    a = await make_audience(client, n_personas=5)
    e = await make_experiment(client, a["id"])
    run = await launch(client, e["id"], n=3)

    r = await client.post(f"/api/audiences/{a['id']}/sample/fresh", json={"n": 4, "backstory_mode": "none"})
    assert r.status_code == 202
    personas = (await client.get(f"/api/audiences/{a['id']}/personas")).json()
    assert len(personas) == 4
    assert (await client.get(f"/api/audiences/{a['id']}")).json()["persona_count"] == 4
    # Old run keeps its respondents' traits.
    respondents = (await client.get(f"/api/runs/{run['id']}/respondents")).json()
    assert all(r["persona_traits"] for r in respondents)

    # Deleting a variable that has correlations works with FK enforcement on.
    aud = (await client.get(f"/api/audiences/{a['id']}")).json()
    v1, v2 = aud["variables"][0]["id"], aud["variables"][1]["id"]
    await client.put(f"/api/audiences/{a['id']}/correlations",
                     json={"correlations": [{"var_a_id": v1, "var_b_id": v2, "correlation": 0.3}]})
    assert (await client.delete(f"/api/audiences/{a['id']}/variables/{v1}")).status_code == 204

    # Deleting the audience removes its experiments and runs too.
    assert (await client.delete(f"/api/audiences/{a['id']}")).status_code == 204
    assert (await client.get(f"/api/experiments/{e['id']}")).status_code == 404
    assert (await client.get(f"/api/runs/{run['id']}")).status_code == 404


async def test_preflight_preview_and_protocol_roundtrip(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"], mode="dedicated")
    body = {"sample_size": 3, "dual_extraction": True}
    report = (await client.post(f"/api/experiments/{e['id']}/preflight", json=body)).json()
    assert report["cost_estimate"]["grand_total"] > 0
    assert (await client.post(f"/api/experiments/{e['id']}/preflight/export", json=body)).status_code == 200

    preview = await client.post(f"/api/experiments/{e['id']}/preview-interview", json={})
    assert preview.status_code == 200, preview.text
    p = preview.json()
    assert p["extracted_json"]["channel"] == "Web" and "plan" in p["resolved_variables"]
    assert 'where 1 = "Not at all"' in p["transcript"]

    bundle = (await client.get(f"/api/experiments/export-protocol/{e['id']}")).json()
    assert bundle["questions"][0]["scale_anchor_low"] == "Not at all"
    # Old bundles with {{placeholder}} variables import as categorical {placeholder} variables.
    bundle["variables"] = [{"placeholder": "brand", "attributes": [{"value": "Acme", "weight": 1}]}]
    bundle["experiment"]["global_context"] += " Brand: {{brand}}."
    r = await client.post("/api/experiments/import-protocol", json={"audience_id": a["id"], "bundle": bundle})
    assert r.status_code == 201, r.text
    imported = (await client.get(f"/api/experiments/{r.json()['experiment_id']}")).json()
    assert "{brand}" in imported["global_context"] and "{{brand}}" not in imported["global_context"]
    assert {v["name"] for v in imported["dist_variables"]} == {"plan", "brand"}
    assert imported["questions"][0]["scale_anchor_high"] == "Certainly"


async def test_question_fields_can_be_cleared(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    q = (await client.get(f"/api/experiments/{e['id']}")).json()["questions"][0]
    r = await client.put(f"/api/experiments/{e['id']}/questions/{q['id']}", json={"scale_anchor_low": None})
    assert r.json()["scale_anchor_low"] is None and r.json()["scale_anchor_high"] == "Certainly"


async def test_enum_schema_validation(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    r = await client.post(f"/api/experiments/{e['id']}/output-schema",
                          json={"schema_json": [{"key": "x", "type": "enum"}]})
    assert r.status_code == 422


async def test_runs_are_numbered_named_and_labelled(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    r1 = await launch(client, e["id"], n=2)
    r2 = await launch(client, e["id"], n=2)
    assert (r1["run_number"], r2["run_number"]) == (1, 2)
    assert r2["experiment_name"] == "Pricing test" and r2["execution_mode"] == "pooled"
    r = await client.patch(f"/api/runs/{r1['id']}", json={"name": "  baseline  "})
    assert r.json()["name"] == "baseline"
    listed = (await client.get(f"/api/runs?experiment_id={e['id']}")).json()
    assert {x["name"] for x in listed} == {"baseline", None}
    assert all(x["experiment_name"] == "Pricing test" for x in listed)


async def test_panel_check_compares_target_and_sample(client, fake_llm):
    a = await make_audience(client, n_personas=30)
    aud = (await client.get(f"/api/audiences/{a['id']}")).json()
    v_age = next(v["id"] for v in aud["variables"] if v["name"] == "age")
    await client.post(f"/api/audiences/{a['id']}/variables", json={
        "name": "score", "var_type": "continuous", "distribution": {"type": "normal", "mean": 0, "std": 1}})
    aud = (await client.get(f"/api/audiences/{a['id']}")).json()
    v_score = next(v["id"] for v in aud["variables"] if v["name"] == "score")
    await client.put(f"/api/audiences/{a['id']}/correlations",
                     json={"correlations": [{"var_a_id": v_age, "var_b_id": v_score, "correlation": 0.6}]})
    await client.post(f"/api/audiences/{a['id']}/sample/fresh", json={"n": 200, "backstory_mode": "none"})

    check = (await client.get(f"/api/audiences/{a['id']}/panel-check")).json()
    assert check["n_personas"] == 200
    by_name = {v["name"]: v for v in check["variables"]}
    region = by_name["region"]
    assert region["kind"] == "categorical" and len(region["categories"]) == 3
    assert abs(sum(c["actual"] for c in region["categories"]) - 1) < 1e-6
    age = by_name["age"]
    assert age["kind"] == "numeric" and len(age["bins"]) == 12
    assert abs(age["actual_mean"] - age["target_mean"]) < 4
    corr = check["correlations"][0]
    assert corr["target"] == 0.6 and corr["actual"] > 0.3


async def test_provider_test_endpoint(client, fake_llm):
    r = (await client.post("/api/settings/test-provider", json={"provider": "openai", "model": "gpt-6-luna"})).json()
    assert r["ok"] is True and "latency_ms" in r


async def test_retry_replays_the_protocol_frozen_at_launch(client, fake_llm):
    a = await make_audience(client)
    e = await make_experiment(client, a["id"])
    fake_llm.fail_interviews = True
    run = await launch(client, e["id"], n=2)
    assert run["status"] == "failed"

    # Edit the experiment after launch; the retry must still ask the original question.
    q = (await client.get(f"/api/experiments/{e['id']}")).json()["questions"][-1]
    await client.put(f"/api/experiments/{e['id']}/questions/{q['id']}", json={"question_text": "EDITED AFTER LAUNCH"})
    fake_llm.fail_interviews = False
    fake_llm.calls.clear()
    await client.post(f"/api/runs/{run['id']}/retry-failed")
    run = (await client.get(f"/api/runs/{run['id']}")).json()
    assert run["status"] == "completed"
    text = prompts_text(fake_llm)
    assert "Anything else?" in text and "EDITED AFTER LAUNCH" not in text
