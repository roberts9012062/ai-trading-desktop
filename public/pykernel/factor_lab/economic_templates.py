"""Bounded economic and paper-inspired hypotheses, never live approval."""
import json
from pathlib import Path
from .features import FEATURE_NAMES
from .ops import OP_INDEX
from .token_encoding import FEAT_OFFSET


def economic_templates():
    f = {name: i for i, name in enumerate(FEATURE_NAMES)}
    op = {name: i + FEAT_OFFSET for name, i in OP_INDEX.items()}
    specs = (
        ('flow_absorption', 'TAKER_IMB24', 'CRYPTO_MOM24', 'SUB'),
        ('carry_flow', 'TAKER_IMB24', 'FUNDING_MEAN24', 'SUB'),
        ('oi_flow_confirm', 'OI_TREND24', 'TAKER_IMB24', 'MUL'),
    )
    out = []
    for family, left, right, combine in specs:
        tokens = [f[left], f[right], op[combine], op['TS_MA_60']]
        out.extend([{'family': family, 'tokens': tokens},
                    {'family': family, 'tokens': [*tokens, op['NEG']]}])
    registry=json.loads(Path(__file__).with_name('paper_factor_catalog.json').read_text(encoding='utf8'))
    vocabulary={**f,**op}
    for row in registry['factors']:
        tokens=[vocabulary[name] for name in row['rpn']]
        out.extend([{'family':row['id'],'tokens':tokens,'sources':row['sources']},
                    {'family':row['id'],'tokens':[*tokens,op['NEG']],'sources':row['sources']}])
    return out
