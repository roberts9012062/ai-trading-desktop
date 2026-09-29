import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'native-engine'))
from engine.memory import resident_buffer_bytes, reserved_static_bytes
from engine.runtime import plan_tile


class MemoryTests(unittest.TestCase):
    def test_shared_buffers_are_not_counted_twice_and_bars_are_not_walked(self):
        buffer = object()
        self.assertEqual(resident_buffer_bytes({'first': buffer, 'alias': [buffer], 'bars': [object()]},
                         lambda row: 32 if row is buffer else None), 32)

    def test_deep_native_range_shrinks_batches_without_breaching_bar_guard(self):
        shallow = plan_tile(49122, 62, 3000, 'mixed', 6141, static_bytes=reserved_static_bytes(70174))
        deep = plan_tile(172200, 62, 3000, 'mixed', 6141, static_bytes=reserved_static_bytes(246000))
        self.assertEqual(shallow, 128)
        self.assertGreater(deep, 0)
        self.assertLess(deep, shallow)
        with self.assertRaisesRegex(MemoryError, 'reduce the bar range or use CPU'):
            plan_tile(300000, 62, 3000, 'mixed', 1024, static_bytes=reserved_static_bytes(300000))


if __name__ == '__main__':
    unittest.main()
