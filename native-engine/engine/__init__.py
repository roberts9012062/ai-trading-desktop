"""Native GPU engine; frozen CPU modules provide metadata and test oracles."""
import sys
from pathlib import Path

# Standalone sidecars start with only native-engine on PYTHONPATH. Resolve the
# repository/resource-owned kernel path before importing metadata helpers.
_kernel_path = str(Path(__file__).resolve().parents[2] / "public" / "pykernel")
if _kernel_path not in sys.path:
    sys.path.insert(0, _kernel_path)

ENGINE_TAG = "native-gpu-v1"
