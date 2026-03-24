"""
Analysis service: statistical summary computation + LLM-powered summaries.
"""
from __future__ import annotations

import statistics
from collections import Counter
from pathlib import Path
from typing import Any

from ..services.llm_client import call_llm, get_price

PROMPTS_DIR = Path(__file__).parent.parent.parent / "prompts"


def _load_prompt(name: str) -> str:
    path = PROMPTS_DIR / f"{name}.txt"
    if path.exists():
        return path.read_text(encoding="utf-8")
    raise FileNotFoundError(f"Prompt file not found: {path}")


def save_prompt(name: str, content: str) -> None:
    path = PROMPTS_DIR / f"{name}.txt"
    path.write_text(content, encoding="utf-8")


def get_prompt(name: str) -> str:
    return _load_prompt(name)


def _make_histogram(values: list[float], bins: int = 10) -> list[dict]:
    if not values:
        return []
    min_v, max_v = min(values), max(values)
    if min_v == max_v:
        return [{"label": str(min_v), "count": len(values)}]
    bucket_size = (max_v - min_v) / bins
    buckets = [0] * bins
    for v in values:
        idx = min(int((v - min_v) / bucket_size), bins - 1)
        buckets[idx] += 1
    return [
        {
            "label": f"{min_v + i * bucket_size:.1f}–{min_v + (i + 1) * bucket_size:.1f}",
            "count": cnt,
        }
        for i, cnt in enumerate(buckets)
    ]


def compute_summary(run: Any, tasks: list[Any], confidence_threshold: float = 0.0) -> dict:
    """
    Aggregate stats from task extracted_json using locked_config.output_schema field types.
    Field types: scale/number/integer/float → stats+histogram
                 multiple_choice            → distribution %
                 boolean                    → true/false %
                 open_ended/text/string     → raw answers list (LLM summary on demand)
                 anything else              → treated as categorical
    """
    schema_fields: list[dict] = run.locked_config.get("output_schema", [])

    field_values: dict[str, list] = {f["key"]: [] for f in schema_fields}
    completed_tasks = 0
    drift_flagged_count = 0

    for task in tasks:
        if task.pass2_status != "completed" or not task.extracted_json:
            continue
        completed_tasks += 1
        if task.drift_flagged:
            drift_flagged_count += 1

        confidence = task.extraction_confidence or {}

        for field in schema_fields:
            key = field["key"]
            value = task.extracted_json.get(key)
            if value is None:
                continue
            # Confidence filter
            if confidence_threshold > 0 and key in confidence:
                if confidence[key] < confidence_threshold:
                    continue
            field_values[key].append(value)

    results: dict[str, dict] = {}
    for field in schema_fields:
        key = field["key"]
        ftype = field.get("type", "string").lower()
        description = field.get("description", "")
        values = field_values[key]

        base: dict = {
            "key": key,
            "type": ftype,
            "description": description,
            "n": len(values),
            "missing": completed_tasks - len(values),
        }

        if ftype in ("scale", "number", "integer", "float"):
            numeric = []
            for v in values:
                try:
                    numeric.append(float(v))
                except (TypeError, ValueError):
                    pass
            if numeric:
                results[key] = {
                    **base,
                    "mean": round(statistics.mean(numeric), 2),
                    "median": round(statistics.median(numeric), 2),
                    "std": round(statistics.stdev(numeric) if len(numeric) > 1 else 0.0, 2),
                    "min": min(numeric),
                    "max": max(numeric),
                    "histogram": _make_histogram(numeric),
                }
            else:
                results[key] = {**base, "mean": None, "median": None, "std": None,
                                "min": None, "max": None, "histogram": []}

        elif ftype == "boolean":
            true_count = sum(
                1 for v in values
                if v is True or str(v).lower() in ("true", "1", "yes")
            )
            total = len(values)
            results[key] = {
                **base,
                "true_count": true_count,
                "false_count": total - true_count,
                "true_pct": round(true_count / total * 100, 1) if total else 0.0,
            }

        elif ftype in ("open_ended", "text", "string"):
            results[key] = {
                **base,
                "answers": [str(v) for v in values[:300]],
                "llm_summary": None,
            }

        else:
            # multiple_choice or unknown categorical
            counts = Counter(str(v) for v in values)
            total = len(values)
            results[key] = {
                **base,
                "distribution": {
                    opt: {"count": cnt, "pct": round(cnt / total * 100, 1) if total else 0.0}
                    for opt, cnt in sorted(counts.items(), key=lambda x: -x[1])
                },
            }

    return {
        "run_id": run.id,
        "experiment_id": run.experiment_id,
        "total_tasks": run.total_tasks,
        "completed_tasks": completed_tasks,
        "drift_flagged_count": drift_flagged_count,
        "confidence_threshold": confidence_threshold,
        "fields": results,
    }


