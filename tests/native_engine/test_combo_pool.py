"""组合成员池分层(勾选「组合因子」)的纯 Python 单元测试——无 GPU 依赖。

口径与 src/lib/mining/combo-super.ts(selectComboMembers)同构:
优质(合格+研究级)按综合分截断 ≤5;不足 2 个回捞失败因子——先筛样本外
仍盈利者(test_metrics.sortino>0),一个都没有再按综合分放宽。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'native-engine'), str(ROOT/'public/pykernel')]
from engine.precise_ti import combo_member_pool


def candidate(name, composite, *, status='qualified', reasons=None, test_sortino=None):
    metrics = {}
    if test_sortino is not None:
        metrics['test_metrics'] = {'sortino': test_sortino}
    item = {'tokens': [hash(name) % 1000], 'composite': composite, 'metrics': metrics}
    if reasons is not None:
        item['qualification'] = {'status': status, 'reasons': reasons}
    return item


def qualified_dict(champions, rejected):
    return {'champions': champions, 'pending': [], 'rejected': rejected}


EXEC_ONLY = ['holdout_stress_failed_or_missing']
NON_EXEC = ['wf_oos_fold_failed']


class ComboMemberPoolTests(unittest.TestCase):
    def test_combo_off_keeps_legacy_pool_unchanged(self):
        champions = [candidate('a', 1), candidate('b', 2)]
        rejected = [candidate('r', 5, status='rejected', reasons=EXEC_ONLY)]
        pool, source = combo_member_pool(qualified_dict(champions, rejected), combo_super=False)
        self.assertEqual([id(c) for c in pool], [id(c) for c in champions + rejected])
        self.assertEqual(len(pool), 3)
        self.assertIsNone(source)

    def test_quality_pool_capped_at_five_by_composite(self):
        champions = [candidate(f'q{i}', i) for i in range(7)]
        pool, source = combo_member_pool(qualified_dict(champions, []), combo_super=True)
        self.assertEqual([c['composite'] for c in pool], [6, 5, 4, 3, 2])
        self.assertEqual(source, 'quality')

    def test_rescue_prefers_out_of_sample_profitable(self):
        champions = []
        rejected = [
            candidate('loss', 9, status='rejected', reasons=NON_EXEC, test_sortino=-0.5),
            candidate('win2', 1, status='rejected', reasons=NON_EXEC, test_sortino=0.3),
            candidate('win1', 2, status='rejected', reasons=NON_EXEC, test_sortino=0.8),
        ]
        pool, source = combo_member_pool(qualified_dict(champions, rejected), combo_super=True)
        # 按样本外证据降序回捞,样本外亏损者不入池
        self.assertEqual([c['metrics']['test_metrics']['sortino'] for c in pool], [0.8, 0.3])
        self.assertEqual(source, 'rescued')

    def test_rescue_falls_back_to_composite_when_none_profitable(self):
        rejected = [
            candidate('x', 7, status='rejected', reasons=NON_EXEC, test_sortino=-0.4),
            candidate('y', 2, status='rejected', reasons=NON_EXEC, test_sortino=-0.1),
        ]
        pool, source = combo_member_pool(qualified_dict([], rejected), combo_super=True)
        self.assertEqual([c['composite'] for c in pool], [7, 2])
        self.assertEqual(source, 'rescued')

    def test_research_grade_counts_as_quality(self):
        champions = [candidate('q', 1)]
        rejected = [
            candidate('research', 5, status='rejected', reasons=EXEC_ONLY, test_sortino=0.2),
            candidate('failed', 9, status='rejected', reasons=NON_EXEC, test_sortino=0.9),
        ]
        pool, source = combo_member_pool(qualified_dict(champions, rejected), combo_super=True)
        # 研究级属优质池(与冠军一起按综合分),非执行级拒因者不进优质池;
        # 优质池 ≥2 → 不回捞,失败因子里的 0.9 不入池
        self.assertEqual([c['composite'] for c in pool], [5, 1])
        self.assertEqual(source, 'quality')

    def test_not_enough_members_yields_no_source(self):
        pool, source = combo_member_pool(qualified_dict([], []), combo_super=True)
        self.assertEqual(pool, [])
        self.assertIsNone(source)


if __name__ == '__main__':
    unittest.main()
