"""
GenAI Customer Simulator — Full Flow Demo
Run: python demo.py
"""
import json
import time
import urllib.request
import urllib.error

BASE = "http://localhost:8000"


def req(method, path, body=None, timeout=120):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body else None
    request = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"  ERROR {e.code}: {e.read().decode()}")
        return None
    except Exception as e:
        print(f"  ERROR {type(e).__name__}: {e}")
        return None


def step(n, title):
    print(f"\n{'='*60}")
    print(f"  Step {n}: {title}")
    print(f"{'='*60}")


# ── Step 1: Create Audience ───────────────────────────────────────────────────
step(1, "Create Audience")
audience = req("POST", "/api/audiences", {
    "name": "SaaS Buyers",
    "description": "B2B software buyers for pricing sensitivity study"
})
print(f"  Audience ID: {audience['id']}")
aid = audience["id"]

# ── Step 2: Add Variables ─────────────────────────────────────────────────────
step(2, "Add Variables")

age_var = req("POST", f"/api/audiences/{aid}/variables", {
    "name": "age",
    "var_type": "continuous",
    "distribution": {"type": "normal", "mean": 38, "std": 10, "min_clip": 22, "max_clip": 65},
    "sort_order": 0
})
print(f"  age variable: {age_var['id']}")

income_var = req("POST", f"/api/audiences/{aid}/variables", {
    "name": "income",
    "var_type": "continuous",
    "distribution": {"type": "log_normal", "real_mean": 90000, "real_std": 40000, "min_clip": 30000},
    "sort_order": 1
})
print(f"  income variable: {income_var['id']}")

tech_var = req("POST", f"/api/audiences/{aid}/variables", {
    "name": "tech_literacy",
    "var_type": "continuous",
    "distribution": {"type": "beta", "alpha": 3, "beta": 2},
    "sort_order": 2
})
print(f"  tech_literacy variable: {tech_var['id']}")

role_var = req("POST", f"/api/audiences/{aid}/variables", {
    "name": "role",
    "var_type": "categorical",
    "distribution": {
        "type": "categorical",
        "options": [
            {"label": "Individual Contributor", "weight": 0.40},
            {"label": "Manager", "weight": 0.35},
            {"label": "Director/VP", "weight": 0.20},
            {"label": "C-Suite", "weight": 0.05}
        ]
    },
    "sort_order": 3
})
print(f"  role variable: {role_var['id']}")

# ── Step 3: Add Correlation (age ↔ income) ────────────────────────────────────
step(3, "Add Correlation (age ↔ income: r=0.45)")
a, b = sorted([age_var["id"], income_var["id"]])
corr = req("PUT", f"/api/audiences/{aid}/correlations", {
    "correlations": [{"var_a_id": a, "var_b_id": b, "correlation": 0.45}]
})
print(f"  {corr}")

# ── Step 4: Sample Personas ───────────────────────────────────────────────────
step(4, "Sample 5 Personas (with backstories)")
personas = req("POST", f"/api/audiences/{aid}/sample", {
    "n": 5,
    "validate_plausibility": True,
    "llm_validation": False,
    "reuse_existing": False,
    "generate_backstories": False   # backstories generated at launch to avoid slow step here
})
print(f"  Generated {len(personas)} personas:")
for p in personas:
    traits = p["traits_json"]
    flag = " ⚠ FLAGGED" if p["flagged"] else ""
    print(f"    • age={traits.get('age'):.0f}  income=${traits.get('income'):,.0f}"
          f"  tech={traits.get('tech_literacy'):.2f}  role={traits.get('role')}"
          f"  plausibility={p['plausibility']:.2f}{flag}")

# ── Step 5: Create Experiment ─────────────────────────────────────────────────
step(5, "Create Experiment")
experiment = req("POST", "/api/experiments", {
    "audience_id": aid,
    "name": "Pricing Sensitivity Study",
    "global_context": (
        "You are participating in a research study about {{Product}} pricing. "
        "The product is a project management SaaS tool for teams."
    ),
    "execution_mode": "pooled",
})
print(f"  Experiment ID: {experiment['id']}")
eid = experiment["id"]

# ── Step 6: Add Experiment Variable ──────────────────────────────────────────
step(6, "Add {{Product}} Variable (A/B test)")
pvar = req("POST", f"/api/experiments/{eid}/variables", {
    "placeholder": "Product",
    "attributes": [
        {"value": "TaskFlow Pro", "weight": 0.5},
        {"value": "WorkSync", "weight": 0.5}
    ]
})
print(f"  Variable: {pvar['placeholder']} → {pvar['attributes']}")

# ── Step 7: Add Questions ─────────────────────────────────────────────────────
step(7, "Add Survey Questions")
questions = [
    {
        "sort_order": 1,
        "question_type": "scale",
        "question_text": "How likely are you to purchase {{Product}} at $29/month per user?",
        "scale_min": 1, "scale_max": 10,
        "ask_why": True
    },
    {
        "sort_order": 2,
        "question_type": "multiple_choice",
        "question_text": "What is your biggest concern about adopting {{Product}}?",
        "choices": ["Price", "Implementation complexity", "Team adoption", "Feature gaps", "Security/compliance"],
        "ask_why": False
    },
    {
        "sort_order": 3,
        "question_type": "scale",
        "question_text": "How does $49/month per user feel compared to the value {{Product}} provides?",
        "scale_min": 1, "scale_max": 10,
        "ask_why": False
    },
    {
        "sort_order": 4,
        "question_type": "open_ended",
        "question_text": "What would make you choose {{Product}} over your current solution?",
        "ask_why": False
    }
]
for q in questions:
    result = req("POST", f"/api/experiments/{eid}/questions", q)
    print(f"  Q{q['sort_order']}: {q['question_type']} — {q['question_text'][:60]}...")