async def summarize_field_llm(
    field_key: str,
    field_data: dict,
    model: str,
    provider: str,
) -> tuple[str, int, int]:
    """
    Call LLM to summarise a field. Routes to the right prompt based on field type.
    Returns (text, tin, tout).
    """
    ftype = field_data.get("type", "string").lower()
    description = field_data.get("description", "") or field_key
    n = field_data.get("n", 0)

    if ftype in ("open_ended", "text", "string"):
        template = _load_prompt("summarize_open_ended")
        answers = field_data.get("answers", [])
        answers_text = "\n".join(f"- {a}" for a in answers[:200])
        prompt = template.format(
            field_key=field_key,
            field_description=description,
            n=n,
            answers=answers_text,
        )
    else:
        template = _load_prompt("summarize_field_stats")
        # Build a human-readable stats block
        lines: list[str] = []
        if ftype in ("scale", "number", "integer", "float"):
            lines.append(f"Mean: {field_data.get('mean')}")
            lines.append(f"Median: {field_data.get('median')}")
            lines.append(f"Std dev: {field_data.get('std')}")
            lines.append(f"Range: {field_data.get('min')} – {field_data.get('max')}")
            hist = field_data.get("histogram", [])
            if hist:
                lines.append("Distribution: " + ", ".join(f"{b['label']}: {b['count']}" for b in hist))
        elif ftype == "boolean":
            lines.append(f"True: {field_data.get('true_pct')}% ({field_data.get('true_count')})")
            lines.append(f"False: {100 - field_data.get('true_pct', 0):.1f}% ({field_data.get('false_count')})")
        else:  # multiple_choice / categorical
            dist = field_data.get("distribution", {})
            for opt, v in list(dist.items())[:10]:
                lines.append(f"  {opt}: {v['pct']}% ({v['count']})")
        stats_block = "\n".join(lines)
        prompt = template.format(
            field_key=field_key,
            field_description=description,
            field_type=ftype,
            n=n,
            stats_block=stats_block,
        )

    return await call_llm(prompt, model=model, provider=provider, temperature=0.3)


async def generate_deep_dive(
    run: Any,
    summary: dict,
    experiment_name: str,
    model: str,
    provider: str,
) -> tuple[str, int, int]:
    """Call LLM to produce a full analysis report. Returns (text, tin, tout)."""
    from datetime import timezone

    template = _load_prompt("deep_dive")

    drift_flagged = summary["drift_flagged_count"]
    completed = summary["completed_tasks"]
    drift_pct = round(drift_flagged / completed * 100, 1) if completed else 0.0
    run_date = run.created_at.strftime("%Y-%m-%d") if run.created_at else "unknown"

    # Build a readable results summary block
    lines: list[str] = []
    for key, field in summary["fields"].items():
        ftype = field.get("type", "")
        n = field.get("n", 0)
        desc = field.get("description") or key
        lines.append(f"\n### {desc} ({key})")
        lines.append(f"n={n} valid responses")

        if ftype in ("scale", "number", "integer", "float"):
            mean = field.get("mean")
            if mean is not None:
                lines.append(
                    f"Mean: {mean} | Median: {field.get('median')} | "
                    f"Std: {field.get('std')} | Range: {field.get('min')}–{field.get('max')}"
                )
        elif ftype == "boolean":
            lines.append(f"True: {field.get('true_pct')}% | False: {100 - field.get('true_pct', 0):.1f}%")
        elif ftype in ("open_ended", "text", "string"):
            summary_text = field.get("llm_summary")
            if summary_text:
                lines.append(f"Summary: {summary_text}")
            else:
                sample = field.get("answers", [])[:5]
                lines.append("Sample responses: " + " | ".join(f'"{a}"' for a in sample))
        else:
            dist = field.get("distribution", {})
            top = list(dist.items())[:5]
            lines.append(", ".join(f"{opt}: {v['pct']}%" for opt, v in top))

    results_block = "\n".join(lines)

    prompt = template.format(
        experiment_name=experiment_name,
        sample_size=run.total_tasks,
        completed=completed,
        run_date=run_date,
        drift_flagged=drift_flagged,
        drift_pct=drift_pct,
        results_summary=results_block,
    )
    return await call_llm(prompt, model=model, provider=provider, temperature=0.4)


