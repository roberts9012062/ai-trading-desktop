"""Structural research diagnostics. Never changes historical formula values.

Sign domains describe the expression BEFORE the VM's final rolling zscore.
A one-sided domain is not proof of an always-long normalized trading signal.
Kept byte-identical in both desktop Python kernels.
"""
from itertools import product
import re


def inspect_formula(tokens, features, ops, offset, extra_features=None):
    feature_map = dict(enumerate(features))
    feature_map.update(extra_features or {})
    nodes, stack, warnings, errors = [], [], [], []

    def warn(code, index, message):
        warnings.append(dict(code=code, index=index, message=message))

    for i, token in enumerate(tokens):
        if type(token) is not int or token < 0:
            errors.append(f"步骤{i}: token 必须为非负整数")
            break
        if token in feature_map:
            node = dict(index=i, token=token, name=feature_map[token], signs=[-1, 0, 1],
                        depth=1, lookback=0, feature_ids=[token], chain=0, children=[], ranks=0, zscores=0)
        elif offset <= token < offset + len(ops):
            name, _, arity = ops[token-offset]
            if len(stack) < arity:
                errors.append(f"步骤{i}: {name} 缺少操作数")
                break
            args = stack[-arity:]
            del stack[-arity:]
            domains = [set(a['signs']) for a in args]
            signs = set(domains[0])
            if name == 'NEG':
                signs = {-s for s in signs}
            elif name == 'ABS':
                signs = {abs(s) for s in signs}
            elif name.startswith('TS_STD'):
                signs = {0, 1}
            elif name.startswith('TS_RANK'):
                signs = {1}  # rank uses <=, so minimum is 1/window
            elif name == 'STEP':
                signs = {0, 1}
            elif name in ('ADD', 'SUB', 'MUL', 'DIV', 'MIN', 'MAX'):
                signs = set()
                for a, b in product(*domains):
                    if name == 'SUB': b = -b
                    if name in ('ADD', 'SUB'):
                        signs.update({-1, 0, 1} if a*b < 0 else {a or b})
                    elif name in ('MUL', 'DIV'):
                        signs.add(a*b)
                    elif name == 'MIN': signs.add(min(a, b))
                    else: signs.add(max(a, b))
            elif name.startswith(('TS_ZSCORE', 'ROBUST_ZSCORE', 'DELTA', 'TS_CRANK')) or name in ('TS_DEMEAN_20', 'TS_ATR_NORM', 'CORR_20', 'BETA_20', 'RESID_20'):
                signs = {-1, 0, 1}
            # Remaining ops preserve the input sign domain: smoothing, lag,
            # signed SQRT/LOG/SIGMOID, tanh, winsor, vol_scale and SNR.
            window = re.search(r'_(\d+)$', name)
            lookback = (int(window[1]) - (0 if name.startswith(('DELTA', 'LAG')) else 1)) if window else 0
            one_sided = not (-1 in signs and 1 in signs)
            chain = max(a['chain'] for a in args) + 1 if one_sided else 0
            node = dict(index=i, token=token, name=name, signs=sorted(signs),
                        depth=1+max(a['depth'] for a in args),
                        lookback=max(a['lookback'] for a in args)+lookback,
                        feature_ids=sorted({f for a in args for f in a['feature_ids']}),
                        chain=chain, children=[a['index'] for a in args],
                        ranks=max(a['ranks'] for a in args)+int('RANK' in name),
                        zscores=max(a['zscores'] for a in args)+int('ZSCORE' in name))
            if name == 'DIV' and args[1]['ranks']:
                warn('rank_divisor', i, '分位/中心分位作除数会非线性放大信号；中心分位还可能接近零，须审查分支贡献和成本压力')
            if 'RANK' in name and node['ranks'] > 1:
                warn('nested_rank', i, '连续排名衡量相对位置变化，不保留原始价格趋势方向')
            if 'ZSCORE' in name and node['zscores'] > 1:
                warn('nested_normalization', i, '多层标准化的零点是各自历史均值，正分不能直接解释为价格上涨')
        else:
            errors.append(f"步骤{i}: 未知 token {token}")
            break
        nodes.append(node)
        stack.append(node)
    if not errors and len(stack) != 1:
        errors.append('公式结束时必须恰好剩余一个结果')
    root = stack[-1] if len(stack) == 1 else None
    if root:
        if root['chain'] >= 2:
            errors.append(f"公式末尾单侧值域/恒正感染（链长 {root['chain']}）；最终标准化也不代表原始趋势方向")
        if root['depth'] > 10:
            errors.append(f"公式树深 {root['depth']} 超过研究准入上限 10，须简化重复嵌套")
        if root['lookback'] > 600:
            errors.append(f"累计算子依赖 {root['lookback']} 根超过研究准入上限 600")
        volatility = {'ATR14', 'RVOL', 'HL_RANGE', 'CRYPTO_VOL20', 'TOD', 'NIGHT', 'DOW', 'DOM'}
        if all(feature_map[f] in volatility for f in root['feature_ids']):
            warn('non_directional_inputs', root['index'], '仅波动/日历输入；可以研究统计 alpha，但不能把其正负直接解释成价格趋势，必须证明样本外扣费收益')
    return dict(nodes=nodes, errors=list(dict.fromkeys(errors)), warnings=warnings,
                depth=root['depth'] if root else 0, lookback=root['lookback'] if root else 0,
                feature_ids=root['feature_ids'] if root else [],
                normalization_note='最终滚动 Zscore 以历史均值为零点；正/负分是相对历史偏离，不等于原始涨/跌方向。')
