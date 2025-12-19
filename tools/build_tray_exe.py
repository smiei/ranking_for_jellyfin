"""
Rebuild the Jellyfin Movies tray EXE with PyInstaller.

Double-click to run (uses the current Python environment).
Outputs: dist/JellyfinMoviesTray.exe
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET_NAME = "JellyfinMoviesTray"
SPEC_FILE = ROOT / f"{TARGET_NAME}.spec"


def clean_old_artifacts() -> None:
    for path in (ROOT / "dist", ROOT / "build", SPEC_FILE):
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        elif path.is_file():
            try:
                path.unlink()
            except OSError:
                pass


def ensure_pyinstaller() -> None:
    try:
        subprocess.run([sys.executable, "-m", "PyInstaller", "--version"], check=True, stdout=subprocess.DEVNULL)
    except Exception as exc:
        raise SystemExit(
            "PyInstaller not found. Install it first:\n"
            "  py -3 -m pip install pyinstaller\n"
            f"(detail: {exc})"
        )


def build() -> None:
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconsole",
        "--onefile",
        "--name",
        TARGET_NAME,
        "tray_launcher.py",
    ]
    print(f"Working directory: {ROOT}")
    print(f"Running: {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=ROOT)
    if proc.returncode != 0:
        raise SystemExit(f"PyInstaller failed with exit code {proc.returncode}")
    exe_path = ROOT / "dist" / f"{TARGET_NAME}.exe"
    if exe_path.exists():
        print(f"Build complete: {exe_path}")
    else:
        print("Build finished, but EXE not found in dist/.")


def main() -> None:
    print("Cleaning old artifacts...")
    clean_old_artifacts()
    print("Checking PyInstaller...")
    ensure_pyinstaller()
    print("Building EXE...")
    build()


if __name__ == "__main__":
    main()
