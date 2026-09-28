"""Guard the fixed-order kernel contract, including implicit atomic hazards."""
import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class DeterminismContractTests(unittest.TestCase):
    def test_kernel_source_forbids_random_shuffle_atomic_and_shared_augassign(self):
        files = list((ROOT / "native-engine/engine").glob("*_ti.py"))
        self.assertGreaterEqual(len(files), 3)
        for path in files:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call):
                    name = ast.unparse(node.func)
                    self.assertFalse(any(word in name for word in ("random", "atomic", "shuffle")),
                                     f"{path.name}:{node.lineno}: {name}")
                if isinstance(node, ast.AugAssign):
                    # Taichi implicitly lowers += against global/shared arrays
                    # into atomic operations. Named per-thread locals are safe.
                    self.assertIsInstance(node.target, ast.Name,
                                          f"Shared augmented assignment: {path.name}:{node.lineno}")

    def test_reductions_have_fixed_256_lanes_pair_tree_and_time_blocks(self):
        vm = (ROOT / "native-engine/engine/vm_ti.py").read_text(encoding="utf-8")
        metrics = (ROOT / "native-engine/engine/metrics_ti.py").read_text(encoding="utf-8")
        reduction = (ROOT / "native-engine/engine/reductions_ti.py").read_text(encoding="utf-8")
        self.assertIn("block_dim=256", vm)
        self.assertIn("block_dim=256", metrics)
        self.assertIn("step = 128", reduction)
        self.assertIn("step = step // 2", reduction)
        self.assertIn("ti.simt.block.sync()", reduction)
        self.assertIn("block * 1024", metrics)
        self.assertIn("left, right = k * 2, k * 2 + 1", metrics)


if __name__ == "__main__":
    unittest.main()