def build_pdf_report(run: Any, summary: dict, experiment_name: str, deep_dive_text: str | None) -> bytes:
    """Generate a PDF report using fpdf2. Returns bytes."""
    from fpdf import FPDF

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # ── Header ─────────────────────────────────────────────────────────────
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 10, "Research Analysis Report", ln=True)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 7, f"Experiment: {experiment_name}", ln=True)
    run_date = run.created_at.strftime("%Y-%m-%d %H:%M UTC") if run.created_at else ""
    pdf.cell(0, 7, f"Run date: {run_date}  |  Run ID: {run.id[:8]}", ln=True)
    pdf.cell(
        0, 7,
        f"Sample size: {run.total_tasks}  |  "
        f"Completed: {summary['completed_tasks']}  |  "
        f"Drift flagged: {summary['drift_flagged_count']}",
        ln=True,
    )
    pdf.ln(5)
    pdf.set_draw_color(79, 70, 229)
    pdf.set_line_width(0.5)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(5)

    # ── Results summary ────────────────────────────────────────────────────
    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 9, "Results Summary", ln=True)
    pdf.ln(2)

    for key, field in summary["fields"].items():
        ftype = field.get("type", "")
        desc = field.get("description") or key
        n = field.get("n", 0)

        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, f"{desc} ({key})", ln=True)
        pdf.set_font("Helvetica", "", 10)
        pdf.cell(0, 6, f"n = {n} valid responses  |  type: {ftype}", ln=True)

        if ftype in ("scale", "number", "integer", "float"):
            mean = field.get("mean")
            if mean is not None:
                pdf.cell(
                    0, 6,
                    f"Mean: {mean}  |  Median: {field.get('median')}  |  "
                    f"Std: {field.get('std')}  |  Range: {field.get('min')}–{field.get('max')}",
                    ln=True,
                )
        elif ftype == "boolean":
            pdf.cell(0, 6, f"True: {field.get('true_pct')}%  |  False: {100 - field.get('true_pct', 0):.1f}%", ln=True)
        elif ftype in ("open_ended", "text", "string"):
            llm_sum = field.get("llm_summary")
            if llm_sum:
                pdf.set_font("Helvetica", "I", 10)
                pdf.multi_cell(0, 6, llm_sum)
                pdf.set_font("Helvetica", "", 10)
            else:
                sample = field.get("answers", [])[:3]
                for ans in sample:
                    short = ans[:120] + ("…" if len(ans) > 120 else "")
                    pdf.multi_cell(0, 6, f'• {short}')
        else:
            dist = field.get("distribution", {})
            for opt, v in list(dist.items())[:6]:
                pdf.cell(0, 6, f"  {opt}: {v['pct']}% ({v['count']})", ln=True)

        pdf.ln(3)

    # ── Deep dive ─────────────────────────────────────────────────────────
    if deep_dive_text:
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 14)
        pdf.cell(0, 9, "AI Analysis", ln=True)
        pdf.ln(2)
        pdf.set_font("Helvetica", "", 10)
        # Strip markdown headers/bullets for plain PDF text
        for line in deep_dive_text.splitlines():
            clean = line.lstrip("#").lstrip("*").lstrip("-").strip()
            if not clean:
                pdf.ln(3)
                continue
            if line.startswith("##"):
                pdf.set_font("Helvetica", "B", 11)
                pdf.cell(0, 7, clean, ln=True)
                pdf.set_font("Helvetica", "", 10)
            else:
                pdf.multi_cell(0, 6, clean)

    return bytes(pdf.output())
