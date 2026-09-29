"""Bounded scratch reuse cannot alias different frozen inputs or widths."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'native-engine'))


class BatchBufferTests(unittest.TestCase):
    def data(self, count=100):
        return {'bars': [None]*count, 'bytes': 1000}

    def test_exact_data_identity_and_width_reuse_without_recomputing_scores(self):
        from engine.batch_buffers import BatchBufferPool
        calls = []
        def factory(data, width):
            pair = (SimpleNamespace(owner=data, width=width), object())
            calls.append(pair)
            return pair
        pool = BatchBufferPool(10**6, factory=factory)
        data = self.data()
        first = pool.acquire(data, 2)
        self.assertIs(pool.acquire(data, 2), first)
        self.assertIsNot(pool.acquire(dict(data), 2), first)
        self.assertIsNot(pool.acquire(data, 3), first)
        self.assertEqual(len(calls), 3)
        pool.dispose()
        self.assertEqual(pool.bytes, 0)
        self.assertIsNot(pool.acquire(data, 2), first)

    def test_budget_shrink_eviction_and_oversized_ephemeral_buffers(self):
        from engine.batch_buffers import BatchBufferPool
        calls = []
        def factory(data, width):
            value = (object(), object())
            calls.append(value)
            return value
        pool = BatchBufferPool(10**6, factory=factory)
        a, b = self.data(), self.data()
        size = pool.estimate_bytes(a, 2)
        pool.set_limit(size*2)
        fa, fb = pool.acquire(a, 2), pool.acquire(b, 2)
        self.assertIs(pool.acquire(a, 2), fa)  # a becomes newest.
        pool.set_limit(size)
        self.assertLessEqual(pool.bytes, size)
        self.assertIs(pool.acquire(a, 2), fa)
        self.assertIsNot(pool.acquire(b, 2), fb)
        pool.set_limit(0)
        self.assertEqual(pool.bytes, 0)
        self.assertIsNot(pool.acquire(a, 2), pool.acquire(a, 2))
        self.assertEqual(pool.bytes, 0)

    def test_failed_allocation_publishes_no_partial_pool_entry(self):
        from engine.batch_buffers import BatchBufferPool
        def fail(data, width):
            raise MemoryError('fixture allocation')
        pool = BatchBufferPool(10**6, factory=fail)
        with self.assertRaises(MemoryError):
            pool.acquire(self.data(), 2)
        self.assertEqual(pool.bytes, 0)
