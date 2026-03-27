from __future__ import annotations
import warnings
from datetime import datetime
from typing import Any, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field

# Suppress the false-positive "schema_json shadows BaseModel.schema_json" warning
# (schema_json() was removed in Pydantic v2; the field name is fine)
warnings.filterwarnings("ignore", message=".*schema_json.*shadows.*", category=UserWarning)


# ── ExperimentDistVariable ────────────────────────────────────────────────────

class ExperimentDistVariableCreate(BaseModel):
    name: str
    var_type: Literal["continuous", "categorical"]
    distribution: dict[str, Any]
    sort_order: int = 0


class ExperimentDistVariableUpdate(BaseModel):
    name: Optional[str] = None
    var_type: Optional[Literal["continuous", "categorical"]] = None
    distribution: Optional[dict[str, Any]] = None
    sort_order: Optional[int] = None


class ExperimentDistVariableOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    experiment_id: str
    name: str
    var_type: str
    distribution: dict[str, Any]
    sort_order: int


# ── ExperimentVariable ───────────────────────────────────────────────────────

class AttributeWeight(BaseModel):
    value: str
    weight: float = 1.0


class ExperimentVariableCreate(BaseModel):
    placeholder: str
    attributes: list[AttributeWeight]


class ExperimentVariableOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    experiment_id: str
    placeholder: str
    attributes: list[dict[str, Any]]


# ── Question ──────────────────────────────────────────────────────────────────

class QuestionCreate(BaseModel):
    sort_order: int
    question_type: Literal["scale", "single_choice", "multiple_choice", "open_ended"]
    question_text: str
    scale_min: Optional[int] = None
    scale_max: Optional[int] = None
    scale_anchor_low: Optional[str] = None
    scale_anchor_high: Optional[str] = None
    choices: Optional[list[str]] = None
    ask_why: bool = False
    prompting_mode: Optional[Literal["pooled", "dedicated"]] = None


class QuestionUpdate(BaseModel):
    sort_order: Optional[int] = None
    question_type: Optional[Literal["scale", "single_choice", "multiple_choice", "open_ended"]] = None
    question_text: Optional[str] = None
    scale_min: Optional[int] = None
    scale_max: Optional[int] = None
    scale_anchor_low: Optional[str] = None
    scale_anchor_high: Optional[str] = None
    choices: Optional[list[str]] = None
    ask_why: Optional[bool] = None
    prompting_mode: Optional[Literal["pooled", "dedicated"]] = None


class QuestionReorder(BaseModel):
    order: list[str]  # list of question IDs in new order


class QuestionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    experiment_id: str
    sort_order: int
    question_type: str
    question_text: str
    scale_min: Optional[int]
    scale_max: Optional[int]
    scale_anchor_low: Optional[str]
    scale_anchor_high: Optional[str]
    choices: Optional[list[Any]]
    ask_why: bool
    prompting_mode: Optional[str]


# ── OutputSchema ──────────────────────────────────────────────────────────────

class OutputSchemaField(BaseModel):
    key: str
    type: Literal["boolean", "integer", "float", "string", "scale"]
    description: Optional[str] = None


class OutputSchemaCreate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    schema_json: list[OutputSchemaField] = []  # type: ignore[assignment]


class OutputSchemaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())
    id: str
    experiment_id: str
    schema_json: list[dict[str, Any]] = []  # type: ignore[assignment]
    version: int
    created_at: datetime


# ── Experiment ────────────────────────────────────────────────────────────────

class ExperimentCreate(BaseModel):
    audience_id: str
    name: str
    global_context: str = ""
    execution_mode: Literal["pooled", "dedicated"] = "pooled"
    drift_detection_enabled: bool = True


class ExperimentUpdate(BaseModel):
    audience_id: Optional[str] = None
    name: Optional[str] = None
    global_context: Optional[str] = None
    execution_mode: Optional[Literal["pooled", "dedicated"]] = None
    drift_detection_enabled: Optional[bool] = None


class ExperimentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    audience_id: str
    name: str
    global_context: str
    execution_mode: str
    drift_detection_enabled: bool
    created_at: datetime
    variables: list[ExperimentVariableOut] = []
    dist_variables: list[ExperimentDistVariableOut] = []
    questions: list[QuestionOut] = []
    output_schemas: list[OutputSchemaOut] = []


# ── Pre-flight ────────────────────────────────────────────────────────────────

class PreflightRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    sample_size: int = Field(ge=1, le=500, default=5)
    model_pass1: Optional[str] = None   # None → resolved to settings.model_pass1 in router
    model_pass2: Optional[str] = None   # None → resolved to settings.model_pass2 in router
    dual_extraction: bool = True


class ResolvedQuestion(BaseModel):
    text: str
    type: str
    ask_why: bool


class PersonaPayload(BaseModel):
    persona_traits: dict[str, Any]
    backstory_preview: str
    resolved_variables: dict[str, str]
    questions: list[ResolvedQuestion]


class TokenEstimate(BaseModel):
    pass1_input_tokens: int
    pass1_output_tokens: int
    pass2_input_tokens: int
    pass2_output_tokens: int


class CostEstimate(BaseModel):
    pass1_total: float
    pass2_total: float
    grand_total: float
    per_persona: float


class PreflightReport(BaseModel):
    payloads: list[PersonaPayload]
    variable_distributions: dict[str, dict[str, int]]
    token_estimate: TokenEstimate
    cost_estimate: CostEstimate
    sample_size: int


# ── Experiment Protocol Import / Export ───────────────────────────────────────

class ExperimentProtocolVariable(BaseModel):
    placeholder: str
    attributes: list[dict[str, Any]]


class ExperimentProtocolDistVariable(BaseModel):
    name: str
    var_type: str
    distribution: dict[str, Any]
    sort_order: int = 0


class ExperimentProtocolQuestion(BaseModel):
    sort_order: int
    question_type: str
    question_text: str
    scale_min: Optional[int] = None
    scale_max: Optional[int] = None
    choices: Optional[list[str]] = None
    ask_why: bool = False
    prompting_mode: Optional[str] = None


class ExperimentProtocolMeta(BaseModel):
    name: str
    global_context: str = ""
    execution_mode: str = "pooled"


class ExperimentProtocolBundle(BaseModel):
    """Portable, audience-agnostic snapshot of an experiment protocol."""
    version: str = "1.0"
    exported_at: Optional[str] = None
    experiment: ExperimentProtocolMeta
    variables: list[ExperimentProtocolVariable] = []
    dist_variables: list[ExperimentProtocolDistVariable] = []
    questions: list[ExperimentProtocolQuestion] = []
    output_schema: list[dict[str, Any]] = []   # [{key, type, description?}]


class ExperimentImportRequest(BaseModel):
    audience_id: str          # target audience for the imported experiment
    bundle: ExperimentProtocolBundle


class ExperimentImportResult(BaseModel):
    experiment_id: str
    name: str
    variables_imported: int
    dist_variables_imported: int
    questions_imported: int
    output_schema_imported: bool


# ── Preview Interview ─────────────────────────────────────────────────────────

class PreviewInterviewRequest(BaseModel):
    persona_id: str
    model: str = "gpt-4o"
    dual_extraction: bool = False


class PreviewInterviewResult(BaseModel):
    persona_id: str
    assembled_prompt: str  # exact prompt/messages sent — for debugging
    transcript: str
    extracted_json: Optional[dict[str, Any]]
    extraction_confidence: Optional[dict[str, float]]
    pass1_tokens_in: int
    pass1_tokens_out: int
    pass1_cost_usd: float
