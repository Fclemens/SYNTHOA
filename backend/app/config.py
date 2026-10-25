from __future__ import annotations
import json
import logging
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

# Path to the mutable overrides sidecar (outside version control)
_OVERRIDE_FILE = Path(__file__).parent.parent / "settings_override.json"

# Steps whose provider/model may be left blank to inherit from Pass 2.
INHERITING_STEPS = ("backstory", "insights")

# ── Token pricing per 1M tokens {model: {input: $, output: $}} ────────────────
# Standard-tier list prices as of Oct 2026. OpenAI: GPT-5.5 / 5.5-pro from the
# official model pages; GPT-5.6 and GPT-5.4 tiers from third-party price
# trackers (consistent across sources). Anthropic: official model table.
# Long-context surcharges (>272K input tokens on OpenAI) are not modelled.
DEFAULT_MODEL_PRICING: dict[str, dict[str, float]] = {
    "gpt-5.6-sol":       {"input": 5.00,  "output": 30.00},
    "gpt-5.6-terra":     {"input": 2.00,  "output": 12.00},
    "gpt-5.6-luna":      {"input": 0.20,  "output": 1.20},
    "gpt-5.5":           {"input": 5.00,  "output": 30.00},
    "gpt-5.5-pro":       {"input": 30.00, "output": 180.00},
    "gpt-5.4":           {"input": 2.50,  "output": 15.00},
    "gpt-5.4-mini":      {"input": 0.75,  "output": 4.50},
    "gpt-5.4-nano":      {"input": 0.20,  "output": 1.25},
    "claude-fable-5-1":  {"input": 10.00, "output": 50.00},
    "claude-opus-5-5":   {"input": 4.00,  "output": 20.00},
    "claude-sonnet-5-5": {"input": 2.00,  "output": 10.00},
    "claude-haiku-5-5":  {"input": 0.10,  "output": 0.50},
    "default":           {"input": 0.0,   "output": 0.0},
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore",
        protected_namespaces=("settings_",),
    )

    # ── API Keys & Endpoints ──────────────────────────────────────────────────
    # OpenAI-compatible (OpenAI direct, LM Studio, Ollama, vLLM …)
    openai_api_key: str = "not-set"

    # LM Studio / Ollama / vLLM — custom base URL for OpenAI-compatible servers
    lmstudio_base_url: str = "http://127.0.0.1:1234/v1"

    # Anthropic direct API
    anthropic_api_key: str = ""

    # ── Per-step provider selection ───────────────────────────────────────────
    # Values: "openai" | "lmstudio" | "anthropic"
    # Empty string for backstory/insights falls back to provider_pass2.
    provider_pass1: str = "openai"
    provider_pass2: str = "openai"
    provider_backstory: str = ""
    provider_insights: str = ""

    # ── Per-step model selection ──────────────────────────────────────────────
    model_pass1: str = "gpt-5.4"          # Pass 1: respondent interview
    model_pass2: str = "gpt-5.4-mini"     # Pass 2: dual extraction
    model_backstory: str = ""             # "" → inherit from model_pass2
    model_insights: str = ""              # "" → inherit from model_pass2

    # ── Database / server ─────────────────────────────────────────────────────
    database_url: str = "sqlite+aiosqlite:///./genai_simulator.db"
    cors_origins: str = (
        "http://localhost:3000,http://127.0.0.1:3000,"
        "http://localhost:3001,http://127.0.0.1:3001"
    )

    # ── Execution ─────────────────────────────────────────────────────────────
    max_concurrent_tasks: int = 10
    tpm_limit: int = 2_000_000
    max_context_tokens: int = 100_000

    model_pricing: dict[str, dict[str, float]] = Field(
        default_factory=lambda: dict(DEFAULT_MODEL_PRICING)
    )

    # ── Derived helpers ───────────────────────────────────────────────────────

    def step_model(self, step: str) -> str:
        """Model for a pipeline step; backstory/insights inherit from Pass 2 when blank."""
        return getattr(self, f"model_{step}") or self.model_pass2

    def step_provider(self, step: str) -> str:
        return getattr(self, f"provider_{step}") or self.provider_pass2

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()

# Keys that used to exist in settings_override.json and are now ignored.
_LEGACY_KEYS = {"provider_validation", "model_validation", "plausibility_threshold"}


def _apply(data: dict) -> None:
    for key, value in data.items():
        if key in _LEGACY_KEYS or not hasattr(settings, key):
            continue
        if key == "model_pricing" and isinstance(value, dict):
            # Overrides add to / replace entries — they never hide newer defaults.
            value = {**DEFAULT_MODEL_PRICING, **value}
        object.__setattr__(settings, key, value)


def load_overrides() -> None:
    """Apply settings_override.json on top of env defaults (called at startup)."""
    if not _OVERRIDE_FILE.exists():
        return
    try:
        _apply(json.loads(_OVERRIDE_FILE.read_text(encoding="utf-8")))
    except Exception as exc:
        logger.warning(f"Could not load settings_override.json: {exc}")


def save_overrides(patch: dict) -> None:
    """Merge patch into settings_override.json and update live settings."""
    existing: dict = {}
    if _OVERRIDE_FILE.exists():
        try:
            existing = json.loads(_OVERRIDE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    existing.update(patch)
    for key in _LEGACY_KEYS:
        existing.pop(key, None)
    _OVERRIDE_FILE.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    _apply(patch)
