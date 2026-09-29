"""Native strict gate; retain CPU metadata, gate order and scalar decisions."""
from factor_local import _strict_eval_context
from factor_lab.market import is_crypto
from collections import OrderedDict
import copy

from .wf_ti import (GpuResearchContext, evaluate_on_slice, executable_on_slice,
                    live_discrete_on_slice, walk_forward_eval, MIN_TEST_BARS)


class StrictContext:
    def __init__(self, bars, config, *, resident=None, metadata=None, signatures=None):
        # This existing helper only parses scalar config and frozen bar/peer
        # splits. Numerical evaluation below is exclusively native CUDA.
        self.metadata = _strict_eval_context(config, bars) if metadata is None else metadata
        self.bars = self.metadata["all_bars"]
        if resident is not None and len(self.bars) != resident.visible_length:
            resident = resident.frozen_prefix(len(self.bars)) if (is_crypto(self.bars)
                       and len(self.bars) < resident.visible_length) else None
        self.research = GpuResearchContext(self.bars, self.metadata["timeframe"], self.metadata["cost"], resident=resident)
        self.research.signatures.update({key: value for key, value in (signatures or {}).items()
                                        if key[0] == 0 and key[1] <= len(self.bars)})
        self.peers = {}
        self.verdicts = OrderedDict()  # Proof only; never a numerical/cache shortcut.

    def peer_context(self, symbol, bars):
        key = (symbol, id(bars))
        if key not in self.peers:
            self.peers[key] = GpuResearchContext(bars, self.metadata["timeframe"], self.metadata["cost"], cache_bytes=64*1024*1024)
        return self.peers[key]

    def dispose(self):
        self.research.dispose()
        for peer in self.peers.values():
            peer.dispose()
        self.peers.clear()
        self.verdicts.clear()
        self.metadata = self.bars = None


def strict_gate(tokens, context):
    ctx, research = context.metadata, context.research
    all_bars, test_bars, train_bars = ctx["all_bars"], ctx["test_bars"], ctx["train_bars"]
    plan, cost, use_test = ctx["plan"], ctx["cost"], bool(ctx["use_test"])
    folds = int(ctx.get("walk_forward_folds") or 0)
    cross_scores = {}
    if use_test and test_bars:
        lo = len(all_bars)-len(test_bars) if all_bars else 0
        test = evaluate_on_slice(research, tokens, lo, len(all_bars), cost)
        if test is None or test["sortino"] <= 0:
            return False, cross_scores
        stressed = evaluate_on_slice(research, tokens, lo, len(all_bars), cost*2.0)
        if stressed is None or stressed["sortino"] <= 0:
            return False, cross_scores
        if ctx.get("live_fill_gate") and test.get("live_fill_sortino", 0) <= 0:
            return False, cross_scores
        entry = float(ctx.get("live_entry_gate") or 0)
        if entry > 0:
            live = live_discrete_on_slice(research, tokens, lo, len(all_bars), entry, cost)
            if live is None or live["sortino"] <= 0:
                return False, cross_scores
    if folds > 0 and all_bars:
        wf = walk_forward_eval(research, tokens, folds, train_len=len(train_bars) if train_bars else None, plan=plan)
        if wf is None or not wf["wf_stable"]:
            return False, cross_scores
    model = ctx.get("execution_model", "signal_research")
    if plan is not None and model in ("perp_next_open", "spot_long_flat") and use_test and test_bars:
        lo = len(all_bars)-len(test_bars) if test_bars else plan.train_end
        if lo <= 0 or lo >= len(all_bars)-2:
            return False, cross_scores
        for stress in (1.0, 2.0):
            metrics = executable_on_slice(research, tokens, lo, len(all_bars), model, stress)
            if metrics is None or metrics["sortino"] <= 0:
                return False, cross_scores
            if model == "perp_next_open" and metrics.get("n_funding_events", 0) == 0:
                cross_scores["executable"] = "missing_funding_events"
                return False, cross_scores
    peers = ctx.get("cross_peers")
    if peers:
        joint = bool(ctx.get("joint_training")) and bool(train_bars)
        cut = str(train_bars[-1].get("time") or "") if joint else None
        for peer, bars in peers:
            if not bars:
                continue
            lo = next((i for i, b in enumerate(bars) if str(b.get("time") or "") > cut), len(bars)) if joint else 0
            if len(bars)-lo < MIN_TEST_BARS:
                continue
            peer_research = context.peer_context(peer, bars)
            metrics = evaluate_on_slice(peer_research, tokens, lo, len(bars), cost)
            if metrics is not None:
                cross_scores[peer] = float(metrics["sortino"])
        if cross_scores:
            positives = sum(1 for value in cross_scores.values() if value > 0)
            if positives < (len(cross_scores)+1)//2:
                return False, cross_scores
    return True, cross_scores


def strict_eval(context, candidates):
    # Gate/cache order is observable in the frozen CPU oracle; retain incoming
    # order and duplicates, rather than reusing training's work scheduling.
    result = []
    decoded = []
    for raw in candidates:
        tokens = [int(t) for t in raw if isinstance(t, (int, float))]
        if not tokens:
            continue
        decoded.append(tokens)
    batch = None
    previous = context.research.prefetched_slices
    try:
        if 4 <= len(decoded) <= 128:
            from .slice_batch_ti import BatchSlices
            batch = BatchSlices(context.research)
            ctx = context.metadata
            n, cost = len(ctx['all_bars']), ctx['cost']
            active = decoded
            if ctx['use_test'] and ctx['test_bars']:
                lo = n-len(ctx['test_bars'])
                batch.prefetch(active, [(lo, n, cost)])
                active = [t for t in active if batch.peek(t, lo, n, cost) is not None
                          and not batch.peek(t, lo, n, cost)['sortino'] <= 0]
                batch.prefetch(active, [(lo, n, cost*2)])
                active = [t for t in active if batch.peek(t, lo, n, cost*2) is not None
                          and not batch.peek(t, lo, n, cost*2)['sortino'] <= 0]
            folds = int(ctx.get('walk_forward_folds') or 0)
            if ctx['plan'] is None and folds > 0:
                seg = n//(folds+1)
                if seg >= MIN_TEST_BARS:
                    requests = []
                    for i in range(1, folds+1):
                        a, b = i*seg, (i+1)*seg if i<folds else n
                        requests.extend(((0, a, cost), (a, b, cost)))
                    batch.prefetch(active, requests)
            context.research.prefetched_slices = batch.results
        for tokens in decoded:
            passed, scores = strict_gate(tokens, context)
            result.append({"tokens": tokens, "pass": bool(passed), "cross_scores": scores})
            key = tuple(tokens)
            context.verdicts[key] = (bool(passed), copy.deepcopy(scores))
            context.verdicts.move_to_end(key)
            while len(context.verdicts) > 128:
                context.verdicts.popitem(last=False)
    finally:
        context.research.prefetched_slices = previous
        if batch is not None:
            batch.dispose()
    return result
