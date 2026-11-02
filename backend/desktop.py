"""Desktop entry point: SYNTHOA in its own window (Edge WebView2).

Runs the FastAPI server, which also serves the built frontend, on a free
localhost port in a background thread and shows it with pywebview. This is
what ``SYNTHOA.exe`` starts; for development, ``python desktop.py`` works too
(after building the frontend with STATIC_EXPORT=1).
"""
from __future__ import annotations

import ctypes
import faulthandler
import hashlib
import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.request

from app.paths import APP_DIR, DATA_DIR, FROZEN, WEB_DIR, ensure_data_dir

APP_NAME = "SYNTHOA"
LOG_MAX_BYTES = 5 * 1024 * 1024
WINDOWS = sys.platform == "win32"

LOADING_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0;color:#ece8f7;font:15px 'Segoe UI',sans-serif;
  background:radial-gradient(ellipse 60% 50% at 0% 0%,rgba(124,58,237,.22),transparent 70%),#0c0a14}
body{display:grid;place-items:center} .box{text-align:center}
b{letter-spacing:.08em}
.bar{width:220px;height:6px;margin:18px auto 0;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden}
.bar::after{content:"";display:block;width:35%;height:100%;background:linear-gradient(90deg,#8b5cf6,#7dd3fc);border-radius:6px;animation:s 1.2s ease-in-out infinite}
@keyframes s{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
small{display:block;margin-top:2px;color:#9b94b3;font-size:12px}
</style></head><body><div class="box"><b>SYNTHOA</b><small>by fclementi</small><div class="bar"></div></div></body></html>"""


def setup_environment() -> None:
    """Point every writable path at the app folder before the app is imported."""
    ensure_data_dir()
    # Token estimates: tiktoken caches its encodings here (downloaded once, when online).
    os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(DATA_DIR / "tiktoken"))
    # Keys can live in data\.env next to the database (Settings also stores them).
    env_file = DATA_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key and not key.startswith("#"):
                os.environ.setdefault(key.strip(), value.strip().strip('"'))


def setup_logging() -> None:
    """A windowed exe has no console: send stdout/stderr to logs/app.log."""
    if not FROZEN:
        return
    logs = APP_DIR / "logs"
    logs.mkdir(exist_ok=True)
    log_path = logs / "app.log"
    if log_path.exists() and log_path.stat().st_size > LOG_MAX_BYTES:
        log_path.replace(logs / "app.previous.log")
    stream = open(log_path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 - lives for the process
    sys.stdout = sys.stderr = stream
    faulthandler.enable(stream)
    print(f"\n=== {APP_NAME} started {time.strftime('%Y-%m-%d %H:%M:%S')} (folder: {APP_DIR}) ===")


def message_box(text: str) -> None:
    if WINDOWS:
        ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x40)  # MB_ICONINFORMATION
    else:
        print(text)


def already_running() -> bool:
    """One instance per app folder (one process owns the SQLite database)."""
    if not WINDOWS:
        return False
    folder_id = hashlib.sha1(str(APP_DIR).lower().encode()).hexdigest()[:16]  # str hash() is salted per process
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, f"Local\\SYNTHOA-{folder_id}")
    already = ctypes.windll.kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS
    globals()["_mutex"] = handle  # keep the handle alive for the process lifetime
    return already


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Server(threading.Thread):
    def __init__(self, port: int) -> None:
        super().__init__(name="uvicorn", daemon=True)
        import uvicorn

        from app.main import app

        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", log_config=None))
        self.url = f"http://127.0.0.1:{port}/"

    def run(self) -> None:
        self.server.run()

    def wait_ready(self, timeout: float = 60) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline and self.is_alive():
            try:
                urllib.request.urlopen(self.url + "health", timeout=1)
                return True
            except Exception:  # noqa: BLE001 - not up yet
                time.sleep(0.2)
        return False

    def active_runs(self) -> int:
        """Runs that closing the window would interrupt (batch runs keep going at the provider)."""
        with urllib.request.urlopen(self.url + "api/runs?limit=200", timeout=2) as response:
            runs = json.load(response)
        return sum(1 for r in runs if r["status"] in ("pending", "running") and not r.get("batch_mode"))


def confirm_close(window, server: Server | None) -> bool:
    """Called when the window is closing; False keeps it open."""
    try:
        if server and server.active_runs():
            return bool(window.create_confirmation_dialog(
                APP_NAME, "A simulation is still running. It will stop now and can be resumed from its run page.\n\nQuit anyway?"))
    except Exception:  # noqa: BLE001 - never block quitting because of a bug here
        traceback.print_exc()
    return True


def serve_headless(port: int) -> None:
    """``SYNTHOA.exe --serve 8000``: no window, open http://127.0.0.1:8000 in any browser."""
    server = Server(port)
    server.start()
    if not server.wait_ready():
        message_box("The local server did not start; see logs\\app.log.")
        return
    print(f"Serving on {server.url}")
    server.join()


def main() -> None:
    setup_environment()
    setup_logging()
    if already_running():
        message_box("SYNTHOA is already running from this folder.")
        return
    if not (WEB_DIR / "index.html").exists():
        message_box(f"The frontend is not built ({WEB_DIR}).\nRun BUILD_EXE.bat, or build it with STATIC_EXPORT=1 npm run build.")
        return
    if "--serve" in sys.argv:
        args = sys.argv[sys.argv.index("--serve") + 1:]
        serve_headless(int(args[0]) if args and args[0].isdigit() else 8000)
        return

    import webview

    webview.settings["ALLOW_DOWNLOADS"] = True   # CSV / Excel / PDF exports
    window = webview.create_window(APP_NAME, html=LOADING_HTML, width=1400, height=900, min_size=(1000, 640), background_color="#0c0a14")
    state: dict[str, Server] = {}
    window.events.closing += lambda: confirm_close(window, state.get("server"))

    def boot() -> None:
        try:
            server = Server(free_port())
            server.start()
            if not server.wait_ready():
                raise RuntimeError("the local server did not start")
            state["server"] = server
            print(f"Serving on {server.url}")
            window.load_url(server.url)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            window.load_html(
                f"<body style='font:15px Segoe UI;padding:40px;background:#0c0a14;color:#ece8f7'><h2>SYNTHOA could not start</h2>"
                f"<p>{exc}</p><p>Details are in <code>{APP_DIR / 'logs' / 'app.log'}</code>.</p></body>"
            )

    webview.start(boot, gui="edgechromium" if WINDOWS else None, private_mode=False,
                  storage_path=str(DATA_DIR / "webview-cache"))
    print("Window closed; exiting.")
    sys.stdout.flush()
    os._exit(0)  # don't wait for background tasks to tear down


if __name__ == "__main__":
    main()
