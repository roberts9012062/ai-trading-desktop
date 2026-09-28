"""Wire format, authentication and shape guards are acceptance behavior."""
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native-engine"))
from engine.protocol import ProtocolError, decode_message, encode_message, decode_columns


class ProtocolTests(unittest.TestCase):
    def test_authentication_is_required_on_text_and_binary(self):
        for binary in (False, True):
            frame = encode_message("load_bars", "r1", "s1", {"x": 2}, "secret", binary=binary)
            self.assertEqual(decode_message(frame, "secret")["request_id"], "r1")
            with self.assertRaises(ProtocolError):
                decode_message(frame, "wrong")

    def test_f64_columns_preserve_missing_values(self):
        source = np.array([1.25, np.nan, -3.5], dtype="<f8")
        cols = decode_columns({"close": source.tobytes()}, 3, 100_000)
        self.assertEqual(cols["close"].tobytes(), source.tobytes())

    def test_shape_and_existing_memory_guard(self):
        with self.assertRaises(ProtocolError):
            decode_columns({"close": b"123"}, 2, 100_000)
        with self.assertRaises(ProtocolError):
            decode_columns({}, 100_001, 100_000)
        with self.assertRaises(ProtocolError):
            decode_columns({}, 2, 400_000)


if __name__ == "__main__":
    unittest.main()
