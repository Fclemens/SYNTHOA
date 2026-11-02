# PyInstaller spec: one-folder build of the desktop app ("SYNTHOA.exe").
# Build with BUILD_EXE.bat (or build.ps1), not by hand: it builds the frontend
# first and passes its location in SYNTHOA_WEB_DIR.
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH)
BACKEND = ROOT / "backend"
WEB = Path(os.environ.get("SYNTHOA_WEB_DIR", ROOT / "frontend" / "out"))
if not (WEB / "index.html").exists():
    raise SystemExit(f"Frontend build not found in {WEB} (run build.ps1)")

datas = (
    [(str(WEB), "web"), (str(BACKEND / "prompts"), "prompts")]
    + collect_data_files("webview")  # pywebview's injected JS
)
hiddenimports = (
    collect_submodules("app")
    + collect_submodules("uvicorn")
    + collect_submodules("tiktoken_ext")
    + ["aiosqlite", "sqlalchemy.dialects.sqlite.aiosqlite", "openpyxl",
       "webview.platforms.edgechromium", "webview.platforms.winforms"]
)
# Never bundle these even if they are installed in the build environment.
excludes = ["tkinter", "matplotlib", "IPython", "pytest", "PIL.ImageQt", "PyQt5", "PySide6"]

a = Analysis(
    [str(BACKEND / "desktop.py")],
    pathex=[str(BACKEND)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SYNTHOA",
    icon=str(ROOT / "assets" / "icon.ico"),
    console=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="SYNTHOA", upx=False)
