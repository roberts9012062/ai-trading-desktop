"""Regenerate platform assets from the image-generated brand master."""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PNPM = "pnpm.cmd" if os.name == "nt" else "pnpm"
subprocess.run([PNPM, "exec", "tauri", "icon", "brand/icon-master.png", "-o", "src-tauri/icons"], cwd=ROOT, check=True)
subprocess.run([PNPM, "exec", "tauri", "icon", "brand/icon-master.png", "-o", "public/brand", "--png", "64", "--png", "256"], cwd=ROOT, check=True)
