"""
System tray launcher for Jellyfin Movies servers.

Features:
- Starts the Flask backend and the static http.server without opening consoles.
- Lives in the Windows tray; menu lets you open the frontend, stop servers, or exit.
- Run with pythonw.exe (no console) or build with PyInstaller --noconsole.
"""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path
from typing import List, Optional

import pystray
from PIL import Image, ImageDraw
from pystray import Menu, MenuItem

def _find_project_root() -> Path:
    """Locate the folder that contains server.py and the frontend (index.html)."""
    def looks_like_root(path: Path) -> bool:
        return (path / "server.py").is_file() and (path / "index.html").is_file()

    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent)
        if hasattr(sys, "_MEIPASS"):
            try:
                candidates.append(Path(sys._MEIPASS).resolve())
            except Exception:
                pass
    candidates.append(Path(__file__).resolve().parent)
    try:
        candidates.append(Path(os.getcwd()).resolve())
    except Exception:
        pass

    for base in candidates:
        p: Optional[Path] = base
        for _ in range(5):
            if looks_like_root(p):
                return p
            if p.parent == p:
                break
            p = p.parent
    return candidates[0]


ROOT = _find_project_root()
LOG_FILE = ROOT / "tray_servers.log"

def _python_cmd() -> List[str]:
    env_override = os.environ.get("TRAY_PYTHON")
    if env_override:
        return shlex.split(env_override)
    # When frozen (PyInstaller), sys.executable points to the tray exe itself; avoid recursion.
    candidates: List[List[str]] = []
    if getattr(sys, "frozen", False):
        exe_path = Path(sys.executable)
        candidates.extend([
            [str(exe_path.with_name("pythonw.exe"))],
            [str(exe_path.with_name("python.exe"))],
        ])
    else:
        candidates.append([sys.executable])
    candidates.extend([
        ["pythonw.exe"],
        ["python.exe"],
        ["py", "-3"],
        ["python3"],
        ["python"],
    ])
    for cmd in candidates:
        head = cmd[0]
        if os.path.isabs(head):
            if Path(head).is_file():
                return cmd
        else:
            if shutil.which(head):
                return cmd
    return [sys.executable]


PYTHON_CMD = _python_cmd()
SERVER_COMMANDS: List[List[str]] = [
    PYTHON_CMD + ["server.py"],
    PYTHON_CMD + ["-m", "http.server", "8000"],
]

_procs: List[subprocess.Popen] = []
_logs: List = []
_lock = threading.Lock()


def _creationflags() -> int:
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        return subprocess.CREATE_NO_WINDOW
    return 0


def _notify(icon: pystray.Icon | None, msg: str) -> None:
    try:
        if icon and hasattr(icon, "notify"):
            icon.notify(msg)
    except Exception:
        pass


def _close_logs() -> None:
    while _logs:
        handle = _logs.pop()
        try:
            handle.close()
        except Exception:
            pass


def start_servers(icon: pystray.Icon | None = None, _item=None) -> None:
    with _lock:
        _close_logs()
        alive = [p for p in _procs if p and p.poll() is None]
        if alive:
            _notify(icon, "Servers are already running.")
            return
        _procs.clear()
        for cmd in SERVER_COMMANDS:
            try:
                LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
                log_handle = open(LOG_FILE, "ab")
                _logs.append(log_handle)
            except Exception:
                log_handle = subprocess.DEVNULL
            try:
                log_handle.write(f"Starting: {' '.join(cmd)}\n".encode("utf-8", "ignore"))
                log_handle.flush()
                p = subprocess.Popen(
                    cmd,
                    cwd=ROOT,
                    stdout=log_handle,
                    stderr=log_handle,
                    creationflags=_creationflags(),
                )
                _procs.append(p)
            except Exception as exc:
                log_handle.write(f"Failed: {' '.join(cmd)} | {exc}\n".encode("utf-8", "ignore"))
                log_handle.flush()
                _notify(icon, f"Failed to start: {' '.join(cmd)} ({exc})")
                return
        _notify(icon, "Servers started (backend:5000, frontend:8000).")


def stop_servers(icon: pystray.Icon | None = None, _item=None) -> None:
    with _lock:
        for p in list(_procs):
            if p and p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass
        for p in list(_procs):
            if p and p.poll() is None:
                try:
                    p.wait(timeout=2)
                except Exception:
                    pass
        _procs.clear()
        _close_logs()
    _notify(icon, "Servers stopped.")


def open_frontend(icon: pystray.Icon | None = None, _item=None) -> None:
    url = "http://localhost:8000/index.html"
    webbrowser.open(url)
    _notify(icon, f"Opening {url}")


def on_exit(icon: pystray.Icon) -> None:
    stop_servers(icon)
    icon.stop()


def create_icon() -> Image.Image:
    size = 64
    img = Image.new("RGBA", (size, size), (15, 17, 21, 255))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((8, 8, 56, 56), radius=10, fill=(239, 83, 80, 255))
    draw.rounded_rectangle((18, 18, 46, 46), radius=8, fill=(15, 17, 21, 255))
    draw.rectangle((24, 24, 40, 40), fill=(255, 213, 79, 255))
    return img


def main() -> None:
    icon = pystray.Icon(
        "JellyfinMovies",
        icon=create_icon(),
        title="Jellyfin Movies",
        menu=Menu(
            MenuItem("Open frontend", open_frontend),
            Menu.SEPARATOR,
            MenuItem("Start servers", start_servers, default=True),
            MenuItem("Stop servers", stop_servers),
            Menu.SEPARATOR,
            MenuItem("Exit", on_exit),
        ),
    )
    # Start servers immediately; tray controls remain available.
    start_servers(icon)
    icon.run()


if __name__ == "__main__":
    main()
