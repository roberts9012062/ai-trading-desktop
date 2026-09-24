# openspec 交接：STRENGTH 特征同步（桌面端实施清单）

> 产出方：服务端（qihuo）。接收方：桌面端仓库维护者。
> 日期：2026-09-01。前置：v0.1.30 已发布（.2 口径两端已对齐），本项为
> 两端特征层完整同源的补齐，**不改变任何既有因子的数值**（append-only）。

## 一、背景

服务端 `features` 在扩容批次 3 追加了 `STRENGTH` 特征（id 35，图表强弱
指标主值同口径），桌面端 8-21 的内核拷贝早于该提交。当前两端特征清单
前 35 个**完全同序**，唯一差集 = `STRENGTH`：

- desktop `FEAT_COUNT = 35`（尾部 `KURT20, DOW, DOM`）
- server  `FEAT_COUNT = 36`（尾部 `DOW, DOM, STRENGTH`）

影响：服务端挖出/收藏的公式若含 STRENGTH token（feature id 35），桌面端
无法执行该 token（越界或语义错位）；公式文案两端不同源。补齐后 token
可跨端互认。

## 二、交付物（三处，均为 append-only）

### 1. 强弱内核整文件复制（无任何改动）

源：服务端仓库 `D:\newobj\qihuo\backend\app\services\signal_strength.py`（281 行）
目标：`public/pykernel/signal_strength.py`

该文件**纯标准库**（math + typing），无 numpy、无相对 import、无应用层
依赖——可整文件逐字复制，一字不改。文件名与服务端保持一致，后续两端
diff 友好。它同时是图表强弱指标（V1）的计算内核，数值口径注意事项都在
文件头注释里（全程 float64、half-up 舍入勿用内置 round 等）。

### 2. features.py 挂载（两小处）

`public/pykernel/factor_lab/features.py`：

```python
# 文件头部 import 区追加
from ..signal_strength import DEFAULT_STRENGTH_PARAMS, calc_strength
# 若相对层级不便，也可 from pykernel.signal_strength import ...，
# 与既有包加载方式保持一致即可

# compute_features 的 raw dict 末尾（KURT20 之后）追加：
        # ── 扩容批次3（id 35）：强弱值（图表强弱指标同口径，默认参数）──
        "STRENGTH": strength_series(bars),

# FEATURE_NAMES 元组末尾（DOM 之后）追加：
    # ── 扩容批次3（id 35）：强弱值 ──
    "STRENGTH",
```

`strength_series` 包装函数（服务端 `features/strength.py` 原文，仅 import
路径随上调整；因桌面端是单文件 features.py，函数体直接并入即可）：

```python
# 因子语境用默认参数（14/3/1/10）：与图表默认副图一致，保证特征语义
# 与用户所见曲线同源；挖掘侧如需自定义窗口应另立特征名（append-only）
_STRENGTH_PARAMS = DEFAULT_STRENGTH_PARAMS


def strength_series(bars: list[dict[str, Any]]) -> np.ndarray:
    """强弱主值序列映射到 [-1, 1]：0 → -1，100 → +1

    窗口不满（bars 少于 period 根）时无输出，头部补 0（与其它特征
    的头部置零惯例一致，zscore 后不产生假信号）。
    """
    res = calc_strength(bars, _STRENGTH_PARAMS)
    out = np.zeros(len(bars), dtype=float)
    first = int(_STRENGTH_PARAMS["period"]) - 1
    points = res["points"]
    for k, point in enumerate(points):
        # 输出点取二次平滑序列；smooth2=1（默认）时与主序列位级相同
        out[first + k] = float(point["close"]) / 50.0 - 1.0
    return out
```

注意：STRENGTH 放在 `raw` dict（**随价量类走 `_zscore_causal`**），不是
时间/日历类的免归一化通道——服务端口径如此。

### 3. express.py 文案

`_FEAT_TEXT` 末尾（DOM 之后）追加（服务端原文）：

```python
    # 服务端独有特征（图表强弱指标主值同口径，桌面端 pykernel 无此项）——
    # P2-12 守卫测试 test_express_text_coverage 抓到的漏配
    "STRENGTH": "强弱值",
```

## 三、约束与校验点

1. **append-only 纪律**：只能尾插，id 35 固定；前 35 个特征顺序不可动。
   追加后 `FEAT_COUNT = 36 ≤ MAX_FEATURES = 64`（两端同值），vm.py 的
   冻结检查自然通过。
2. **token 兼容性**：旧 token（feature id ≤ 34）语义不变；id 35 两端
   对齐后，含 STRENGTH 的公式可跨端执行/收藏。
3. **不升 kernel_version**：追加特征不改变既有因子的任何数值输出
   （对不含 STRENGTH 的公式是纯超集），沿用当前版本号即可；若桌面端
   希望标记功能差异，属产品版本（tauri）范畴，与内核口径戳无关。
4. **GPU 镜像自查**：桌面端 WebGPU 粗排（eval-core.ts / WGSL）若在 GPU
   侧实现特征矩阵，需同步补 STRENGTH 的特征计算（同款映射 + 因果
   zscore）；否则含该特征的公式在 GPU 粗排会失真。参照 P0-2 归一化
   同步进 GPU 镜像的做法。
5. **数值同源验证**：取同一份真实 bars（如 ma2701 日线），两端各跑
   `feature_matrix`，比对 STRENGTH 行逐位一致；signal_strength.py 逐字
   复制 + wrapper 同式的前提下，不一致只可能出在挂载位置（raw 通道）
   或 bars 字段缺失处理上。

## 四、验收

- `set(FEATURE_NAMES) ⊆ set(_FEAT_TEXT)` 守卫通过（verify-kernel-text.py）
- `FEAT_COUNT == 36`，且 `[f for f in FEATURE_NAMES[:35]]` 与同步前一致
- 同份 bars 两端 STRENGTH 行逐位一致（浮点完全相等）
- 旧 token 公式（回归用例）输出与同步前逐位一致
