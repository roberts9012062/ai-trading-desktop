"""Qualified champions require genuine, complete task gate evidence."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'native-engine'))


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.requirements = {'test_required': True, 'wf_folds': 2, 'holdout_required': True,
            'holdout_stress_required': True, 'sample_sufficient': True,
            'live_fill_gate': False, 'live_entry_gate': 0, 'execution_required': False}
        self.row = {'tokens': [0], 'text': 'factor', 'composite': 1., 'metrics': {
            'native_strict_passed': True, 'sortino': 1., 'ann_ret': .1,
            'test_metrics': {'sortino': 1., 'ann_ret': .1, 'bars': 200},
            'walk_forward': {'wf_stable': True, 'n_oos_folds': 2, 'folds': [
                {'in_train': False, 'test': {'sortino': 1., 'bars': 200}},
                {'in_train': False, 'test': {'sortino': 1., 'bars': 200}}]},
            'holdout_metrics': {'sortino': 1., 'sortino_2x': .5, 'ann_ret': .1, 'bars': 200},
            'dsr': .001, 'pbo_proxy': .99}}

    def qualify(self, rows=None, final=True):
        from engine.qualification import qualify_candidates
        return qualify_candidates(rows or [self.row], self.requirements, final_generation=final)

    def test_complete_evidence_qualifies_without_inventing_dsr_pbo_thresholds(self):
        result = self.qualify()
        self.assertEqual(len(result['champions']), 1)
        self.assertEqual(result['champions'][0]['qualification']['status'], 'qualified')
        self.assertFalse(result['rejected'] or result['pending'])

    def test_rounded_integral_counts_and_v2_calendar_metadata_remain_valid(self):
        self.row['metrics']['walk_forward'].update(n_oos_folds=2., folds=[
            {'score_start': 100., 'score_end': 300., 'sortino': 1., 'bars': 200.},
            {'score_start': 300., 'score_end': 500., 'sortino': 1., 'bars': 200.}])
        self.requirements['train_end'] = 100
        self.assertEqual(len(self.qualify()['champions']), 1)

    def test_exploratory_strict_failure_and_missing_proof_never_qualify(self):
        for change in ({'native_strict_passed': False}, {'native_strict_passed': None},
                {'candidate_status': 'exploratory'}, {'candidate_status': 'rejected'},
                {'overfit_warning': 'failed screening'}):
            with self.subTest(change=change):
                row = copy.deepcopy(self.row)
                row['metrics'].update(change)
                self.assertFalse(self.qualify([row])['champions'])

    def test_empty_oos_folds_are_not_vacuous_walk_forward_success(self):
        self.row['metrics']['walk_forward'].update(n_oos_folds=0, folds=[])
        result = self.qualify()
        self.assertFalse(result['champions'])
        self.assertIn('wf_oos_evidence_missing', result['rejected'][0]['qualification']['reasons'])

    def test_false_fold_evidence_or_negative_oos_sortino_is_rejected(self):
        for fold in ({'in_train': True, 'test': {'sortino': 1., 'bars': 200}},
                {'in_train': False, 'test': {'sortino': -1., 'bars': 200}}):
            self.row['metrics']['walk_forward']['folds'] = [fold, fold]
            self.assertFalse(self.qualify()['champions'])

    def test_missing_or_nonfinite_required_values_are_rejected(self):
        for value in (None, {}, {'sortino': float('nan')}, {'sortino': float('inf')}, {'sortino': -1.}):
            self.row['metrics']['test_metrics'] = value
            self.assertFalse(self.qualify()['champions'])

    def test_final_sealed_holdout_base_and_existing_stress_gate_are_required(self):
        for holdout in (None, {}, {'sortino': -1., 'sortino_2x': 1., 'bars': 200},
                {'sortino': 1., 'sortino_2x': -1., 'bars': 200}, {'sortino': 1., 'bars': 200}):
            self.row['metrics']['holdout_metrics'] = holdout
            self.assertFalse(self.qualify()['champions'])

    def test_nonfinal_reveal_is_pending_and_does_not_read_sealed_metrics(self):
        self.row['metrics'].pop('holdout_metrics')
        result = self.qualify(final=False)
        self.assertFalse(result['champions'] or result['rejected'])
        self.assertEqual(result['pending'][0]['qualification']['reasons'], ['holdout_sealed'])
        self.row['metrics']['holdout_metrics'] = {'sortino': float('nan')}
        self.assertEqual(len(self.qualify(final=False)['pending']), 1)

    def test_client_verdicts_cannot_create_or_reverse_native_strict_proof(self):
        from engine.qualification import trusted_prefetched
        proofs = {(0,): (False, {}), (1,): (True, {'BTC': 1.})}
        supplied = {(0,): (True, {}), (1,): (False, {}), (2,): (True, {})}
        self.assertEqual(trusted_prefetched(supplied, proofs), proofs)
        self.assertEqual(trusted_prefetched({}, proofs), {})

    def test_insufficient_samples_and_no_validation_never_qualify(self):
        self.requirements['sample_sufficient'] = False
        self.assertFalse(self.qualify()['champions'])
        self.requirements.update(sample_sufficient=True, test_required=False)
        self.assertFalse(self.qualify()['champions'])

    def test_task_specific_execution_and_live_gates_require_positive_evidence(self):
        self.requirements.update(execution_required=True, live_fill_gate=True, live_entry_gate=.3)
        self.assertFalse(self.qualify()['champions'])
        self.row['metrics']['execution_metrics'] = {'sortino': 1., 'bars': 200}
        self.row['metrics']['test_metrics'].update(live_fill_sortino=1.)
        self.row['metrics']['holdout_metrics'].update(live_discrete_sortino=1.)
        self.assertTrue(self.qualify()['champions'])

    def test_no_mutation_backfill_or_reranking_of_research_candidates(self):
        rejected = copy.deepcopy(self.row)
        rejected.update(tokens=[1], composite=100.)
        rejected['metrics']['native_strict_passed'] = False
        rows = [self.row, rejected]
        before = copy.deepcopy(rows)
        result = self.qualify(rows)
        self.assertEqual(rows, before)
        self.assertEqual([r['tokens'] for r in result['champions']], [[0]])
        self.assertEqual([r['tokens'] for r in result['rejected']], [[1]])


if __name__ == '__main__':
    unittest.main()
