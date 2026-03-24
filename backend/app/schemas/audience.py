from __future__ import annotations
from datetime import datetime
from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, model_validator


# ── Distribution configs ────────────────────────────────────────────────────

class NormalDist(BaseModel):
    type: Literal["normal"]
    mean: float
    std: float
    min_clip: Optional[float] = None
    max_clip: Optional[float] = None


class LogNormalDist(BaseModel):
    type: Literal["log_normal"]
    real_mean: float
    real_std: float
    min_clip: Optional[float] = None
    max_clip: Optional[float] = None


class UniformDist(BaseModel):
    type: Literal["uniform"]
    min: float
    max: float


class TriangularDist(BaseModel):
    type: Literal["triangular"]
    min: float
    max: float
    mode: float


class BetaDist(BaseModel):
    type: Literal["beta"]
    alpha: float
    beta: float


class ExponentialDist(BaseModel):
    type: Literal["exponential"]
    lambda_: float = Field(alias="lambda")
    max_clip: Optional[float] = None

    model_config = ConfigDict(populate_by_name=True)


class GammaDist(BaseModel):
    type: Literal["gamma"]
    alpha: float
    beta: float
    max_clip: Optional[float] = None


class TruncatedNormalDist(BaseModel):
    """Normal distribution bounded by hard min/max — ideal for age, income brackets, etc."""
    type: Literal["truncated_normal"]
    mean: float
    std: float
    min: float
    max: float


class PoissonDist(BaseModel):
    """Discrete count distribution — ideal for household size, purchases/month, etc."""
    type: Literal["poisson"]
    lambda_: float = Field(alias="lambda", gt=0)

    model_config = ConfigDict(populate_by_name=True)


class WeibullDist(BaseModel):
    """Lifetime / time-to-event distribution — ideal for churn, tenure, etc."""
    type: Literal["weibull"]
    shape: float = Field(gt=0)   # k  (shape < 1 → infant mortality, > 1 → wear-out)
    scale: float = Field(gt=0)   # λ  (characteristic lifetime)
    max_clip: Optional[float] = None


class CategoricalOption(BaseModel):
    label: str
    weight: float = 1.0


class CategoricalDist(BaseModel):
    type: Literal["categorical"]
    options: list[CategoricalOption]


class OrdinalDist(BaseModel):
    """Ordered categorical — participates in the Gaussian copula via threshold discretisation.
    Options must be listed from lowest to highest rank (e.g. ['None', 'High School', 'Bachelor']).
    Sampling is uniform across ranks; correlations work identically to continuous variables."""
    type: Literal["ordinal"]
    options: list[str]


DistributionConfig = Union[
    NormalDist, LogNormalDist, UniformDist, TriangularDist,
    BetaDist, ExponentialDist, GammaDist,
    TruncatedNormalDist, PoissonDist, WeibullDist,
    CategoricalDist, OrdinalDist,
]


# ── AudienceVariable ─────────────────────────────────────────────────────────

class AudienceVariableCreate(BaseModel):
    name: str
    var_type: Literal["continuous", "categorical", "ordinal"]
    distribution: dict[str, Any]
    sort_order: int = 0


class AudienceVariableUpdate(BaseModel):
    name: Optional[str] = None
    var_type: Optional[Literal["continuous", "categorical", "ordinal"]] = None
    distribution: Optional[dict[str, Any]] = None
    sort_order: Optional[int] = None


class AudienceVariableOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    audience_id: str
    name: str
    var_type: str
    distribution: dict[str, Any]
    sort_order: int


# ── Correlations ─────────────────────────────────────────────────────────────

class CorrelationEntry(BaseModel):
    var_a_id: str
    var_b_id: str
    correlation: float = Field(ge=-1.0, le=1.0)


class CorrelationUpsert(BaseModel):
    correlations: list[CorrelationEntry]


# ── ConditionalRule ───────────────────────────────────────────────────────────

class ConditionalRuleCreate(BaseModel):
    condition_expr: dict[str, Any]  # {"var": "age", "op": "<", "value": 25}
    target_var_id: str
    override_dist: dict[str, Any]
    priority: int = 0


class ConditionalRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    audience_id: str
    condition_expr: dict[str, Any]
    target_var_id: str
    override_dist: dict[str, Any]
    priority: int


# ── Audience ──────────────────────────────────────────────────────────────────

class AudienceCreate(BaseModel):
    name: str
    description: Optional[str] = None
    backstory_prompt_template: Optional[str] = None


class AudienceUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    backstory_prompt_template: Optional[str] = None


class AudienceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    description: Optional[str]
    backstory_prompt_template: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    variables: list[AudienceVariableOut] = []


# ── Persona ───────────────────────────────────────────────────────────────────

class PersonaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    audience_id: str
    traits_json: dict[str, Any]
    backstory: Optional[str]
    plausibility: Optional[float]
    flagged: bool
    created_at: datetime


class SampleRequest(BaseModel):
    n: int = Field(ge=1, le=10000, default=100)
    validate_plausibility: bool = True
    llm_validation: bool = False
    reuse_existing: bool = False
    backstory_mode: Literal["none", "template", "llm"] = "llm"


class SamplingJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    audience_id: str
    status: str
    n_requested: int
    n_completed: int
    backstory_mode: str
    validate_plausibility: bool
    llm_validation: bool
    created_at: datetime
    completed_at: Optional[datetime]
    error: Optional[str]


# ── Export / Import bundle ────────────────────────────────────────────────────

class ExportAudienceMeta(BaseModel):
    name: str
    description: Optional[str] = None
    backstory_prompt_template: Optional[str] = None


class ExportVariable(BaseModel):
    name: str
    var_type: Literal["continuous", "categorical"]
    distribution: dict[str, Any]
    sort_order: int = 0


class ExportCorrelation(BaseModel):
    var_a_name: str
    var_b_name: str
    correlation: float = Field(ge=-1.0, le=1.0)


class ExportPersona(BaseModel):
    traits_json: dict[str, Any]
    backstory: Optional[str] = None
    plausibility: Optional[float] = None
    flagged: bool = False


class AudienceExportBundle(BaseModel):
    version: str = "1"
    exported_at: Optional[str] = None
    audience: ExportAudienceMeta
    variables: list[ExportVariable] = []
    correlations: list[ExportCorrelation] = []
    personas: list[ExportPersona] = []


class AudienceImportResult(BaseModel):
    audience_id: str
    name: str
    variables_imported: int
    correlations_imported: int
    personas_imported: int
