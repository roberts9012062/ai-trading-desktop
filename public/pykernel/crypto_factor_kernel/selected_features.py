"""Select formula features without changing any feature or VM arithmetic."""
import numpy as np
from .features.compute import FEATURE_NAMES, compute_selected_features
from .token_encoding import FEAT_OFFSET, V3_FEAT_OFFSET, is_v3_tokens

def feature_matrix(bars, tokens, *, normalization_window=None):
    offset = V3_FEAT_OFFSET if is_v3_tokens(tokens) else FEAT_OFFSET
    names = {FEATURE_NAMES[int(t)] for t in tokens if 0 <= int(t) < min(offset, len(FEATURE_NAMES))}
    features = compute_selected_features(bars, needed_names=names, normalization_window=normalization_window)
    matrix = np.zeros((len(FEATURE_NAMES), len(bars)))
    for name in names:
        matrix[FEATURE_NAMES.index(name)] = features[name]
    return matrix
