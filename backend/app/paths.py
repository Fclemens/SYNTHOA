"""
Where the app reads its bundled files and writes user data.

* Source checkout: data stays where it always was (backend/), and the
  frontend is served from frontend/out when it has been built with
  STATIC_EXPORT=1.
* Packaged exe (PyInstaller one-folder): bundled files live in ``_internal``
  (``sys._MEIPASS``); everything the user creates lives in ``data\\`` next to
  ``SYNTHOA.exe``, so the whole folder stays portable.
"""
from __future__ import annotations
import shutil
import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
BACKEND_DIR = Path(__file__).resolve().parent.parent

# Read-only files shipped with the app: default prompts, the built frontend.
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", BACKEND_DIR))
WEB_DIR = RESOURCE_DIR / "web" if FROZEN else BACKEND_DIR.parent / "frontend" / "out"

# Writable: database, settings_override.json, editable prompts, logs.
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else BACKEND_DIR
DATA_DIR = APP_DIR / "data" if FROZEN else BACKEND_DIR
PROMPTS_DIR = DATA_DIR / "prompts"
OVERRIDE_FILE = DATA_DIR / "settings_override.json"
DEFAULT_DATABASE_URL = (
    f"sqlite+aiosqlite:///{(DATA_DIR / 'synthoa.db').as_posix()}" if FROZEN
    else "sqlite+aiosqlite:///./genai_simulator.db"
)


def ensure_data_dir() -> None:
    """First run of the exe: create data\\ and seed the editable prompt templates."""
    if not FROZEN:
        return
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    for src in (RESOURCE_DIR / "prompts").glob("*.txt"):
        if not (PROMPTS_DIR / src.name).exists():
            shutil.copy(src, PROMPTS_DIR / src.name)
