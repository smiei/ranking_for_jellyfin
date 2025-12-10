#!/usr/bin/env python3
import os

def count_lines(filepath):
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            return sum(1 for _ in f)
    except Exception as e:
        return f"Fehler: {e}"

root = os.getcwd()
print(f"Analyse von: {root}\n")

# Ordner, die übersprungen werden sollen
SKIP_DIRS = {"images", "dist", "build", "backlogged", "__pycache__"}  # ggf. "__pycache__"

for dirpath, dirnames, filenames in os.walk(root):
    # Versteckte Ordner und SKIP_DIRS ausblenden
    dirnames[:] = [
        d for d in dirnames
        if not d.startswith(".") and d not in SKIP_DIRS
    ]

    rel = os.path.relpath(dirpath, root)
    depth = 0 if rel == "." else rel.count(os.sep) + 1  # 0 = aktueller Ordner
    indent = "  " * depth

    # Ordnername ausgeben
    if rel == ".":
        print(".")
    else:
        print(f"{indent}[{os.path.basename(dirpath)}]")

    # Dateien in diesem Ordner ausgeben
    for fname in sorted(filenames):
        fpath = os.path.join(dirpath, fname)
        lines = count_lines(fpath)
        print(f"{indent}  - {fname} ({lines} Zeilen)")
