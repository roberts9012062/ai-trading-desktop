"""Frozen bar identities; metadata only, using the unchanged CPU byte format."""
import hashlib

KEYS = ("time", "open", "high", "low", "close", "volume", "open_interest",
        "_factor_market", "funding_rate", "quote_volume", "taker_imbalance",
        "taker_buy_volume", "trade_count", "long_short_ratio", "liquidation_imbalance")


def freeze_prefix_signatures(bars, ends):
    requested = set()
    for end in ends:
        if type(end) is not int or not 0 <= end <= len(bars):
            raise ValueError("Invalid frozen prefix endpoint")
        requested.add(end)
    result = {(0, 0): (0,)} if 0 in requested else {}
    digest = hashlib.sha256()
    for index in range(max(requested, default=0)):
        digest.update(repr(tuple(bars[index].get(key) for key in KEYS)).encode("utf-8"))
        end = index + 1
        if end in requested:
            result[0, end] = (end, digest.digest())
    return result


def report_prefix_ends(metadata, total):
    """Calendar endpoints known at setup, independent of candidate tokens."""
    n, train, test = (len(metadata[key]) for key in ('all_bars', 'train_bars', 'test_bars'))
    ends = {0, n, train, total}
    if test >= 480:
        q, lo = test//4, n-test
        ends.update(lo+k*q for k in range(1, 4))
    folds = int(metadata.get('walk_forward_folds') or 0)
    if metadata['plan'] is None and folds > 0:
        seg = n//(folds+1)
        if seg >= 120:
            ends.update(i*seg for i in range(1, folds+1))
    return ends
