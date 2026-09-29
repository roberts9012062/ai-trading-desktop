"""Numerically sensitive libm operations from the actual desktop WASM build."""
import json
import hashlib
import sys
import unittest
from pathlib import Path

import numpy as np
import taichi as ti

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'native-engine'))
from engine.runtime import initialize_runtime


class LibmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize_runtime('f64', require_cuda=True)

    def test_exp_and_log1p_match_frozen_pyodide_vectors_bitwise(self):
        from engine.libm_ti import NativeLibm
        fixture = json.loads((Path(__file__).parent/'fixtures/libm-pyodide.json').read_text())
        self.assertEqual(fixture['pyodide'], '0.26.4')
        self.assertEqual(fixture['wasm_sha256'], hashlib.sha256((ROOT/'public/pyodide/pyodide.asm.wasm').read_bytes()).hexdigest())
        libm = NativeLibm()
        for name in ('exp', 'log1p'):
            vectors = fixture[name]
            inp = ti.ndarray(ti.f64, shape=len(vectors)); inp.from_numpy(np.array([int(row['input_bits']) for row in vectors], dtype=np.uint64).view(np.float64))
            out = ti.ndarray(ti.f64, shape=len(vectors))
            libm.diagnostic(inp, out, int(name == 'log1p'), 0)
            ti.sync()
            actual = out.to_numpy().view(np.uint64)
            expected = np.array([int(row['bits']) for row in vectors], dtype=np.uint64)
            np.testing.assert_array_equal(actual, expected, err_msg=name)
            first = out.to_numpy().tobytes()
            libm.diagnostic(inp, out, int(name == 'log1p'), 0)
            ti.sync()
            self.assertEqual(first, out.to_numpy().tobytes())

    def test_expm1_and_tanh_match_desktop_rank_tie_inputs_bitwise(self):
        from engine.libm_ti import NativeLibm
        fixture = json.loads((Path(__file__).parent/'fixtures/libm-pyodide.json').read_text())
        libm = NativeLibm()
        self.assertTrue(callable(getattr(libm, 'expm1', None)))
        self.assertTrue(callable(getattr(libm, 'tanh', None)))
        for name, mode in (('expm1', 2), ('tanh', 3)):
            rows = fixture[name]
            source = ti.ndarray(ti.f64, shape=len(rows))
            source.from_numpy(np.array([int(row['input_bits']) for row in rows], dtype=np.uint64).view(np.float64))
            out = ti.ndarray(ti.f64, shape=len(rows))
            libm.diagnostic(source, out, mode, 0)
            expected = np.array([int(row['bits']) for row in rows], dtype=np.uint64)
            np.testing.assert_array_equal(out.to_numpy().view(np.uint64), expected, err_msg=name)

    def test_third_and_fourth_powers_match_desktop_moment_inputs_bitwise(self):
        from engine.libm_ti import NativeLibm
        fixture = json.loads((Path(__file__).parent/'fixtures/libm-pyodide.json').read_text())
        libm = NativeLibm()
        self.assertTrue(callable(getattr(libm, 'moment_power', None)))
        for name, mode in (('pow3', 4), ('pow4', 5)):
            rows = fixture[name]
            source = ti.ndarray(ti.f64, shape=len(rows))
            source.from_numpy(np.array([int(row['input_bits']) for row in rows], dtype=np.uint64).view(np.float64))
            out = ti.ndarray(ti.f64, shape=len(rows))
            libm.diagnostic(source, out, mode, 0)
            np.testing.assert_array_equal(out.to_numpy().view(np.uint64),
                np.array([int(row['bits']) for row in rows], dtype=np.uint64), err_msg=name)


if __name__ == '__main__':
    unittest.main()
