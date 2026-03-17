from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models.experiment import Question
from ..models.simulation import CalibrationBenchmark, CalibrationStatus, SimulationRun, SimulationTask
from ..schemas.simulation import CalibrateRequest, CalibrationBenchmarkOut, CalibrationStatusOut

router = APIRouter(prefix="/api/experiments", tags=["calibration"])


def _compute_js_divergence(
    question_type: str,
    real_responses: list,
    synthetic_responses: list,
    scale_min: int = 1,
    scale_max: int = 10,
) -> float:
    """Compute Jensen-Shannon divergence between two response distributions."""
    import numpy as np
    from scipy.spatial.distance import jensenshannon

    eps = 1e-10

    if question_type == "scale":
        bins = list(range(scale_min, scale_max + 2))
        real_hist, _ = np.histogram(real_responses, bins=bins, density=True)
        synth_hist, _ = np.histogram(synthetic_responses, bins=bins, density=True)
        real_hist = real_hist + eps
        synth_hist = synth_hist + eps
        return float(jensenshannon(real_hist, synth_hist))

    elif question_type == "multiple_choice":
        all_choices = sorted(set(str(r) for r in real_responses) | set(str(r) for r in synthetic_responses))
        real_freq = np.array([real_responses.count(c) / max(len(real_responses), 1) for c in all_choices])
        synth_freq = np.array([synthetic_responses.count(c) / max(len(synthetic_responses), 1) for c in all_choices])
        return float(jensenshannon(real_freq + eps, synth_freq + eps))

    elif question_type == "open_ended":
        # Simple length-distribution proxy (embedding-based is out of scope for MVP)
        real_lengths = [len(str(r).split()) for r in real_responses]
        synth_lengths = [len(str(r).split()) for r in synthetic_responses]
        max_len = max(max(real_lengths, default=1), max(synth_lengths, default=1)) + 1
        bins = list(range(0, max_len + 10, max(1, max_len // 10)))
        real_hist, _ = np.histogram(real_lengths, bins=bins, density=True)
        synth_hist, _ = np.histogram(synth_lengths, bins=bins, density=True)
        return float(jensenshannon(real_hist + eps, synth_hist + eps))

    return 0.5  # fallback


def _update_calibration_level(benchmarks: list[CalibrationBenchmark]) -> str:
    if not benchmarks:
        return "uncalibrated"
    js_scores = [b.js_divergence for b in benchmarks]
    if all(s < 0.15 for s in js_scores):
        return "calibrated"
    elif all(s < 0.35 for s in js_scores):
        return "directional"
    return "uncalibrated"


@router.post("/{experiment_id}/calibrate", status_code=201)
async def add_calibration_data(
    experiment_id: str, body: CalibrateRequest, db: AsyncSession = Depends(get_db)
):
    question = await db.get(Question, body.question_id)
    if not question or question.experiment_id != experiment_id:
        raise HTTPException(status_code=404, detail="Question not found")

    # Gather synthetic responses for this experiment's completed tasks only
    tasks_result = await db.execute(
        select(SimulationTask)
        .join(SimulationTask.run)
        .where(SimulationRun.experiment_id == experiment_id)
        .where(SimulationTask.pass2_status == "completed")
    )
    tasks = tasks_result.scalars().all()
    synthetic_responses = []
    for task in tasks:
        if task.extracted_json:
            # Look up by output schema field key (not question UUID)
            val = task.extracted_json.get(body.field_key)
            if val is not None:
                synthetic_responses.append(val)

    if not synthetic_responses:
        raise HTTPException(
            status_code=400,
            detail="No synthetic responses available. Run a simulation first."
        )

    js = _compute_js_divergence(
        question_type=question.question_type,
        real_responses=body.real_responses,
        synthetic_responses=synthetic_responses,
        scale_min=question.scale_min or 1,
        scale_max=question.scale_max or 10,
    )

    benchmark = CalibrationBenchmark(
        id=str(uuid.uuid4()),
        experiment_id=experiment_id,
        question_id=body.question_id,
        real_distribution=body.real_responses,
        synthetic_distribution=synthetic_responses,
        js_divergence=js,
        sample_size_real=len(body.real_responses),
        sample_size_synthetic=len(synthetic_responses),
    )
    db.add(benchmark)

    # Update calibration status
    all_benchmarks_result = await db.execute(
        select(CalibrationBenchmark).where(CalibrationBenchmark.experiment_id == experiment_id)
    )
    all_benchmarks = all_benchmarks_result.scalars().all() + [benchmark]
    level = _update_calibration_level(all_benchmarks)

    cal_status = await db.get(CalibrationStatus, experiment_id)
    if cal_status:
        cal_status.level = level
        cal_status.last_calibrated = datetime.now(timezone.utc)
    else:
        cal_status = CalibrationStatus(
            experiment_id=experiment_id,
            level=level,
            last_calibrated=datetime.now(timezone.utc),
        )
        db.add(cal_status)

    await db.commit()
    await db.refresh(benchmark)
    return {"benchmark": benchmark, "calibration_level": level, "js_divergence": js}


@router.get("/{experiment_id}/calibration", response_model=CalibrationStatusOut)
async def get_calibration(experiment_id: str, db: AsyncSession = Depends(get_db)):
    cal = await db.get(CalibrationStatus, experiment_id)
    benchmarks_result = await db.execute(
        select(CalibrationBenchmark).where(CalibrationBenchmark.experiment_id == experiment_id)
    )
    benchmarks = benchmarks_result.scalars().all()

    if not cal:
        return CalibrationStatusOut(
            experiment_id=experiment_id,
            level="uncalibrated",
            last_calibrated=None,
            notes=None,
            benchmarks=[CalibrationBenchmarkOut.model_validate(b) for b in benchmarks],
        )

    return CalibrationStatusOut(
        experiment_id=experiment_id,
        level=cal.level,
        last_calibrated=cal.last_calibrated,
        notes=cal.notes,
        benchmarks=[CalibrationBenchmarkOut.model_validate(b) for b in benchmarks],
    )
