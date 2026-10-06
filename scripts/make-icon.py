"""Regenerate platform assets from the image-generated brand master."""
import os
from pathlib import Path
import subprocess
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
PNPM = "pnpm.cmd" if os.name == "nt" else "pnpm"
# Generate off to the side, then replace files rather than truncating images
# that a Windows preview process may have memory-mapped.
staging = ROOT / ".local-data" / f"icon-build-{uuid4().hex}"
for folder, sizes in (("export", [1024]), ("platform", []), ("app", [64, 256])):
    command = [PNPM, "exec", "tauri", "icon", "brand/icon-master.png", "-o", str(staging / folder)]
    for size in sizes:
        command.extend(["--png", str(size)])
    subprocess.run(command, cwd=ROOT, check=True)

(staging / "export/1024x1024.png").replace(ROOT / "brand/icon-1024.png")
for folder, destination in (("platform", ROOT / "src-tauri/icons"), ("app", ROOT / "public/brand")):
    for source in (staging / folder).rglob("*"):
        if source.is_file():
            target = destination / source.relative_to(staging / folder)
            target.parent.mkdir(parents=True, exist_ok=True)
            source.replace(target)
