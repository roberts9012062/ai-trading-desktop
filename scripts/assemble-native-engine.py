"""Assemble the packaged native-engine runtime directory (M4).

Layout (design §2.2/§6):
  <out>/python/         embedded CPython (python-build-standalone) interpreter
  <out>/site-packages/  frozen scientific stack (taichi, numpy, msgpack, ...)
  <out>/engine/         the native engine package (repo native-engine/engine)
  <out>/VERSION         engine version stamp
  <out>/python311._pth  deterministic sys.path; ignores all PYTHON* env vars

The ._pth file makes the packaged interpreter independent of any system
Python/PYTHONPATH/PYTHONHOME: imports resolve only inside this directory.

Reproducibility: dependency versions come from the frozen venv (built from
requirements-native.lock); every emitted file is recorded in MANIFEST.sha256.
"""
import argparse
import hashlib
import os
import subprocess
import sys
import time
from fnmatch import fnmatch
from pathlib import Path
from shutil import copy2, copytree, rmtree

ROOT = Path(__file__).resolve().parents[1]

PYTHON_SKIP_NAMES = {
    "tcl", "idlelib", "pydoc_data", "__pycache__", "ensurepip", "venv",
    "lib2to3", "Scripts", "BUILD",
}
STDLIB_SKIP_DIRS = {"test", "tests", "__pycache__", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3"}
SITE_SKIP_NAMES = {"__pycache__", "_virtualenv.pth", "_virtualenv.py", "__pycache____"}
SKIP_SUFFIXES = (".whl", ".pyc", ".chm")


def _ignore_factory(skip_names, skip_dirs):
    def ignore(_directory, entries):
        kept = []
        for entry in entries:
            path = Path(_directory)/entry
            if entry in skip_names or entry in skip_dirs:
                continue
            if path.suffix in SKIP_SUFFIXES or (path.is_dir() and entry in skip_dirs):
                continue
            kept.append(entry)
        return [e for e in entries if e not in kept]
    return ignore


def copy_tree_filtered(src: Path, dst: Path, skip_names, skip_dirs):
    ignore = _ignore_factory(skip_names, skip_dirs)
    count = 0
    for item in src.iterdir():
        if item.name in skip_names or item.suffix in SKIP_SUFFIXES:
            continue
        target = dst/item.name
        if item.is_dir():
            copytree(item, target, ignore=ignore, dirs_exist_ok=True)
        else:
            copy2(item, target)
        count += 1
    return count


def build_manifest(root: Path) -> str:
    lines = []
    for path in sorted(p for p in root.rglob("*") if p.is_file() and p.name != "MANIFEST.sha256"):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.relative_to(root).as_posix()}")
    return "\n".join(lines)+"\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT/"resources/native-engine")
    parser.add_argument("--python", type=Path,
                        default=Path(r"C:\Users\bbsx1\AppData\Roaming\uv\python\cpython-3.11-windows-x86_64-none"),
                        help="python-build-standalone distribution to embed")
    parser.add_argument("--venv", type=Path, default=ROOT/'.local-data/native-engine-venv')
    parser.add_argument("--skip-launch-check", action="store_true")
    args = parser.parse_args()

    out = args.out
    if out.exists():
        rmtree(out)
    out.mkdir(parents=True)

    t0 = time.time()
    copy_tree_filtered(args.python, out/"python", PYTHON_SKIP_NAMES, STDLIB_SKIP_DIRS)
    # Deterministic sys.path anchored inside the package: ignores PYTHONPATH,
    # PYTHONHOME and any system Python. '..' (not '..\engine'): the engine is a
    # package, so its PARENT directory must be on sys.path for 'import engine'.
    # DLLs/Lib carry extension modules and the stdlib of the embedded build.
    (out/"python"/"python311._pth").write_text(
        "python311.zip\n.\nDLLs\nLib\n..\\site-packages\n..\n", encoding="utf-8", newline="\n")
    copy_tree_filtered(args.venv/"Lib/site-packages", out/"site-packages", SITE_SKIP_NAMES, {"__pycache__"})
    copytree(ROOT/"native-engine/engine", out/"engine",
             ignore=_ignore_factory(["__pycache__"], set()), dirs_exist_ok=True)
    copy2(ROOT/"native-engine/VERSION", out/"VERSION")
    # engine/__init__.py resolves the shared CPU kernel as parents[2]/public/pykernel:
    # placing pykernel at resources/public/pykernel satisfies that with zero engine
    # source changes (dev layout: repo_root/public/pykernel).
    kernel_out = out.parent/"public/pykernel"
    if kernel_out.exists():
        rmtree(kernel_out)
    copytree(ROOT/"public/pykernel", kernel_out,
             ignore=_ignore_factory(["__pycache__", "*.pyc"], set()), dirs_exist_ok=True)
    version = (out/"VERSION").read_text(encoding="utf-8").strip()

    if not args.skip_launch_check:
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("PYTHON")}
        probe = subprocess.run([str(out/"python/python.exe"), "-c",
                                "import sys, taichi, numpy, msgpack, websockets;"
                                "print('imports-ok', sys.version.split()[0], taichi.__version__, numpy.__version__)"],
                               capture_output=True, text=True, env=env, timeout=600)
        if probe.returncode != 0:
            print(probe.stdout)
            print(probe.stderr, file=sys.stderr)
            raise SystemExit("packaged interpreter import check failed")
        print(probe.stdout.strip())

    (out/"MANIFEST.sha256").write_text(build_manifest(out), encoding="utf-8", newline="\n")
    files = sum(1 for p in out.rglob("*") if p.is_file())
    size_mb = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())/1048576
    print(f"assembled {out} version={version} files={files} size={size_mb:.0f}MB in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
