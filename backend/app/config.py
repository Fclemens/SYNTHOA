from __future__ import annotations
import json
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


# Path to the mutable overrides sidecar (outside version control)
_OVERRIDE_FILE = Path(__file__).parent.parent / "settings_override.json"


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
    # Empty string for backstory/validation falls back to provider_pass2.
    provider_pass1: str = "openai"
    provider_pass2: str = "openai"
    provider_backstory: str = ""     # "" → inherit from provider_pass2
    provider_validation: str = ""    # "" → inherit from provider_pass2
    provider_insights: str = ""      # "" → inherit from provider_pass2

    # ── Per-step model selection ──────────────────────────────────────────────
    model_pass1: str = "gpt-4o"           # Pass 1: respondent interview
    model_pass2: str = "gpt-4o-mini"      # Pass 2: dual extraction
    model_backstory: str = ""             # "" → inherit from model_pass2
    model_validation: str = ""            # "" → inherit from model_pass2
    model_insights: str = ""              # "" → inherit from model_pass2

    # ── Database ──────────────────────────────────────────────────────────────
    database_url: str = "sqlite+aiosqlite:///./genai_simulator.db"

    # ── Execution ─────────────────────────────────────────────────────────────
    max_concurrent_tasks: int = 10
    tpm_limit: int = 2_000_000

    # ── Quality ───────────────────────────────────────────────────────────────
    plausibility_threshold: float = 0.5
    max_context_tokens: int = 100_000

    # ── Token pricing per 1M tokens {model: {input: $, output: $}} ───────────
    model_pricing: dict[str, dict[str, float]] = Field(default_factory=lambda: {
        "gpt-4o":               {"input": 2.50,  "output": 10.00},
        "gpt-4o-mini":          {"input": 0.15,  "output": 0.60},
        "gpt-4.1":              {"input": 2.00,  "output": 8.00},
        "gpt-4.1-mini":         {"input": 0.40,  "output": 1.60},
        "claude-opus-4-5":      {"input": 15.00, "output": 75.00},
        "claude-sonnet-4-5":    {"input": 3.00,  "output": 15.00},
        "claude-haiku-3-5":     {"input": 0.80,  "output": 4.00},
        "default":              {"input": 0.0,   "output": 0.0},
    })

    # ── Derived helpers ───────────────────────────────────────────────────────

    @property
    def effective_backstory_model(self) -> str:
        return self.model_backstory or self.model_pass2

    @property
    def effective_validation_model(self) -> str:
        return self.model_validation or self.model_pass2

    @property
    def effective_backstory_provider(self) -> str:
        return self.provider_backstory or self.provider_pass2

    @property
    def effective_validation_provider(self) -> str:
        return self.provider_validation or self.provider_pass2

    @property
    def effective_insights_model(self) -> str:
        return self.model_insights or self.model_pass2

    @property
    def effective_insights_provider(self) -> str:
        return self.provider_insights or self.provider_pass2


settings = Settings()


def load_overrides() -> None:
    """Apply settings_override.json on top of env defaults (called at startup)."""
    if not _OVERRIDE_FILE.exists():
        return
    try:
        data = json.loads(_OVERRIDE_FILE.read_text(encoding="utf-8"))
        for key, value in data.items():
            if hasattr(settings, key):
                object.__setattr__(settings, key, value)
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning(f"Could not load settings_override.json: {exc}")


def save_overrides(patch: dict) -> None:
    """Merge patch into settings_override.json and update live settings."""
    existing: dict = {}
    if _OVERRIDE_FILE.exists():
        try:
            existing = json.loads(_OVERRIDE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    existing.update(patch)
    _OVERRIDE_FILE.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    # Apply immediately to the live settings object
    for key, value in patch.items():
        if hasattr(settings, key):
            object.__setattr__(settings, key, value)
