"""桌面端本地专属特征批次(id 36-39)的不变量测试。

- 因果性:打乱后段数据不得影响前段特征输出(无未来函数);
- append-only:前 36 个特征名与标准空间一致(顺序不可动,token 兼容);
- 文案覆盖:FEATURE_NAMES ⊆ _FEAT_TEXT(to_text 不露英文名);
- local_only 打标:含 id ≥ 36 token 的公式在内核出口带 local_only=True。
用法: python scripts/verify-local-features.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "pykernel"))

import numpy as np  # noqa: E402

import factor_local  # noqa: E402
from factor_lab.express import _FEAT_TEXT, to_text  # noqa: E402
from factor_lab.features import FEATURE_NAMES, compute_features  # noqa: E402

# 与服务端 FEATURE_NAMES 对齐的标准空间(顺序即 token id,冻结)
STANDARD_FEATURES = (
    "RET", "RET5", "RET20", "MA_DIFF", "SLOPE20", "ATR14", "RVOL",
    "HL_RANGE", "DEV", "RSI14", "AC1", "VOL_RATIO", "VOL_Z", "PV_CORR",
    "OI_CHG", "OI_PV", "VOL_OI", "TOD", "NIGHT", "GAP", "CLOSE_POS",
    "UPPER_SHADOW", "LOWER_SHADOW", "BODY", "RET60", "MA_DIFF60",
    "VOLAT_RATIO", "OI_PC", "OI_CHG5", "OI_CHG20", "VOL_OI_MA", "SKEW20",
    "KURT20", "DOW", "DOM", "STRENGTH",
)
LOCAL_FEATURES = ("STREAK", "VWAP_DEV", "UPDOWN_VOL_RATIO", "CHAN_POS")


def _make_bars(n: int = 300, seed: int = 23) -> list:
    rng = np.random.default_rng(seed)
    steps = rng.normal(0, 0.015, n)
    close = 1000.0 * np.cumprod(1.0 + steps)
    out = []
    for i in range(n):
        o = close[i] / (1.0 + abs(steps[i]))
        out.append(
            {
                "time": f"2025-01-{(i % 28) + 1:02d}T10:00",
                "open": float(o),
                "high": float(max(o, close[i]) * 1.002),
                "low": float(min(o, close[i]) * 0.998),
                "close": float(close[i]),
                "volume": float(1000 + rng.integers(0, 500)),
            }
        )
    return out


def test_append_only() -> None:
    """前 36 个特征与标准空间逐项一致;本地批次紧随其后"""
    assert FEATURE_NAMES[:36] == STANDARD_FEATURES, "标准特征顺序被动过(token 兼容被破坏)"
    assert FEATURE_NAMES[36:40] == LOCAL_FEATURES, "本地专属批次应紧跟标准空间之后"
    # v0.2.14 为 52;v0.2.16 起追加直连数据特征 52-58(FUNDING_RATE 等),
    # append-only 扩容后同步计数。新增批次必须在此处同步登记。
    assert len(FEATURE_NAMES) == 62, f"特征计数应为 62(含 52-58 直连批次与 59-61 永续结构批次), 实际 {len(FEATURE_NAMES)}"


def test_text_coverage() -> None:
    """全部特征有中文文案;含本地特征的公式可正常渲染"""
    missing = [n for n in FEATURE_NAMES if n not in _FEAT_TEXT]
    assert not missing, f"文案缺失: {missing}"
    # STREAK = 特征 id 36;TS_MA_10 = 算子 id 14 + FEAT_OFFSET(64)
    tokens = [36, 14 + 64]
    text = to_text(tokens)
    assert "连涨连跌" in text, f"本地特征文案未生效: {text}"


def test_causality() -> None:
    """打乱后段数据,前 200 根的特征输出必须逐位不变(无未来函数)"""
    bars = _make_bars(300)
    rng = np.random.default_rng(99)
    head = 200
    base = compute_features(bars)
    # 重排/篡改后段 100 根
    tail = [dict(b) for b in bars[head:]]
    rng.shuffle(tail)
    for b in tail:
        b["close"] = float(b["close"] * 1.5)
    mixed = bars[:head] + tail
    altered = compute_features(mixed)
    for name in FEATURE_NAMES:
        a = base[name][:head]
        b = altered[name][:head]
        assert np.array_equal(a, b), f"特征 {name} 违反因果性(前段输出被后段数据改变)"


def test_local_only_stamp() -> None:
    """local_only 判定:特征 token ∈ [36,64) 才算本地专属;算子 token(≥64)不算

    曾有 bug:t >= 36 的判定漏掉算子区间排除,把所有含算子的公式都误判
    为本地专属——本用例固定守护该边界。
    """
    mark = factor_local._mark_local_only
    assert mark({"s": 1.0}, [36])["local_only"] is True  # 本地特征 id 36
    assert mark({"s": 1.0}, [39])["local_only"] is True  # 本地特征 id 39
    assert mark({"s": 1.0}, [0, 64])["local_only"] is False  # RET + 算子ADD
    assert mark({"s": 1.0}, [35, 78])["local_only"] is False  # STRENGTH + 算子
    # 纯函数:不改入参
    src = {"s": 1.0}
    mark(src, [36])
    assert "local_only" not in src


def test_matrix_shape() -> None:
    """特征矩阵 [F,T] 尺寸随批次扩展,F=40 ≤ MAX_FEATURES=64"""
    from factor_lab.features import clear_feature_matrix_cache, feature_matrix

    clear_feature_matrix_cache()
    bars = _make_bars(120)
    mat = feature_matrix(bars)
    assert mat.shape == (len(FEATURE_NAMES), 120), f"矩阵形状异常: {mat.shape}"
    assert np.isfinite(mat).all(), "特征矩阵含 NaN/Inf"


def test_mine_portfolio() -> None:
    """组合评估模式(M4):≥2 个可执行因子返回等权/IC 加权对照结构"""
    bars = _make_bars(200)
    payload = json.dumps(
        {
            "symbol": "rb",
            "timeframe": "1d",
            "cost": None,
            "tokens_list": [[3], [8]],  # 单特征因子 MA_DIFF、DEV(后缀栈式合法)
        }
    )
    out = json.loads(factor_local.run_mine_portfolio(json.loads(payload), bars))
    p = out.get("portfolio")
    assert p is not None, "两个可执行因子应有组合结果"
    for key in ("n_factors", "avg_abs_corr", "equal", "best_single"):
        assert key in p, f"组合结果缺字段: {key}"
    assert p["n_factors"] == 2
    # 单因子:返回 None(组合无意义)
    single = json.loads(
        factor_local.run_mine_portfolio(
            {"symbol": "rb", "timeframe": "1d", "tokens_list": [[3]]},
            bars,
        )
    )
    assert single["portfolio"] is None


def test_llm_vocab() -> None:
    """LLM 种子词表模式(M5):特征/算子清单与内核注册表逐项一致"""
    out = json.loads(factor_local.run_llm_vocab({}, []))
    assert out["feat_offset"] == 64
    feats = out["features"]
    ops = out["ops"]
    assert [f["name"] for f in feats] == list(FEATURE_NAMES), "特征词表顺序与注册表不符"
    assert all("text" in f for f in feats), "特征词表缺中文文案"
    assert [o["id"] for o in ops] == list(range(64, 64 + len(ops))), "算子 id 应从 64 连续编号"
    assert all(o["arity"] in (1, 2) for o in ops), "算子元数异常"
    # 本地专属特征在词表中(含文案,LLM 可引用)
    local_names = {f["name"] for f in feats[36:40]}
    assert local_names == {"STREAK", "VWAP_DEV", "UPDOWN_VOL_RATIO", "CHAN_POS"}


def test_cross_peer_symbols() -> None:
    """跨品种伙伴解析:板块映射正确、数量钳 [1,4]、排除自身"""
    out = json.loads(
        factor_local.run_cross_peer_symbols({"symbol": "rb2610", "count": 4}, [])
    )
    assert out["sector"] == "ferrous", f"rb 应属黑色系: {out}"
    # 黑色系流动性排序 rb/hc/i/j/... → 排除 rb 后前 4 = hc/i/j/jm
    assert out["peers"] == ["hc", "i", "j", "jm"], f"伙伴顺序异常: {out}"
    # count 钳制:0 → 1;99 → 4
    one = json.loads(factor_local.run_cross_peer_symbols({"symbol": "rb", "count": 0}, []))
    assert len(one["peers"]) == 1
    four = json.loads(factor_local.run_cross_peer_symbols({"symbol": "rb", "count": 99}, []))
    assert len(four["peers"]) == 4
    # 无板块映射品种 → 空伙伴
    unknown = json.loads(factor_local.run_cross_peer_symbols({"symbol": "zz9999", "count": 4}, []))
    assert unknown["peers"] == []


def test_cross_validate_gate() -> None:
    """跨品种判定:≥⌈K/2⌉ 个伙伴 sortino>0 才通过;无伙伴不误杀"""
    from factor_lab.cross_symbol import cross_validate_tokens

    bars = _make_bars(200)
    # 单因子(纯特征),一个伙伴 → 需 1/1 通过
    ok, scores = cross_validate_tokens([3], [("hc", bars)], "1d", 0.0005)
    assert isinstance(ok, bool) and set(scores.keys()) == {"hc"}
    # 无可用伙伴 → 通过且空 scores(门只在有材料时生效)
    ok2, scores2 = cross_validate_tokens([3], [], "1d", 0.0005)
    assert ok2 is True and scores2 == {}
    # 数据不足(<120 根)的伙伴被剔除
    short = _make_bars(50)
    ok3, scores3 = cross_validate_tokens([3], [("hc", short)], "1d", 0.0005)
    assert ok3 is True and scores3 == {}


def test_mine_shard_equivalence() -> None:
    """分片评估一致性:mine_eval_shard 的评估结果与 mine_precise 内层逐位同源;
    mine_precise 走 evaluated 并入与走 candidates 老路径产出等价 champions"""
    import io
    import contextlib

    bars = _make_bars(300)
    candidates = [[3], [8], [36, 77], [39, 14 + 64], [0, 1, 64]]  # 含本地特征与二元算子

    base_payload = {
        "symbol": "rb", "timeframe": "1d", "train_ratio": 0.7,
        "walk_forward_folds": 0, "top_n": 5, "cost": None,
    }
    # 分片:首次带 bars 初始化,二次空 bars 用缓存
    s1 = json.loads(factor_local.run_mine_shard(dict(base_payload, candidates=candidates), bars))
    s2 = json.loads(factor_local.run_mine_shard({"candidates": candidates[:2]}, []))
    by_tokens = {tuple(e["tokens"]): e for e in s1["evaluated"]}
    assert len(by_tokens) >= 3, f"分片评估应至少 3 条有效: {[e['tokens'] for e in s1['evaluated']]}"
    # 缓存路径结果与首评一致(同 bars 同参数)
    for e in s2["evaluated"]:
        ref = by_tokens[tuple(e["tokens"])]
        assert abs(ref["composite"] - e["composite"]) < 1e-12, "缓存路径评估不一致"

    # 老路径:candidates 直接给 mine_precise
    with contextlib.redirect_stdout(io.StringIO()):
        old = json.loads(
            factor_local.run_mine_precise(dict(base_payload, candidates=candidates), bars)
        )
    # 新路径:evaluated 并入 + 空 candidates
    with contextlib.redirect_stdout(io.StringIO()):
        new = json.loads(
            factor_local.run_mine_precise(
                dict(base_payload, candidates=[], evaluated=s1["evaluated"]), bars
            )
        )
    old_pairs = [(tuple(c["tokens"]), round(c["composite"], 10)) for c in old["champions"]]
    new_pairs = [(tuple(c["tokens"]), round(c["composite"], 10)) for c in new["champions"]]
    assert old_pairs == new_pairs, (
        f"evaluated 并入与老路径 champions 不等价:\nold={old_pairs}\nnew={new_pairs}"
    )


def test_precise_no_f32_leak() -> None:
    """f32 指标泄漏不变量:champions/best_seen 的 metrics 必须是完整内核 f64
    结果(有 sortino/ann_ret);缺 sortino 的 evaluated 条目被护栏挡掉,
    高分也挤不进榜首 —— GPU 的数字只许用于排序,绝不出数。"""
    import io
    import contextlib

    bars = _make_bars(300)
    candidates = [[3], [8], [36, 77], [39, 14 + 64], [0, 1, 64], [5, 77]]
    base = {
        "symbol": "rb", "timeframe": "1d", "train_ratio": 0.7,
        "walk_forward_folds": 0, "top_n": 5, "cost": None,
    }
    with contextlib.redirect_stdout(io.StringIO()):
        res = json.loads(
            factor_local.run_mine_precise(dict(base, candidates=candidates), bars)
        )
    # 1) candidates 路径:每个 champion 的 metrics 都有真实 f64 指标
    for c in res["champions"]:
        m = c["metrics"]
        assert "sortino" in m and "ann_ret" in m, f"champion 缺 f64 指标: {c['tokens']}"
    # 2) 无任何条目带 metrics_f32 标记
    for c in res["champions"]:
        assert "metrics_f32" not in c["metrics"], "champion 带出了 f32 标记"
    for b in res["best_seen"]:
        assert "metrics_f32" not in (b.get("metrics") or {}), "best_seen 混入 f32 条目"

    # 3) 护栏:缺 sortino 的"假 f64"载荷(composite 故意给极高分)必须被挡掉
    fake = [
        {"composite": 99.0, "tokens": [3], "metrics": {"metrics_f32": True}},
        {"composite": 98.0, "tokens": [8], "metrics": {}},  # 无任何指标
    ]
    with contextlib.redirect_stdout(io.StringIO()):
        guarded = json.loads(
            factor_local.run_mine_precise(dict(base, candidates=[], evaluated=fake), bars)
        )
    for c in guarded["champions"]:
        assert c["tokens"] != [3] and c["tokens"] != [8], (
            f"缺 sortino 的条目挤进了 champions: {c['tokens']}"
        )
    assert guarded["champions"] == [], "全为非法载荷时应无冠军(而非 f32 兜底)"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    if failed:
        print(json.dumps({"ok": False, "failed": failed}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({"ok": True, "passed": len(tests)}, ensure_ascii=False))