# ── Step 8: Define Output Schema ──────────────────────────────────────────────
step(8, "Define Output Schema (what to extract from transcripts)")
schema = req("POST", f"/api/experiments/{eid}/output-schema", {
    "schema_json": [
        {"key": "purchase_intent_score", "type": "integer", "description": "Q1 answer (1-10)"},
        {"key": "price_concern", "type": "boolean", "description": "Did they select Price as main concern?"},
        {"key": "top_concern", "type": "string", "description": "Their biggest concern verbatim"},
        {"key": "value_perception", "type": "integer", "description": "Q3 answer (1-10)"},
        {"key": "key_decision_factor", "type": "string", "description": "What would make them switch (Q4 summary)"},
        {"key": "willingness_to_pay", "type": "string", "description": "Inferred WTP: low/medium/high"}
    ]
})
print(f"  Schema v{schema['version']} with {len(schema['schema_json'])} fields")

# ── Step 9: Pre-Flight ────────────────────────────────────────────────────────
step(9, "Run Pre-Flight (cost estimate, no LLM calls)")
preflight = req("POST", f"/api/experiments/{eid}/preflight", {
    "sample_size": 5,
    "model_pass1": "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q6_K.gguf",
    "model_pass2": "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q6_K.gguf",
    "dual_extraction": True
})
if not preflight:
    print("  Preflight failed — check server logs"); exit(1)
print(f"  Sample size: {preflight['sample_size']}")
print(f"  Plausibility: mean={preflight['plausibility_summary']['mean_score']:.2f}  "
      f"flagged={preflight['plausibility_summary']['flagged_count']}")
print(f"  Token estimate: {preflight['token_estimate']['pass1_input_tokens']} in / "
      f"{preflight['token_estimate']['pass1_output_tokens']} out per persona")
print(f"  Cost (local model = $0.00): ${preflight['cost_estimate']['grand_total']:.4f} total")
print(f"  Variable distribution: {preflight['variable_distributions']}")
print(f"\n  Sample payload preview:")
p0 = preflight["payloads"][0]
print(f"    Persona: {p0['backstory_preview']}")
print(f"    Resolved context snippet: {p0['resolved_variables']}")
print(f"    First question: {p0['questions'][0]['text'][:80]}...")

# ── Step 10: Launch Simulation ────────────────────────────────────────────────
step(10, "Launch Simulation (5 personas, runs in background)")
persona_ids = [p["id"] for p in personas]
run = req("POST", f"/api/experiments/{eid}/launch", {
    "population_size": 5,
    "model_pass1": "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q6_K.gguf",
    "model_pass2": "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF/Meta-Llama-3.1-8B-Instruct-Q6_K.gguf",
    "dual_extraction": True,
    "persona_ids": persona_ids
})
if not run:
    print("  Launch failed — check server logs")
else:
    print(f"  Run ID: {run['id']}")
    print(f"  Status: {run['status']}  (202 Accepted — running in background)")
    rid = run["id"]

    # ── Step 11: Poll until complete ─────────────────────────────────────────
    step(11, "Polling run status until complete...")
    for i in range(60):
        time.sleep(5)
        status = req("GET", f"/api/runs/{rid}")
        pct = (status['completed_tasks'] + status['failed_tasks']) / max(status['total_tasks'], 1) * 100
        print(f"  [{i*5:3d}s] {status['status']:10s}  "
              f"{status['completed_tasks']}/{status['total_tasks']} done  "
              f"{status['failed_tasks']} failed  "
              f"${status['total_cost_usd']:.4f}")
        if status["status"] in ("completed", "failed", "cancelled"):
            break

    # ── Step 12: Show Results ─────────────────────────────────────────────────
    step(12, "Results")
    tasks = req("GET", f"/api/runs/{rid}/tasks?limit=10")
    print(f"  {'TASK':<8} {'P1':^10} {'P2':^10} {'DRIFT':^6} {'purchase_intent':^15} {'WTP':^10}")
    print(f"  {'-'*65}")
    for t in tasks:
        p1 = t["pass1_status"][:4]
        p2 = t["pass2_status"][:4]
        drift = "YES" if t["drift_flagged"] else "no"

        # Get detail for extracted fields
        detail = req("GET", f"/api/runs/{rid}/tasks/{t['id']}")
        extracted = detail.get("extracted_json") or {}
        intent = extracted.get("purchase_intent_score", "—")
        wtp = extracted.get("willingness_to_pay", "—")
        print(f"  {t['id'][:8]:<8} {p1:^10} {p2:^10} {drift:^6} {str(intent):^15} {str(wtp):^10}")

    print(f"\n  Export URL: {BASE}/api/runs/{rid}/export?format=csv")
    print(f"\n  Done! View full transcripts at:")
    print(f"  http://localhost:8000/docs#/runs/get_task_api_runs__run_id__tasks__task_id__get")

print(f"\n{'='*60}")
print("  Full flow complete!")
print(f"{'='*60}\n")
