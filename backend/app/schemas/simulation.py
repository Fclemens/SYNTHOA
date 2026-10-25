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
    batch_mode: bool = False                   # True = provider Batch API (50% cheaper, up to 24h)


# ── SimulationRun ─────────────────────────────────────────────────────────────

class SimulationRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())
    id: str
    experiment_id: str
    experiment_name: Optional[str] = None
    run_number: Optional[int] = None
    name: Optional[str] = None
    execution_mode: str = "pooled"
    dual_extraction: bool = True
    batch_mode: bool = False
    batch_state: Optional[dict] = None
    model_pass1: str
    model_pass2: str
    status: str
    total_tasks: int
    completed_tasks: int
    failed_tasks: int
    total_cost_usd: float
    created_at: datetime
    completed_at: Optional[datetime]


class RunUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=120)


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
    pass1_error: Optional[str]
    pass2_error: Optional[str]


class SimulationTaskDetail(SimulationTaskSummary):
    persona_traits: dict[str, Any] = {}
    persona_backstory: Optional[str] = None
    pass1_prompt: Optional[str]
    raw_transcript: Optional[str]
    pass1_tokens_in: Optional[int]
    pass1_tokens_out: Optional[int]
    drift_scores: Optional[list[Any]]
    extracted_json: Optional[dict[str, Any]]
    extraction_confidence: Optional[dict[str, float]]
    extraction_disagreements: Optional[dict[str, Any]]
    pass2_tokens_in: Optional[int]
    pass2_tokens_out: Optional[int]


# ── Re-extract ────────────────────────────────────────────────────────────────

class ReExtractRequest(BaseModel):
    schema_version: Optional[int] = None  # None = latest
