"""Inactive candidate rows must create no instruction work or row aliasing."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'native-engine'))


class ActiveRowTests(unittest.TestCase):
    def test_compaction_retains_candidate_indices_at_every_instruction(self):
        from engine.phase_vm_ti import decode_instruction_rows, active_row_indices
        rows = decode_instruction_rows([[0], [0, 77], [0, 1, 64], [1]], 2)
        indices, counts = active_row_indices(rows, 8)
        self.assertEqual(indices.shape, (32, 8))
        self.assertEqual(counts[:4], [4, 2, 1, 0])
        self.assertEqual(indices[0, :4].tolist(), [0, 1, 2, 3])
        self.assertEqual(indices[1, :2].tolist(), [1, 2])
        self.assertEqual(indices[2, :1].tolist(), [2])
        self.assertEqual(counts[3:], [0]*29)
        empty, counts = active_row_indices(decode_instruction_rows([], 2), 8)
        self.assertFalse(empty.any())
        self.assertEqual(counts, [0]*32)
