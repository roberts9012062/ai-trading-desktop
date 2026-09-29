"""Enrichment batches retain the scalar cache contract and scoped scratch."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.precise_ti import GpuDedup
from engine.wf_ti import _SEG_RESULTS


class EnrichmentBatchTests(unittest.TestCase):
    def make_dedup(self):
        dedup = GpuDedup.__new__(GpuDedup)
        dedup.bars = [{}]*2401
        dedup.train, dedup.test = dedup.bars[:1680], dedup.bars[1680:]
        dedup.cost = .0003
        dedup.plan = None
        dedup.meta = {'use_test': True, 'walk_forward_folds': 2}
        dedup.cfg = SimpleNamespace(selection_v2=True)
        dedup.session = SimpleNamespace(prepared={'bars': [{}]*2601})
        dedup.context = SimpleNamespace(research=SimpleNamespace(prefetched_slices={'prior': 'scratch'}))
        return dedup

    def test_batch_is_scoped_without_eager_cache_writes_and_keeps_call_order(self):
        dedup = self.make_dedup()
        items = [(1, [0], {}, {'BTC': 1}), (.5, [1], {}, None)]
        old = dedup.context.research.prefetched_slices
        cache_before = list(_SEG_RESULTS.items())
        calls = []

        class Batch:
            def __init__(self, context):
                self.results = {'batched': 'reports'}
                self.disposed = False

            def prefetch(self, candidates, requests):
                calls.append(('prefetch', candidates, requests))
                self.assert_cache_untouched()

            def assert_cache_untouched(self):
                assert list(_SEG_RESULTS.items()) == cache_before

            def dispose(self):
                calls.append(('dispose',))

        def enrich(item, trials, final, cross):
            self.assertEqual(dedup.context.research.prefetched_slices, {'batched': 'reports'})
            calls.append(('enrich', item, trials, final, cross))
            return list(item[1])

        dedup.enrich = enrich
        with patch('engine.slice_batch_ti.BatchSlices', Batch):
            result = dedup.enrich_many(items, 3000, False)
        self.assertEqual(result, [[0], [1]])
        self.assertIs(dedup.context.research.prefetched_slices, old)
        self.assertEqual(calls[0][1], [[0], [1]])
        self.assertEqual(calls[0][2], [
            (0, 1680, .0003), (1680, 2401, .0003),
            (0, 800, .0003), (800, 1600, .0003),
            (0, 1600, .0003), (1600, 2401, .0003),
            (1680, 1860, .0003), (1860, 2040, .0003),
            (2040, 2220, .0003), (2220, 2401, .0003)])
        self.assertEqual([call[1] for call in calls if call[0]=='enrich'], [item[:3] for item in items])
        self.assertEqual(calls[-1], ('dispose',))
        self.assertEqual(list(_SEG_RESULTS.items()), cache_before)

    def test_scratch_is_restored_when_enrichment_raises(self):
        dedup = self.make_dedup()
        old = dedup.context.research.prefetched_slices
        with patch('engine.slice_batch_ti.BatchSlices') as batch:
            dedup.enrich = lambda *args: (_ for _ in ()).throw(ValueError('report failure'))
            with self.assertRaisesRegex(ValueError, 'report failure'):
                dedup.enrich_many([(1, [0], {}, None), (.5, [1], {}, None)], 10, False)
            batch.return_value.dispose.assert_called_once()
        self.assertIs(dedup.context.research.prefetched_slices, old)

    def test_sealed_holdout_is_batched_only_at_final_legacy_reveal(self):
        from unittest.mock import Mock
        for final, planned, selected, reveal in ((False, False, True, False),
                (True, True, True, False), (True, False, False, False), (True, False, True, True)):
            with self.subTest(final=final, planned=planned, selected=selected):
                dedup = self.make_dedup()
                dedup.plan = object() if planned else None
                dedup.cfg.selection_v2 = selected
                full = SimpleNamespace(bars=dedup.session.prepared['bars'], prefetched_slices={'sealed': 'prior'})
                previous = full.prefetched_slices
                dedup.full_context = Mock(return_value=full)
                contexts, requests, disposed = [], [], []

                class Batch:
                    def __init__(self, context):
                        self.context, self.results = context, {'batched': 'reports'}
                        contexts.append(context)

                    def prefetch(self, candidates, slices):
                        requests.append((self.context, slices))

                    def dispose(self):
                        disposed.append(self.context)

                def enrich(*args):
                    self.assertEqual(full.prefetched_slices, {'batched': 'reports'} if reveal else previous)
                    return 'result'

                dedup.enrich = enrich
                with patch('engine.slice_batch_ti.BatchSlices', Batch):
                    self.assertEqual(dedup.enrich_many([(1, [0], {}, None), (.5, [1], {}, None)], 10, final), ['result']*2)
                self.assertIs(full.prefetched_slices, previous)
                self.assertEqual(contexts.count(full), int(reveal))
                self.assertEqual(disposed.count(full), int(reveal))
                if reveal:
                    self.assertIn((full, [(2401, 2601, .0003)]), requests)
                else:
                    dedup.full_context.assert_not_called()

    def test_final_holdout_scratch_restores_both_contexts_on_report_failure(self):
        from unittest.mock import Mock
        dedup = self.make_dedup()
        research = dedup.context.research
        full = SimpleNamespace(bars=dedup.session.prepared['bars'], prefetched_slices={'sealed': 'prior'})
        old, sealed = research.prefetched_slices, full.prefetched_slices
        dedup.full_context = Mock(return_value=full)
        dedup.enrich = lambda *args: (_ for _ in ()).throw(ValueError('holdout report failure'))
        with patch('engine.slice_batch_ti.BatchSlices') as factory:
            with self.assertRaisesRegex(ValueError, 'holdout report failure'):
                dedup.enrich_many([(1, [0], {}, None), (.5, [1], {}, None)], 10, True)
            self.assertEqual(factory.call_count, 2)
            self.assertEqual(factory.return_value.dispose.call_count, 2)
        self.assertIs(research.prefetched_slices, old)
        self.assertIs(full.prefetched_slices, sealed)


if __name__ == '__main__':
    unittest.main()
