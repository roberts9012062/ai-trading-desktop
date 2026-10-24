"""Compatibility entry point for the startup-only cache acceptance."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name("verify-collection-startup.py")),run_name="__main__")
