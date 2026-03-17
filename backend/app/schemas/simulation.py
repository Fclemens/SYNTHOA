from __future__ import annotations
from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field


# ── Launch ────────────────────────────────────────────────────────────────────

class LaunchRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    population_size: int = Field(ge=1, le=100000, default=100)
    model_pass1: Optional[str] = None   # None = use current settings default
    model_pass2: Optional[str] = None   # None = use current settings default
    dual_extraction: bool = True
    persona_ids: Optional[list[str]] = None   # explicit list overrides everything
    sample_fresh: bool = False                 # True = always generate new personas


# ── SimulationRun ─────────────────────────────────────────────────────────────

class SimulationRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())
    id: str
    experiment_id: str
    model_pass1: str
    model_pass2: str
    status: str
    total_tasks: int
    completed_tasks: int
    failed_tasks: int
    total_cost_usd: float
    created_at: datetime
    completed_at: Optional[datetime]


# ── SimulationTask ────────────────────────────────────────────────────────────

class SimulationTaskSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    run_id: str
    persona_id: str
    injected_vars: dict[str, Any]
    pass1_status: str
    pass2_status: str
    drift_flagged: bool
    pass1_cost_usd: Optional[float]
    pass2_cost_usd: Optional[float]


class SimulationTaskDetail(SimulationTaskSummary):
    pass1_prompt: Optional[str]
    raw_transcript: Optional[str]
    pass1_tokens_in: Optional[int]
    pass1_tokens_out: Optional[int]
    pass1_error: Optional[str]
    drift_scores: Optional[list[Any]]
    extracted_json: Optional[dict[str, Any]]
    extraction_confidence: Optional[dict[str, float]]
    extraction_disagreements: Optional[dict[str, Any]]
    pass2_tokens_in: Optional[int]
    pass2_tokens_out: Optional[int]
    pass2_error: Optional[str]


# ── Calibration ───────────────────────────────────────────────────────────────

class CalibrateRequest(BaseModel):
    question_id: str    # identifies the question → used for type / scale_min / scale_max
    field_key: str      # output schema field key → used to look up extracted_json values
    real_responses: list[Any]


class CalibrationBenchmarkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    experiment_id: str
    question_id: str
    js_divergence: float
    sample_size_real: int
    sample_size_synthetic: int
    created_at: datetime


class CalibrationStatusOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    experiment_id: str
    level: str  # "uncalibrated" | "directional" | "calibrated"
    last_calibrated: Optional[datetime]
    notes: Optional[str]
    benchmarks: list[CalibrationBenchmarkOut] = []


# ── Re-extract ────────────────────────────────────────────────────────────────

class ReExtractRequest(BaseModel):
    schema_version: Optional[int] = None  # None = latest
