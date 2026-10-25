"""
GET /api/settings  — read current model + execution settings
PUT /api/settings  — update (persisted to settings_override.json)
"""
from __future__ import annotations
from typing import Literal, Optional
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..config import settings, save_overrides

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class AppSettingsOut(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    # ── API Keys & Endpoints (keys are never echoed — only set status) ────────
    openai_api_key_set: bool
    lmstudio_base_url: str
    anthropic_api_key_set: bool

    # ── Per-step provider + model ─────────────────────────────────────────────
    provider_pass1: str
    model_pass1: str

    provider_pass2: str
    model_pass2: str

    provider_backstory: str          # "" → inherit from pass2
    model_backstory: str             # "" → inherit from model_pass2
    effective_backstory_provider: str
    effective_backstory_model: str

    provider_insights: str           # "" → inherit from pass2
    model_insights: str              # "" → inherit from model_pass2
    effective_insights_provider: str
    effective_insights_model: str

    # ── Execution ─────────────────────────────────────────────────────────────
    max_concurrent_tasks: int
    tpm_limit: int
    max_context_tokens: int

    # ── Pricing ───────────────────────────────────────────────────────────────
    model_pricing: dict[str, dict[str, float]]


class AppSettingsUpdate(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    # API Keys — write-only fields; send "" to clear
    openai_api_key: Optional[str] = None
    lmstudio_base_url: Optional[str] = None
    anthropic_api_key: Optional[str] = None

    # Per-step provider + model
    provider_pass1: Optional[Literal["openai", "lmstudio", "anthropic"]] = None
    model_pass1: Optional[str] = None

    provider_pass2: Optional[Literal["openai", "lmstudio", "anthropic"]] = None
    model_pass2: Optional[str] = None

    provider_backstory: Optional[Literal["", "openai", "lmstudio", "anthropic"]] = None
    model_backstory: Optional[str] = None

    provider_insights: Optional[Literal["", "openai", "lmstudio", "anthropic"]] = None
    model_insights: Optional[str] = None

    # Execution
    max_concurrent_tasks: Optional[int] = Field(None, ge=1, le=100)
    tpm_limit: Optional[int] = Field(None, ge=1000)
    max_context_tokens: Optional[int] = Field(None, ge=1000)

    # Pricing
    model_pricing: Optional[dict[str, dict[str, float]]] = None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("", response_model=AppSettingsOut)
async def get_settings():
    return AppSettingsOut(
        openai_api_key_set=bool(settings.openai_api_key and settings.openai_api_key != "not-set"),
        lmstudio_base_url=settings.lmstudio_base_url,
        anthropic_api_key_set=bool(settings.anthropic_api_key),
        provider_pass1=settings.provider_pass1,
        model_pass1=settings.model_pass1,
        provider_pass2=settings.provider_pass2,
        model_pass2=settings.model_pass2,
        provider_backstory=settings.provider_backstory,
        model_backstory=settings.model_backstory,
        effective_backstory_provider=settings.step_provider("backstory"),
        effective_backstory_model=settings.step_model("backstory"),
        provider_insights=settings.provider_insights,
        model_insights=settings.model_insights,
        effective_insights_provider=settings.step_provider("insights"),
        effective_insights_model=settings.step_model("insights"),
        max_concurrent_tasks=settings.max_concurrent_tasks,
        tpm_limit=settings.tpm_limit,
        max_context_tokens=settings.max_context_tokens,
        model_pricing=settings.model_pricing,
    )


@router.put("", response_model=AppSettingsOut)
async def update_settings(body: AppSettingsUpdate):
    patch = body.model_dump(exclude_none=True)
    if patch:
        save_overrides(patch)
    return await get_settings()
