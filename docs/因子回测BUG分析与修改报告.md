# 桌面端因子回测 / 因子实验室挖掘 / 超级因子挖掘 —— BUG 分析与修改报告

审查日期：2026-09-01
审查范围：
- 计算内核：`public/pykernel/factor_lab/**`、`public/pykernel/factor_local.py`
- 因子实验室：`src/components/factor-lab/**`、`src/lib/local-factor.ts`、`src/lib/factor-lab-api.ts`
- 超级因子挖掘：`src/components/super-factor/**`、`src/lib/super-factor-api.ts`
- 执行层：`src/workers/pyodide-backtest.worker.ts`、`src/lib/py-worker.ts`、`src/lib/local-backtest.ts`

说明：`dist/pykernel/**` 是 `public/pykernel/**` 的构建产物，两处内容一致，修改只需改 `public/`。
超级因子挖掘的**计算在服务端**（`/api/factor-mining/*`），桌面端只是客户端；但它复用同一份
`factor_lab` 内核（`search_stepwise`），因此下文 P0-2 / P0-3 / P1-4 / P1-7 / P1-8 同样影响它。

---

## 结论摘要

| 编号 | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| P0-1 | 致命 | `factor-search-form.tsx:169-171` | 防过拟合开关用「折叠面板展开状态」当启用位，默认全部失效，UI 却显示「已开启」 |
| P0-2 | 致命 | `factor_lab/vm.py:96-103` | 因子输出用**全样本** mean/std 归一化 → 全局前视偏差，污染搜索、样本外门控与回测 |
| P0-3 | 高 | `factor_lab/scoring/evaluate.py:239-252` | `_ts_ic` 与收益错位一根，度量的是 t+1→t+2；该项在 composite 里权重 0.20（并列最高） |
| P1-4 | 高 | `evaluate.py:352-356` | OOS 硬淘汰名不副实：`oos_mult=0` 使 composite 恒等于 0，排在「诚实的负分因子」之上 |
| P1-5 | 高 | `factor-helpers.ts:103-130` | `championFromHistory` 丢弃 `overfit_warning` → 从历史面板可绕过拦截，把过拟合因子挂实盘 |
| P1-6 | 中高 | `factor_local.py:114-116` | 资金曲线前视一根：`equity[i]` 含 `i→i+1` 的收益却标在 `bars[i].time` |
| P1-7 | 中高 | `walk_forward.py:114`、`MIN_TEST_BARS=30` | 分段独立算特征 → 段首预热期；30 根测试段可能 100% 是噪声，而它正是严格筛的门 |
| P1-8 | 中高 | `search.py:496,548` | walk-forward 传的是 `all_bars`（含训练段），前几折的「测试段」在训练段内部 |
| P1-9 | 中 | `py-worker.ts` / worker | 无取消、无超时、无 unmount 保护；启动失败用 `reqId:0` 上报，无人接收 |
| P2-10 ~ P2-21 | 中/低 | 见下 | 交易次数漏计、实盘口径不一致、中文表达式缺失、缓存键不全、分页去重等 |

---

## P0-1 防过拟合开关整体失效（因子实验室）

**位置**：`src/components/factor-lab/factor-search-form.tsx:150-174`

```tsx
const [showAntiOverfit, setShowAntiOverfit] = useState(false)   // L81：折叠面板展开状态
const [trainRatio, setTrainRatio] = useState(0.7)
const [walkForwardFolds, setWalkForwardFolds] = useState(3)
...
onSearch({
  train_ratio:        showAntiOverfit ? trainRatio : 0,          // L169
  test_recent_bars:   showAntiOverfit ? testRecentBars : 0,      // L170
  walk_forward_folds: showAntiOverfit ? walkForwardFolds : 0,    // L171
})
```

`showAntiOverfit` 是**手风琴的展开/收起状态**，不是功能启用位。默认 `false`，
因此只要用户不手动点开「防过拟合（高级）」面板，三项防护一律以 0 发出；
点开设置好之后再收起，防护又被关掉。

同一文件 L352-357 的角标逻辑是 `!showAntiOverfit && (trainRatio > 0 || ...)` →
面板收起时因为 `trainRatio` 默认 0.7，角标恒显示「**已开启**」，与实际发送的
`train_ratio: 0` 完全相反。L427-431 的说明文字同样声称「默认已开启推荐配置」。
`factor-helpers.ts:17-35` 的 `defaultSearchPayload` 也写着 `train_ratio: 0.7 / walk_forward_folds: 3`，
可见 0.7/3 才是设计意图。

**后果链**（内核侧全部被绕过）：
1. `search.py:235-249`：`anti_overfit` 为 False → `test_bars = []`、`use_test = False`；
2. `search.py:529-562` `_passes_strict`：三个 if 全部跳过 → **对所有候选返回 True**，严格筛形同虚设；
3. 因此永远不会走 L596 的兜底分支 → `overfit_warning` **永远不会被写入**；
4. `champion-table.tsx:84` 的 `showTest` 恒为 false → 测试段列不显示；
5. `use-factor-lab-page.ts:364/388/414` 三处「禁止挂载/收藏过拟合因子」的拦截**永远不触发**。

**修改建议**：加一个独立的启用开关，与展开状态解耦。

```tsx
const [antiOverfitOn, setAntiOverfitOn] = useState(true)   // 默认开启，与文档一致
const [showAntiOverfit, setShowAntiOverfit] = useState(false)  // 仅控制折叠
...
train_ratio:        antiOverfitOn ? trainRatio : 0,
test_recent_bars:   antiOverfitOn ? testRecentBars : 0,
walk_forward_folds: antiOverfitOn ? walkForwardFolds : 0,
```
面板内加一个「启用防过拟合」checkbox 绑定 `antiOverfitOn`；角标条件改为 `antiOverfitOn`。

**回归验证**：默认参数搜索一次，断言请求体 `train_ratio===0.7 && walk_forward_folds===3`，
且返回的 champion 至少带 `test_metrics`。

---

## P0-2 因子归一化使用全样本统计量 —— 全局前视偏差

**位置**：`public/pykernel/factor_lab/vm.py:96-103`

```python
def _normalize_output(x: np.ndarray) -> np.ndarray:
    std = x.std()                       # ← 整段序列的 std
    if std < 1e-6: return x
    z = (x - x.mean()) / std            # ← 整段序列的 mean
    return np.clip(z, -3.0, 3.0)
```

`execute()` 最后一定会调用它，因此**每个因子值都被未来数据归一化过**。
下游 `position_from_factor` 用固定阈值（`NEUTRAL_BAND=0.05`）和 `tanh` 把它变成仓位，
所以 bar t 的仓位取决于整段（含 t 之后）的因子分布。

`features.py` 里所有特征都严格因果（`_zscore_causal` 用的是 `ts_mean/ts_std` 滚动窗），
`ops.py` 的算子也都因果——唯独最后这一步把因果性破坏掉了。文件头「所有时序算子严格因果，
无未来函数」的注释因此不成立。

**影响面**（比看起来大）：
- 搜索适应度：训练段内前视 → composite 系统性偏高；
- **样本外门控本身被污染**：`evaluate_on_segment` 也走 `execute()`，测试段用测试段自己的
  全段统计量归一化 → 所谓 OOS 指标同样含前视，`_passes_strict` 的可信度被削弱；
- walk-forward 每一折同理；
- `factor_local.run_backtest_factor` 的资金曲线同理；
- **实盘不可复现**：实盘只能用截止当下的历史做归一化，与回测的全段归一化必然不同，
  这是「回测好看、实盘对不上」的一个结构性来源。

**修改建议**（推荐 A，B 为保守过渡）：

A. 改为因果滚动归一化，与特征层同源：
```python
from .ops import ts_mean, ts_std
_NORM_WINDOW = 250        # 与 features 的 zscore 窗口取同一量级，可由调用方传入

def _normalize_output(x, window: int = _NORM_WINDOW):
    x = np.asarray(x, dtype=float)
    m = ts_mean(x, window)
    s = ts_std(x, window)
    if float(x.std()) < 1e-6:
        return x
    return np.clip((x - m) / np.maximum(s, 1e-8), -3.0, 3.0)
```
注意：这会改变所有历史 champion 的数值，属于**破坏性变更**。需要
(a) 版本化（在 `kernel_version()` 里升版本号），
(b) 对已收藏/已挂载的因子重算一遍指标并提示用户，
(c) `is_constant` 判据同步复核（滚动归一化后头部会有一段接近 0）。

B. 若暂不能改数值口径：至少在报告里加一列「因果归一化口径的 sortino/ann_ret」，
   与现有全样本口径并列展示，让用户看到差多少（做法可参照现有
   `live_fill_*` / `session_*` 双口径的模式）。

---

## P0-3 `_ts_ic` 与收益错位一根

**位置**：`public/pykernel/factor_lab/scoring/evaluate.py:239-252`

```python
def _ts_ic(factor, ret):          # ret 由 next_ret(close) 传入
    n = min(len(factor) - 1, len(ret) - 1)
    x = factor[:n]
    y = ret[1 : n + 1]            # ← BUG
```

`next_ret` 的定义（L94-99）是 `ret[t] = (close[t+1]-close[t])/close[t]`，**已经是前向收益**。
与 `factor[t]` 对齐的应该是 `ret[t]`，而不是 `ret[t+1]`。当前写法度量的是
「因子 t 与 t+1→t+2 的收益」的相关性，整体多滞后一根。

佐证：
- 同文件的 `_ts_ic_h`（L264-283）就是正确对齐的：`y = fwd[:n]`，并且注释明确写着
  「fwd[t] 已含 t+1..t+h，直接与 factor[t] 对齐」；
- pnl 的计算（L330）用的是 `pos * ret`，即 `pos[t]*ret[t]`，也是 t 对 t 的对齐。
  所以 `_ts_ic` 与同一函数内的 pnl 口径自相矛盾。

**后果**：`ic` 在 composite 里权重 0.20（`evaluate.py:377-385`，与 ann 的 0.30 同为最高梯队），
且注释特意强调「IC 是因子对下根收益的直接预测力，比年化更难造假」——这个高权重项一直在
优化错误的目标。`evaluate_on_segment`（`walk_forward.py:138`）上报的 `ts_ic` 同样错位，
`decay.py` 的衰减判定也复用 `_ts_ic`（衰减监控口径一并受影响）。

**修改**：
```python
    y = ret[:n]                   # factor[t] ↔ ret[t]（ret 已是 t→t+1）
```
同时建议加单测：构造 `factor = next_ret(close)` 自身，`_ts_ic` 应约等于 1.0（当前实现会约等于 0）。

---

## P1-4 OOS 硬淘汰实际是「归零」而非「负分」

**位置**：`evaluate.py:344-356, 377-385`

```python
# 注释：「硬淘汰：样本外为负直接判强负分，不再只乘 0.1」
if oos_negative:
    oos_mult = 0.0
...
composite = (0.30*ann_term + ... + 0.10*consist) * oos_mult
```

`oos_mult = 0.0` 使 composite **恒等于 0.0**，不是负分。产生两个问题：

1. **排序倒挂**：一个训练段极好但样本外亏损的过拟合因子得 0.0；一个各项都平庸、
   composite 本身为 -0.15 的诚实因子反而排在它下面。注释声称的「确保这类因子排不进
   champion」不成立。
2. **排序退化**：所有 OOS 为负的因子全部并列 0.0，`_dedup_top` 的 `sorted(..., reverse=True)`
   对它们完全无区分度，退化为字典序/插入序。

**修改**：
```python
if oos_negative:
    # 加性罚分，保留原始排序信息，同时确保落到负分区
    composite = base_composite - 1.0 + min(0.0, oos_sor) * 0.1
else:
    composite = base_composite * min(1.2, 1.0 + oos_sor * 0.1)
```
其中 `base_composite` 为加权和。注意 `search.py:277` 的 parsimony 惩罚在其之后再减，逻辑不变。

---

## P1-5 历史面板恢复的因子会丢失 `overfit_warning`（安全性问题）

**位置**：`src/components/factor-lab/hooks/factor-helpers.ts:103-130`

```ts
export function championFromHistory(item: FactorHistoryItem): Champion {
  return { ..., metrics: {
      ...emptyMetrics(item.composite),
      ann_ret: ..., sortino: ..., calmar: ..., ts_ic: ...,
      oos_sortino: ..., oos_negative: ..., composite: ...,
      train_metrics: ..., test_metrics: ..., walk_forward: ...,
      // ← overfit_warning 没有被复制
  }}
}
```

这是白名单式复制，`overfit_warning` 不在名单里，`emptyMetrics`（L84-100）也没有它。

**后果**：搜索时被标记为过拟合的因子写进历史后，从「历史面板」重新选中时警告位丢失，
于是 `use-factor-lab-page.ts` 三处拦截全部失效：
- `favoriteFrom` L414 —— 可以收藏；
- `handleBuildTask` L364 —— **可以创建实盘 AI 交易任务**；
- `handleComboMount` L388 —— 可以进组合。

同时被丢弃的还有：`oos_conservative`、`pbo_proxy`、`regime`、`cross_symbol`、`trials`、
`ts_ic_5`、`ts_ic_20`、`avg_turnover`、`exposure` 等（后端算了、UI 也有展示位，但恢复后全为 0）。

对比 `championFromFavorite`（L133-143）用的是 `...(item.metrics as object)` 展开，没有此问题。

**修改**：改为展开优先 + 显式兜底：
```ts
metrics: {
  ...emptyMetrics(item.composite),
  ...(m as Champion["metrics"]),        // 先全量透传
  composite: Number(m.composite ?? item.composite),
}
```
并加一条防御：`handleBuildTask` / `favoriteFrom` 在 metrics 缺 `test_metrics` 且
`train_ratio` 配置非 0 时，也提示「该记录无样本外验证信息」。

---

## P1-6 资金曲线整体前视一根

**位置**：`public/pykernel/factor_local.py:112-134`

```python
pos = position_from_factor(factor)
ret = next_ret(close)                                   # ret[i] = i→i+1 的收益
pnl = pos * ret - np.abs(pos - np.roll(pos, 1)) * cost
pnl[0] = 0.0
equity = initial_cash * (1.0 + np.cumsum(pnl))
curve = [{"time": bars[i]["time"], "equity": equity[i], "position": pos[i], "price": close[i]} ...]
```

`equity[i]` 已经包含了 `ret[i]`（即 i→i+1 期间才会实现的盈亏），却和 `bars[i].time`、
`close[i]`、`pos[i]` 标在同一个点上。图上看起来就是「信号一出，当根就赚钱」。
正确做法是把 pnl 右移一根再累加。

**修改**：
```python
pnl = pos * ret - np.abs(pos - np.roll(pos, 1)) * cost
pnl[0] = 0.0
realized = np.roll(pnl, 1)        # 第 t 根收盘时已实现的是 t-1 根决策的盈亏
realized[0] = 0.0
equity = initial_cash * (1.0 + np.cumsum(realized))
```

**附带问题（同处）**：
- `pnl[0] = 0.0` 抹掉了首根的建仓成本，与 `evaluate_factor`（L328-330，首根保留
  `|pos[0]|*cost`）口径不一致 → 同一因子的曲线终值与 metrics 的 ann_ret 对不上；
- `np.abs(pos - np.roll(pos,1))` 的 index 0 用到了 `pos[-1]`（环绕），虽被 `pnl[0]=0` 掩盖，
  但建议统一写成 `evaluate_factor` 里的 `prev = np.roll(pos,1); prev[0]=0.0` 形式，避免后续改动踩坑。

---

## P1-7 分段独立计算特征 → 测试段预热期污染严格筛

**位置**：`walk_forward.py:103-114`、`MIN_TEST_BARS = 30`（L39）

```python
if not bars or len(bars) < MIN_TEST_BARS: return None
mat = feature_matrix(bars)            # ← 只用这个子段重算特征
```

`feature_matrix` 内部：
- `_zscore_causal(arr, window)`，`window = max(200, 日均bar数)`（`features.py:89-103`）；
- `ts_mean/ts_std` 的头部按「部分窗口」退化（`ops.py:23-32`）；
- 还有 `TS_MA_60`、`TS_ZSCORE_60`、`EMA_20`、`_ac1(20)`、`_rolling_moment(20)` 等长窗口算子。

于是每个子段的**前约 200 根**特征都处在预热区，数值分布与连续运行时完全不同。
而 `MIN_TEST_BARS` 只有 30 —— 一个 30~200 根的测试段，可能 100% 落在预热区，
算出的 `sortino` 基本是噪声。偏偏 `_passes_strict`（`search.py:540-547`）就是拿这个
`sortino > 0` 当严格筛的核心判据，`walk_forward_eval` 的 `wf_stable` 同理。

文件头注释「对 train/test 子段分别调用 feature_matrix 不会泄露未来」是对的——
**不泄露未来，但会丢失过去**，这个代价没有被评估。

**修改建议**：改为「带前置 warmup 的切片评估」——用 `bars[seg_start - W : seg_end]` 计算特征，
再丢弃前 W 根只在 `[seg_start, seg_end)` 上算指标：

```python
WARMUP_BARS = 250   # ≥ 最长算子窗口(60) 与 zscore 窗口(≥200)

def evaluate_on_slice(tokens, all_bars, lo, hi, timeframe, cost):
    w = min(lo, WARMUP_BARS)
    ctx = all_bars[lo - w : hi]
    mat = feature_matrix(ctx)
    factor = execute(tokens, mat)
    if factor is None: return None
    factor = factor[w:]                      # 丢掉预热
    close = np.array([float(b.get("close") or 0) for b in all_bars[lo:hi]])
    ...
```
并把 `MIN_TEST_BARS` 从 30 提到一个有统计意义的值（日线建议 ≥120，分钟线按周期折算）。
`split_bars` / `walk_forward_eval` / `_conservative_oos` / `regime_decompose` / `cross_validate_tokens`
需要一并改为传 (all_bars, lo, hi) 而不是已切好的子段。

注意：`_normalize_output`（P0-2）修好之后，本项的收益会更明显；两者建议一起做。

---

## P1-8 walk-forward 用的是全量 bars，前几折不是样本外

**位置**：`search.py:496-501` 与 `548-553`

```python
if walk_forward_folds > 0 and all_bars:
    wf = walk_forward_eval(tokens, all_bars, timeframe, cost, walk_forward_folds)
```
`all_bars = bars`（L384），即**包含训练段**。`walk_forward_eval` 把它等分 `n_folds+1` 段，
第 i 折用前 i 段训练、第 i+1 段测试。当 `train_ratio=0.7`、`n_folds=3` 时，
前 3 段（75%）几乎全在训练段内 → 第 1、2 折的「测试段」是遗传搜索见过的数据，
`wf_stable` 因此偏乐观，`_passes_strict` 的 WF 门被削弱。

**修改**：两种取向，二选一并在 UI 上写清：
- 严格版：`walk_forward_eval(tokens, test_bars, ...)`，只在 holdout 内滚动（需要 holdout 足够长）；
- 折中版：保留全量滚动，但在 `folds` 里给每折打 `"in_train": bool(test_end <= len(train_bars))` 标记，
  `wf_stable` 只对 `in_train == False` 的折生效，UI 也据此区分显示。

---

## P1-9 Pyodide worker：无取消、无超时、错误可能被吞

**位置**：`src/lib/py-worker.ts`、`src/workers/pyodide-backtest.worker.ts`

1. `rpc()` 返回的 Promise **永远不会因超时被 reject**，只能等 worker 回消息。
   `kernel.run` 是同步阻塞的 Python 调用，一次 pop=100 × gen=50 的搜索可能跑几分钟，
   期间 worker 完全阻塞，所有本地回测/因子请求排队。
2. **无取消能力**：用户点「开始搜索」后无法中止；页面切走后 `pending` 里的条目泄漏，
   Promise resolve 时会对已卸载组件 setState（`use-factor-lab-page.ts` 的 `setBt` / `setResult`）。
3. worker 顶部 L157-159 启动失败时发 `{type:"error", reqId: 0, ...}`，而 `pending` 里
   永远没有 key 0（`reqSeq` 从 1 开始）→ **该错误被静默丢弃**，用户看到的是一直转圈。
4. `{type:"ready"}` 消息在 `py-worker.ts` 的 `onmessage` 里没有分支处理（无害，但
   `WorkerMsg` 类型里声明了，属于死约定）。
5. `selectFactor`（`use-factor-lab-page.ts:117-159`）无请求序号保护：快速点击多个 champion 时
   后发先至会导致「选中 A、显示 B 的回测」。

**修改建议**：
- worker 侧接受 `{type:"cancel", reqId}`；Python 侧在 `search_stepwise` 的每代 yield 点检查
  取消标志（内核已有分代生成器，接入成本低）。当前 `run_search` 走的是一次性 `search()`，
  可改为消费 `search_stepwise` 并顺带上报进度（现在的 `onProgress` 只有两条静态文案）。
- `rpc()` 增加可选 `timeoutMs`，超时 reject 并从 `pending` 删除。
- 启动失败改为广播型错误：`for (const [,p] of pending) p.reject(...)`，或在 `py-worker.ts`
  单独处理 `reqId === 0` 的 error 消息并记入一个模块级 `bootError`，后续 `rpc` 直接 reject。
- `selectFactor` 加 `const seq = ++selectSeq; ... if (seq !== selectSeq) return`。

---

## P2 级问题清单

**P2-10 `evaluate_factor_live` 交易次数漏计反手** —— `evaluate.py:83`
`n_trades = np.sum((pos != 0) & (prev == 0))`，`+1 → -1` 的直接反手不计数，
而 `position_live_discrete` 的状态机（L52-59）允许直接反手。应改为
`np.sum((pos != 0) & (pos != prev))`。

**P2-11 实盘 `session_close` 与回测持仓口径不一致** —— `factor-helpers.ts:53-60`
分钟因子挂实盘时 `session_close: true`（日内强平），但 `evaluate_factor` 的回测是
连续 close→close 持仓、跨夜不平。注释「与回测 bar 内持仓假设一致」不成立。
内核里已有对应口径 `session_aware_metrics`（`evaluate.py:158-170`），但它只是报告项，
champion 表和回测报告展示的主指标仍是非 session 口径。建议：分钟周期的主指标改用
session 口径，或在挂载对话框里明确提示「实盘日内强平，收益会低于回测显示值」。

**P2-12 中文表达式覆盖不全** —— `express.py`
`_OP_TEXT` 只覆盖到 `TS_ATR_NORM`（前 28 个算子），`OPS_CONFIG` 现有 40 个；
`_FEAT_TEXT` 只覆盖 19 个，`FEATURE_NAMES` 现有 35 个。
于是 `LAG_1 / CORR_20 / BETA_20 / RESID_20 / STEP / EMA_5 / EMA_20`、
`GAP / CLOSE_POS / UPPER_SHADOW / SKEW20 / DOW / DOM` 等在公式文本里直接露出英文名。
补齐两张表即可，另建议加一条单测：`set(OPS_NAMES) <= set(_OP_TEXT)`、
`set(FEATURE_NAMES) <= set(_FEAT_TEXT)`，防止后续扩容再次漏配。

**P2-13 `_div` 的数值行为** —— `ops.py:262-263`
`a / max(|b|, 1e-8) * sign(b + 1e-12)`：`b→0` 时放大到 `a×1e8`（虽有下游 clip，
但会让该分支的因子值饱和成常数）；且 `b = -1e-13` 时 `sign(-1e-13 + 1e-12) = +1`，
符号翻转。建议改为 `np.where(np.abs(b) < eps, 0.0, a / b)` 或对分母做对称保护。

**P2-14 `bars_signature` 键不完整** —— `features.py:375-393`
只采样 首/中/尾 三根的 `time` + `close`，不含 open/high/low/volume/open_interest。
同段被增量修正（如最新 bar 的 volume/OI 回补，close 未变）时会命中过期矩阵。
建议把长度 + 首尾时间 + 全量 close 的哈希（或 OHLCV 的 xor 校验和）纳入键。

**P2-15 岛屿可能永久停滞** —— `search.py:339-341`
```python
if not scored or scored[0][3] is None:
    last_scored_per_island.append([]); continue
```
`continue` 跳过了该岛的繁殖，`populations[isl]` 保持原样，下一代仍然全无效 → 该岛永远死掉。
建议改为重新随机初始化该岛种群。

**P2-16 变异无深度上限** —— `search.py:191-206`
`_mutate` 把 `_random_tree(depth ≤ max_depth)` 插到任意节点上，交叉同理，树深可无限增长，
仅靠 `search.py:277` 的 parsimony 罚分（超 12 token 每个扣 0.02）约束。
建议在 `_replace_random` 后加一个深度检查，超限则回退到原树。

**P2-17 K 线分页无去重/排序** —— `local-backtest.ts:36-58`
`all.unshift(...bars)` 直接拼接，若服务端 `end_time` 是闭区间则相邻页会重复一根 bar；
重复 bar 会在 `next_ret` 里产生一个 0 收益并让时间序列非严格递增。
建议按 `time` 去重并排序：
```ts
const map = new Map(all.map(b => [String(b.time), b]))
return [...map.values()].sort((a, b) => String(a.time) < String(b.time) ? -1 : 1).filter(...)
```

**P2-18 轮询无 in-flight 保护** —— `use-mining-tasks.ts:44-48`
`setInterval(refresh, 5000)`，若单次 `apiList()` 超过 5s（`super-factor-api.ts` 超时 30s）
会堆叠请求。建议改为「上一次完成后再排下一次」的递归 `setTimeout`。

**P2-19 `_calmar` 回撤基线不含 0 起点** —— `evaluate.py:227-236`
`peak = np.maximum.accumulate(cum)`，若序列一开始就下跌，回撤是从 `cum[0]` 而非 0 起算，
最大回撤被低估。建议 `cum = np.concatenate([[0.0], np.cumsum(pnl)])`。

**P2-20 `pbo_proxy` 分母含被去重跳过的候选** —— `search.py:567-584`
`n_failed / len(pbo_pool)`，但因 `_corr_dup` 跳过的候选既不计入 `n_failed` 也没从分母剔除，
PBO 被系统性低估。建议分母改为「真正做过 `_passes_strict` 判定的个数」。

**P2-21 跨品种验证在桌面端是死代码** —— `cross_symbol.py:41-44`
`query_history_bars` 被定义为无条件 `raise RuntimeError`，且调用处包在 `try/except: continue` 里，
日线分支必然返回 `[]`。虽然桌面端并不设置 `cross_peers`（`_CFG_FIELDS` 里有该字段但前端不传），
不影响正确性，但这段代码有误导性，建议直接删除日线分支或加显式 `NotImplementedError` 说明。

---

## 建议的修复顺序

**第一批（不改数值口径，风险低，可立即上线）**
1. P0-1 防过拟合开关（纯 UI 逻辑，收益最大）
2. P1-5 `championFromHistory` 全量透传 metrics
3. P1-9 worker 超时 / 错误上报 / `selectFactor` 序号保护
4. P2-10 / P2-12 / P2-17 / P2-18 / P2-19 / P2-20

**第二批（改数值口径，需版本化 + 历史数据重算）**
5. P0-3 `_ts_ic` 对齐（**先做，且单独一个 commit**，便于对比前后 champion 变化）
6. P1-4 OOS 罚分改加性
7. P1-6 资金曲线右移一根 + 首根成本口径统一
8. P1-8 walk-forward 折标记 in_train

**第三批（结构性，建议先在服务端跑对照实验再落地）**
9. P0-2 `_normalize_output` 改因果滚动
10. P1-7 分段评估加 warmup + 提高 `MIN_TEST_BARS`

第二、三批都会改变已持久化 champion 的指标值，落地时必须走下面的发布前检查清单。

---

## 口径变更的发布前检查清单（第二、三批必读）

第二、三批的每一项都会让**同一个因子在新旧内核下算出不同的数字**。
其中 P0-2 尤其特殊：它改变的不只是指标，而是 `position_from_factor` 的输入本身，
**即仓位序列会变** —— 一个正在实盘运行的因子任务，升级后的开平仓行为会与用户当初
验收时看到的不一样。这不是可以静默发布的变更。

以下步骤按顺序执行，**每一步都要留下书面确认，不允许跳过**：

**发布前**
1. **升内核版本号**：`factor_local.kernel_version()`，当前值 `"pykernel-factor-2026-08-23.1"`。
   每批一个新版本号，不要多批共用。
2. **给历史与收藏打版本戳**：在 `factor_history` / `factor_favorites` 的 metrics 里
   写入产出时的 `kernel_version`。旧记录无此字段 → 视为「旧口径」。
3. **盘点受影响的实盘任务**：列出所有 `strategy_type === "factor"` 且状态为运行中/待启动的
   AI 交易任务（`ai_trading_tasks`），逐个记录其 `factor_tokens`、品种、周期、挂载时间。
   **这一步无法自动化判定"影响有多大"，必须人工过目。**
4. **跑新旧口径对照**：对第 3 步清单里的每个因子，用新旧两版内核在同一份 bars 上
   各跑一次 `backtest_factor`，输出对照表（ann_ret / sortino / 最大回撤 / 换手 / 仓位序列差异率）。
   仓位序列差异率 = `mean(pos_new != pos_old)`，P0-2 上线时这个数会显著大于 0。
5. **人工决策关口**：把对照表交给项目负责人（本仓库所有者）确认。
   指标变差或仓位差异率超过阈值（建议 5%）的任务，需要明确决定是「停用」「重新验收」还是「维持」。
   **在收到确认前不要发布。**

**发布时**
6. 优先在**非交易时段**发布（避免升级瞬间实盘任务的信号口径突变）。
7. 发布后 UI 对旧版本戳的历史/收藏记录显示「口径已变更，指标为旧内核产出」提示，
   并禁止从这类旧记录直接挂载实盘（复用 P1-5 修复后的拦截机制，新增一个 `stale_kernel` 标记）。

**发布后**
8. 对第 3 步清单里维持运行的任务，观察至少一个完整交易日，比对实际成交与新回测口径是否吻合。

> 若嫌上述流程重，可以选择只发第二批（P0-3/P1-4/P1-6/P1-8）——它们改的是**指标**，
> 不改仓位序列，第 4 步的仓位差异率恒为 0，第 5 步的决策会轻松很多。
> P0-2 与 P1-7 单独作为第三批发布，把风险隔离开。这也是把它们分成两批的原因。

## 建议补充的测试

内核目前缺少针对这些不变量的断言，建议加：
- `test_ts_ic_alignment`：`factor = next_ret(close)` 时 `_ts_ic ≈ 1.0`
- `test_no_lookahead`：把 bars 尾部截断 20% 后重算，前 80% 的 `factor` / `pos` 应逐位不变
  （当前会因 P0-2 失败，修好后应通过——这是 P0-2 的验收标准）
- `test_equity_matches_metrics`：`run_backtest_factor` 的 `equity[-1]/initial_cash - 1`
  应等于 `metrics.ann_ret * n / periods`（容差内）
- `test_ops_text_coverage`：`_OP_TEXT` / `_FEAT_TEXT` 覆盖全部注册项
- `test_oos_ranking`：构造一个 OOS 为负但训练极好的因子，其 composite 应低于一个
  composite 为负的普通因子

---
---

# 第二部分：本地/服务端双端挖掘 + 本地 CPU/GPU 算力选择 —— 实施方案

本部分是**新功能开发规格**，供接手的 AI 直接执行。目标：

1. 「超级因子挖掘」与「因子实验室挖掘」都支持**本地计算机挖掘**与**服务器计算机挖掘**两种执行位置；
2. 选择本地挖掘时，可再选 **CPU 挖掘**或 **GPU 挖掘**；
3. 两种模式的**历史 K 线数据一律从服务器拉取**（本地只负责算力，不负责数据）。

### 范围约束（硬性，不得扩大）

> **GPU 挖掘只存在于客户端。服务端挖掘一律是 CPU，不做也不暴露 GPU 选项。**

由此推导出的具体要求，实现时逐条遵守：
- 「本地算力（CPU/GPU）」这组控件**仅在「执行位置 = 本地计算机」时出现**；选服务器时整组不渲染。
- 选服务器时，请求体 `device` 恒为 `"cpu"`（维持现有协议，不新增取值）。
- `SupportedInfo.device_options`（`super-factor-api.ts:25`）**不要渲染成算力选择器**。
  它是服务端能力声明，若将来返回了 `gpu` 项，客户端也**必须过滤掉**——
  服务端 GPU 不在产品范围内，渲染出来就是给用户一个点不通的选项。
  该字段目前唯一合理用途是：当服务端声明 `cpu` 不可用时禁用「服务器」这个执行位置。
- 本文档所有 WebGPU / WGSL 相关内容（2.6 探测、2.8 后端、M4 里程碑）**只作用于本地路径**，
  不产生任何后端改动需求。桌面端不需要、也不应该向后端提 GPU 相关接口。

## 2.0 先决条件（必须先做，否则新功能带病上线）

| 依赖 | 原因 |
|---|---|
| **P0-1**（防过拟合开关失效） | 本地长程挖掘会把这个 bug 放大：跑几小时得到一批毫无样本外验证的因子 |
| **P2-17**（K 线分页无去重/排序） | 2.3 的数据层直接建在 `fetchBacktestBars` 上，脏数据会污染所有本地挖掘 |
| **P1-9**（worker 无取消/超时） | 本地长程任务的暂停/取消直接依赖它 |

P0-2 / P0-3 不阻塞本功能，但**建议在 GPU 内核开工前完成 P0-3**：GPU 要按 CPU 口径逐项对齐，
口径本身有 bug 会让对齐工作白做一遍。

> ⚠️ P0-2 / P0-3 属于第一部分「第二、三批」的口径变更，发布前必须走
> **「口径变更的发布前检查清单」**（第一部分末尾），其中第 5 步是人工决策关口，
> 需要项目负责人书面确认后才能发布。**执行方不得自行判定"影响不大"而跳过。**

---

## 2.1 现状盘点（接手前必读）

| 事实 | 位置 | 含义 |
|---|---|---|
| 因子实验室已有「本地/服务端」开关 | `factor-lab-page.tsx:75-84`、`use-factor-lab-page.ts:99-110` | 本地=Pyodide，服务端=HTTP。**已具雏形，需扩展为三态（本地CPU/本地GPU/服务端）** |
| 超级因子挖掘**纯服务端** | `super-factor-page.tsx`、`super-factor-api.ts` | 桌面端只是轮询客户端。`device` 字段已存在但硬编码 `"cpu"`（L194），`SupportedInfo.device_options` 已定义但**未被渲染** |
| 本地算力 = Pyodide WASM | `pyodide-backtest.worker.ts` | 单线程、无 SIMD 保证、无 GPU 访问。CPU 并行只能靠开多个 Worker |
| Tauri 侧无原生算力通道 | `src-tauri/Cargo.toml`、`tauri.conf.json` | 无 `shell` / `fs` 插件，无 `externalBin` sidecar。**不能**靠打包 Python+CUDA 实现 GPU |
| 内核已支持分代步进与断点续训 | `factor_lab/search.py:622-810` `search_stepwise(start_generation, seed_best)` | 本地长程任务的暂停/恢复**不需要新算法**，只需把生成器暴露到 JS |
| 但 `factor_local.py` 未暴露它 | `factor_local.py:32-38` 只有 `search` / `backtest_factor` 两个 mode | 需要新增入口 |
| IndexedDB 已有封装与既有库 | `src/lib/kline-cache.ts`：DB `qihuo-desktop` v1，store `kline-history` | 新增 store 必须**升 DB_VERSION 并在同一个 `openDb` 里建**，否则两处 `indexedDB.open` 版本冲突会互相阻塞 |

### 关键判断：GPU 不可能跑 Python

Pyodide 是 WASM，没有 GPU 访问能力；Tauri 也没有 sidecar 通道去调本机 Python/CuPy。
唯一现实可行的本地 GPU 路径是 **WebGPU 计算着色器（WGSL）**——Windows 上 Tauri 用 WebView2
（Chromium 内核），WebGPU 在较新 WebView2 上可用，需运行时探测。

这意味着 **GPU 路径必须用 TS + WGSL 重写因子求值热路径**，不能复用 Python 内核。
由此引出本方案最重要的一个设计决策：

> **GPU 只做搜索期的「粗排」，最终 champion 的指标一律回落到 CPU(Pyodide, float64) 重算。**

理由：GPU 是 f32、CPU 内核是 f64，且 WGSL 重写不可能与 Python 逐位一致。若把 GPU 算出的
指标直接落库/展示/挂实盘，就会出现「同一因子在本地 GPU、本地 CPU、服务端三个数字」的口径分裂，
而这套系统的既有设计（见 `search.py:87-92` 注释「两个平台仍逐位一致」）明确以口径一致为前提。
粗排+精算的方案既拿到 GPU 吞吐，又保证对外暴露的每一个数字都出自同一份 f64 内核。

---

## 2.2 目标架构

```
                    ┌─────────────────────────────────────────┐
   UI 层            │ 因子实验室页 / 超级因子挖掘页            │
                    │  执行位置: [服务器] [本地]               │
                    │  本地算力: [自动] [CPU] [GPU]            │
                    └───────────────┬─────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
   编排层           │ MiningRunner (统一接口)                  │
   src/lib/mining/  │  start / pause / resume / cancel / list  │
                    └───┬───────────────────────────┬─────────┘
                        │                           │
          ┌─────────────▼──────────┐   ┌────────────▼─────────────┐
          │ RemoteMiningRunner     │   │ LocalMiningRunner        │
          │ (现有 super-factor-api)│   │ + LocalTaskStore(IDB)    │
          └────────────────────────┘   └────────────┬─────────────┘
                                                    │
                                       ┌────────────▼─────────────┐
                                       │ ComputeBackend (可插拔)  │
                                       │  auto → gpu → cpu 降级   │
                                       └───┬──────────────────┬───┘
                                           │                  │
                        ┌──────────────────▼──────┐  ┌────────▼──────────────┐
                        │ CpuBackend              │  │ GpuBackend            │
                        │ N×Pyodide Worker (按岛) │  │ WebGPU 粗排 +         │
                        │ f64，权威口径            │  │ Pyodide 精算(f64)     │
                        └─────────────────────────┘  └───────────────────────┘
                                           │                  │
                        ┌──────────────────▼──────────────────▼──────────────┐
   数据层               │ MiningDataSource：服务器拉取 → 校验 → IDB 快照      │
   src/lib/mining/data  │ 本地/服务端两条路径共用同一份 bars 语义             │
                        └────────────────────────────────────────────────────┘
```

---

## 2.3 数据层：历史数据统一从服务器拉取

**新文件**：`src/lib/mining/data-source.ts`

### 职责
1. 走现有 `/api/market/kline` 分页回溯（复用并修好 `fetchBacktestBars`）；
2. **校验与清洗**：按 `time` 去重、升序排序、丢弃 `close<=0` 的坏 bar、检查时间单调；
3. **快照存 IndexedDB**：任务创建时把这批 bars 冻结成一份快照，续训只读快照；
4. 服务端挖掘不走本地拉取（服务端自己取数），但**校验规则要与服务端对齐**，
   否则同一品种同一区间在两端得到不同 bars，"本地/服务端结果可对比"就无从谈起。

### 为什么必须做快照（重要正确性点）
`search_stepwise` 的断点续训靠 `start_generation` 跳过已完成代数，并用 `seed_best` 注入历史最优。
它**隐含假设 bars 不变**——`rng = random.Random(cfg.seed)` 从头重放，若 bars 变了，
特征矩阵变、评估结果变，续训后的种群演化轨迹与中断前不再连续，`best_composite` 会莫名回退。
本地任务可能跨天恢复，期间 K 线一定有新增。因此**必须冻结快照**。

### 接口
```ts
export interface BarsSnapshot {
  id: string                 // `${symbol}:${timeframe}:${from}:${to}:${hash}`
  symbol: string
  timeframe: string
  from: string               // 实际首根 bar 时间
  to: string                 // 实际末根 bar 时间
  bars: KlineBar[]
  count: number
  fetchedAt: number
  sourceHash: string         // 见下
}

/** 从服务器拉取并冻结快照；已有同 id 快照直接复用 */
export async function acquireBarsSnapshot(req: {
  symbol: string
  timeframe: string
  startDate: string
  endDate: string
  maxPages?: number
}): Promise<BarsSnapshot>

export async function getBarsSnapshot(id: string): Promise<BarsSnapshot | null>
export async function releaseBarsSnapshot(id: string): Promise<void>   // 任务删除时回收
```

`sourceHash`：对 `bars.map(b => b.time + ":" + b.close).join()` 做 FNV-1a 32 位哈希。
用途有二：(a) 快照 id 去重；(b) **修掉 P2-14** —— 把它作为 Python 侧 `bars_signature` 的替代，
由 JS 显式传入内核，避免内核三点采样的碰撞风险。

### 存储
IndexedDB store `mining-bars`（keyPath `id`）。注意：
- 必须把 `DB_VERSION` 从 1 升到 2，并在 `kline-cache.ts` 的 `onupgradeneeded` 里
  一并创建新 store —— **不要另开一个 `indexedDB.open("qihuo-desktop", 2)`**，
  两个不同版本号的 open 会互相触发 `versionchange` 阻塞。
  建议把 `openDb` 抽到 `src/lib/idb.ts` 由两个模块共用。
- 快照体积：日线 5 年 ≈ 1200 根 ≈ 200KB；1m×30 天 ≈ 3.3 万根 ≈ 5MB。
  设总量上限 200MB，按 `fetchedAt` LRU 淘汰**且跳过被活跃任务引用的快照**。

### 拉取上限
沿用 `factor-range-limits.ts` 的既有约束（日线 5 年 / 60分 1 年 / 15分 180 天 / 1分 30 天）。
`fetchBacktestBars` 的 `maxPages` 默认 80（= 4 万根），够用；超限时向上层报明确错误，
不要静默截断。

---

## 2.4 编排层：统一 MiningRunner

**新目录**：`src/lib/mining/`

```
src/lib/mining/
  types.ts          # MiningTask / MiningConfig / DeviceKind / RunnerKind
  runner.ts         # MiningRunner 接口 + createRunner(origin) 工厂
  remote-runner.ts  # 包装现有 super-factor-api
  local-runner.ts   # 本地任务调度 + 状态机
  local-store.ts    # 本地任务持久化(IndexedDB store `mining-tasks`)
  data-source.ts    # 见 2.3
  device.ts         # 设备探测与降级
  backends/
    types.ts        # ComputeBackend 接口
    cpu-backend.ts  # N × Pyodide Worker
    gpu-backend.ts  # WebGPU 粗排 + CPU 精算
```

### 统一类型（`types.ts`）
```ts
export type RunnerKind = "local" | "remote"
export type DeviceKind = "auto" | "cpu" | "gpu"

export interface MiningConfig {
  symbol: string
  timeframe: string
  population: number
  generations: number
  max_depth: number
  train_ratio: number
  test_recent_bars: number
  walk_forward_folds: number
  islands: number              // 本地 CPU 多 worker 按岛分片，建议 = worker 数
  top_n: number
  seed: number
  cost: number | null
  seed_tokens?: number[][]
  start_date?: string
  end_date?: string
}

/** 与服务端 MiningTask 字段对齐，多加 origin/device/本地专属字段 */
export interface MiningTask {
  id: string
  origin: RunnerKind           // ← 新增，UI 据此打标签
  device: DeviceKind | "server"
  effectiveDevice?: "cpu" | "gpu"   // ← 本地任务实际落到的算力（auto 解析后）
  name: string
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled"
  current_generation: number
  generations: number
  progress_pct: number
  best_composite: number
  champions_count: number
  bars_count: number
  data_range_from: string | null
  data_range_to: string | null
  error_msg: string | null
  pause_reason: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string | null
  // 本地专属
  snapshotId?: string
  config?: MiningConfig
}
```

### 接口（`runner.ts`）
```ts
export interface MiningRunner {
  kind: RunnerKind
  create(config: MiningConfig, opts: { device: DeviceKind; name?: string }): Promise<MiningTask>
  list(): Promise<MiningTask[]>
  get(id: string): Promise<MiningTask | null>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  cancel(id: string): Promise<void>
  remove(id: string): Promise<void>
  champions(id: string): Promise<Champion[]>
  /** 本地实现推事件；远端实现内部轮询后转成同样的事件 */
  subscribe(cb: (t: MiningTask) => void): () => void
}
```

`super-factor-page.tsx` 与 `useMiningTasks` 改为面向 `MiningRunner` 编程，
列表把 local + remote 两个 runner 的结果**合并展示**（按 `updated_at` 倒序，
每行左侧打「本机 / 服务器」标签 + 算力标签）。

---

## 2.5 本地任务的状态机与生命周期

```
        create()                   start (自动)
 [无] ──────────► pending ──────────────────► running
                     │                          │
                     │                    pause()│  ▲resume()
                     │                          ▼  │
                     │                        paused
                     │                          │
                     └────── cancel() ──────────┼──────► cancelled
                                                │
                                    最后一代完成 ▼
                                            completed
                                     异常/数据不足 ▼
                                             failed
```

**并发上限**：本地同时 running 的任务数 = 1（Pyodide worker 池是全局资源，
多任务并行会互相饿死，也会让进度估计失真）。第二个任务排队为 `pending`，
UI 明示「排队中（本机同时只跑 1 个任务）」。

**持久化时机**：每完成一代（收到 worker 的 `step` 事件）就写一次 IndexedDB
（`current_generation` / `best_composite` / 当代 champions / `best_seen` 摘要）。
应用崩溃/关闭后重开，`pending`+`running` 状态的任务一律**恢复为 `paused`**，
并在 `pause_reason` 写「应用重启，已自动暂停，可手动恢复」——不要自动续跑，
避免用户一开应用就被占满 CPU。

**断点续训**：`resume` 时读快照 + 读 `current_generation` + 读持久化的 `best_seen`，
调 `search_stepwise(start_generation=current_generation, seed_best=...)`。

### 决策记录 D-1：续训语义保持现状，不做「精确续训」

**现象**：`search_stepwise` 的 `start_generation` 实现是 `if gen_idx < start_generation: continue`
（`search.py:733-735`）——它只跳过循环体，**不重放随机数、不恢复种群**，
而 `population` 在函数开头是新随机初始化的（L701-704）。
所以现有"续训"的真实语义是：**用历史最优因子作为种子，重新开始剩余代数的搜索**。

**决策：保持现状，本次不改。M3 的实现直接沿用它。**

理由：
1. **不是 bug**。`seed_best` 注入 `best_seen`（L708-709）保证了历史最优因子不会丢失，
   也会作为种子进入新种群参与繁殖（L710-719）。续训后结果不会倒退，只是演化路径与
   "从未中断过"的那条不同。
2. **改造代价与收益不匹配**。要做到精确续训，必须序列化并恢复：完整种群的树结构、
   `random.Random` 的内部状态（`rng.getstate()`）、各岛划分、以及 `best_seen` 全量
   （而非 top-N 摘要）。这是一次涉及内核持久化格式的改动，且服务端挖掘路径也得同步改，
   风险远大于它带来的收益——遗传搜索本身是随机算法，"精确复现某一条演化路径"对用户没有实际价值。
3. **它与 P0-1 之后的行为无冲突**，也不影响任何指标口径。

**代价：必须在 UI 上如实措辞。** 这是本决策的唯一强制要求：
- 恢复按钮的提示文案写「从第 N 代继续，历史最优因子作为种子进入新种群」；
- **不要**出现"精确断点续训""无损恢复""从中断处原样继续"这类表述；
- 任务详情面板如果展示过 `best_composite` 曲线，恢复点要打一个标记，
  说明该点之后是新一轮演化，不是同一条轨迹的延续。

**若将来要做精确续训**，请作为独立变更立项，不要混在 M3 里。届时需要：
`search_stepwise` 增加 `resume_state` 参数（含 `rng_state` / `populations` / `best_seen` 全量），
`StepwiseSnapshot` 增加对应的导出字段，并与服务端挖掘的持久化格式一并设计。

---

## 2.6 算力后端接口

**`src/lib/mining/backends/types.ts`**
```ts
export interface EvalRequest {
  snapshotId: string
  config: MiningConfig
  startGeneration: number
  seedBest?: SerializedBest[]      // 断点续训注入
}

export interface GenerationStep {
  generation: number               // 已完成代数(1-based)
  totalGenerations: number
  bestComposite: number
  champions: Champion[]            // 截至本代的去重 top-N
  elapsedMs: number
}

export interface ComputeBackend {
  readonly device: "cpu" | "gpu"
  /** 探测可用性；不可用返回不可用原因（用于 UI 置灰 tooltip） */
  probe(): Promise<{ available: boolean; reason?: string; detail?: string }>
  /** 分代步进执行；每代 yield 一次，调用方可在 yield 之间取消 */
  run(req: EvalRequest, signal: AbortSignal): AsyncGenerator<GenerationStep, Champion[]>
  dispose(): Promise<void>
}
```

用 `AsyncGenerator` 而不是回调，是为了让取消点天然落在每代边界上——
与 `search_stepwise` 的 yield 语义一一对应。

### 设备探测与降级（`device.ts`）
```ts
export async function resolveDevice(want: DeviceKind): Promise<{
  device: "cpu" | "gpu"
  degraded: boolean
  reason?: string
}> {
  if (want === "cpu") return { device: "cpu", degraded: false }
  const gpu = await probeGpu()
  if (gpu.available) return { device: "gpu", degraded: false }
  if (want === "gpu") return { device: "cpu", degraded: true, reason: gpu.reason }
  return { device: "cpu", degraded: false }          // auto 静默落 CPU
}
```

`probeGpu()` 检查项（缺一即不可用，`reason` 要具体，直接展示给用户）：
1. `typeof navigator !== "undefined" && "gpu" in navigator` → 否则「当前 WebView 不支持 WebGPU，请升级 Edge WebView2 运行时」
2. `await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })` 非 null
3. `adapter.limits.maxStorageBufferBindingSize >= 128 * 1024 * 1024`
4. `adapter.limits.maxComputeWorkgroupStorageSize >= 16384`
5. `await adapter.requestDevice()` 成功，且注册 `device.lost` 回调（GPU 掉设备时任务转 `paused` + `pause_reason` 说明，**不要**直接 failed）

**显式选了 GPU 但不可用时必须弹提示**（不能静默降级），因为用户是冲着速度选的。

---

## 2.7 CPU 后端：多 Worker 并行

**`backends/cpu-backend.ts`**

### 并行策略：按岛分片
内核的岛模型（`SearchConfig.islands`，`search.py:316-323`）天然可切：
N 个 worker 各跑 M/N 个岛，每 `MIGRATE_EVERY=5` 代在 JS 侧做一次环状迁移
（各岛 top-2 传给下一岛），与单进程的迁移语义等价。

**worker 数**：`Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1))`。
上限 4 的原因：每个 Pyodide 实例含 numpy 常驻内存约 100–150MB，再多会让 WebView 内存吃紧。
`islands` 自动设为 worker 数（用户不感知，UI 只展示"并行度 N"）。

> 若要保持与服务端**逐位一致**，必须让 `islands` 与服务端一致。因此：
> - 「本地 CPU」默认 `islands = worker 数`（快，但与服务端结果不同）；
> - 提供一个「与服务端口径一致」的高级开关，强制 `islands = 1` 且单 worker。
> 这一权衡要在 UI tooltip 里写清楚。

### Python 侧新增入口
`public/pykernel/factor_local.py` 增加 `mode == "mine_stepwise"`，并把生成器暴露给 JS：

```python
_SESSIONS: dict[str, dict] = {}

def mine_start(payload_json: str, bars_json: str) -> str:
    """创建一个分代步进会话，返回 session_id"""
    payload = json.loads(payload_json)
    bars = json.loads(bars_json)
    cfg_kwargs = {k: payload[k] for k in _CFG_FIELDS if k in payload}
    if cfg_kwargs.get("cost") is None:
        cfg_kwargs["cost"] = resolve_cost(str(payload.get("symbol") or ""), bars, None)
    cfg = SearchConfig(**cfg_kwargs)
    seed_best = _decode_seed_best(payload.get("seed_best"))
    gen = search_stepwise(
        bars, str(payload.get("timeframe") or "1d"), cfg,
        start_generation=int(payload.get("start_generation") or 0),
        seed_best=seed_best,
    )
    sid = str(payload.get("session_id") or "s1")
    _SESSIONS[sid] = {"gen": gen}
    return json.dumps({"session_id": sid}, ensure_ascii=False)

def mine_step(session_id: str) -> str:
    """推进一代；返回该代快照，或 {"done": true}"""
    s = _SESSIONS.get(session_id)
    if s is None:
        return json.dumps({"error": "会话不存在"}, ensure_ascii=False)
    try:
        snap = next(s["gen"])
    except StopIteration:
        _SESSIONS.pop(session_id, None)
        return json.dumps({"done": True}, ensure_ascii=False)
    return json.dumps({
        "done": False,
        "generation": snap.generation,
        "total_generations": snap.total_generations,
        "best_composite": snap.best_composite,
        "champions": [
            {"tokens": c.tokens, "text": c.text,
             "metrics": _round_metrics(c.metrics), "composite": c.composite}
            for c in snap.champions
        ],
    }, ensure_ascii=False, default=str)

def mine_dispose(session_id: str) -> str:
    _SESSIONS.pop(session_id, None)
    return "{}"
```

**关键点**：`mine_step` 每次只跑一代就返回，控制权交回 JS 事件循环 →
JS 才有机会 post 进度、检查取消、让 UI 呼吸。若沿用现有一次性 `run()`，
worker 会被阻塞几十分钟，暂停/取消都无从实现。

**性能提醒**：`search_stepwise` 每代都调用 `_dedup_top`（`search.py:754-767`），
而 `_dedup_top` 内含 walk-forward 与严格筛，是重计算。虽有 `_SEG_CACHE`
（`walk_forward.py:48`，上限 256 条）兜底，但 `population×generations` 大时仍可能
让"每代出快照"成为瓶颈。建议：**每代只算轻量快照（best_composite + top-N by composite），
每 5 代或最后一代才跑完整 `_dedup_top`**。这需要给 `search_stepwise` 加一个
`full_eval_every: int = 5` 参数。

### Worker 协议扩展
`pyodide-backtest.worker.ts` 新增消息：
```
入: { type: "mine_start",  reqId, sessionId, payload, bars }
入: { type: "mine_step",   reqId, sessionId }
入: { type: "mine_dispose",reqId, sessionId }
出: { type: "result", reqId, report }           // 复用现有
出: { type: "error",  reqId, message }          // 复用现有
```
取消 = 不再发 `mine_step` + 发 `mine_dispose`。因为每代之间控制权在 JS，
不需要在 Python 里埋取消标志。

**bars 传输**：`mine_start` 传一次 bars 即可（会话持有 bars 引用），
后续 `mine_step` 不再重传 —— 3.3 万根 bar 的 JSON 每代重传是不可接受的开销。

---

## 2.8 GPU 后端：WebGPU 粗排 + CPU 精算

**`backends/gpu-backend.ts`** + **`src/lib/mining/wgsl/*.wgsl`**

这是本方案工作量最大、风险最高的部分。**建议作为独立里程碑（M4），
在 CPU 双端（M1–M3）上线并稳定之后再启动。**

### 分工
| 阶段 | 执行位置 | 精度 | 说明 |
|---|---|---|---|
| 树的生成/交叉/变异/锦标赛 | JS (CPU) | — | 逻辑轻，无需 GPU |
| **因子求值（StackVM）+ 适应度粗排** | **GPU (WGSL)** | f32 | 热路径，占 95%+ 耗时 |
| 每代 top-K 候选的精确指标 | Pyodide (CPU) | f64 | K = top_n×3，权威口径 |
| `_dedup_top` / 严格筛 / walk-forward | Pyodide (CPU) | f64 | 全部走既有 Python 路径 |
| 最终 champion 的 metrics | Pyodide (CPU) | f64 | **对外暴露的数字全部出自这里** |

GPU 只影响"哪些候选被选进 top-K"，不影响任何被展示、落库、挂实盘的数字。

### GPU 侧数据布局
- **特征矩阵** `feat[F][T]`：f32 storage buffer，`F=35`，`T ≤ 40000` → 5.6MB。**每个任务上传一次**。
  由 JS 侧调 Pyodide 的 `feature_matrix` 算好后取回（`toJs()`），保证特征与 CPU 完全同源
  —— 不要在 WGSL 里重算特征，那会引入第二处口径分裂。
- **token 数组** `tokens[P][MAX_TOKENS]`：u32，`MAX_TOKENS = 32`（超长公式回落 CPU 求值）。每代上传。
- **收益/辅助列** `ret[T]`, `close[T]`, `open[T]`：f32，每任务一次。
- **栈暂存** `scratch[P][STACK_DEPTH][T]`：f32。`P=64, DEPTH=6, T=40000` → 61MB。
  超过预算时按 **候选分批（tile）**，每批 16~64 个候选。
- **输出** `metrics[P][8]`：ann/sortino/calmar/ic/sym/turnover_q/oos_sortino/consistency。

### 着色器结构
一个 workgroup 负责一个候选（`@workgroup_size(256)`，沿 T 维并行）：
1. **elementwise 算子**（ADD/SUB/MUL/DIV/ABS/NEG/SIGN/SQRT/SIGNED_LOG/SIGMOID/TANH/STEP/MIN/MAX/LAG_*/DELTA_*）
   → 直接按 `t` 索引并行，零难度。
2. **前缀和类**（TS_MA_*/TS_STD_*/TS_ZSCORE_*/TS_DEMEAN_20/EMA_*）
   → workgroup 级 scan（Hillis-Steele）算 cumsum 与 cumsum²，再按窗口取差。
   注意 **EMA 是串行递推**（`ops.py:145-163`），无法 scan；用 Blelloch 的
   "scan with affine operator" 或直接单线程串行扫（T 较大时是瓶颈，可先不支持 → 回落 CPU）。
3. **窗口规约类**（TS_MAX/TS_MIN/TS_RANK/CORR_20/BETA_20/RESID_20）
   → 朴素 O(T·w)，`w ≤ 60` 可接受。
4. **最后一步 `_normalize_output`** 必须与 CPU 完全一致（见 P0-2：若 P0-2 已改成因果滚动，
   GPU 也要改成同样的滚动版本）。
5. **指标计算**：pnl → workgroup 规约求 mean / 下行标准差 / 最大回撤 / IC。
   `_sortino` 的 clip 到 ±20、`_calmar` 的 clip 到 ±10 等边界必须逐条照搬。

### 算子支持分级（务必实现"未支持即回落"）
```ts
const GPU_SUPPORTED_OPS = new Set([...])   // 第一批：elementwise + 前缀和类
// 候选公式含未支持算子 → 该候选走 CPU 求值，不阻塞其他候选
```
不要为了"全支持"而卡住上线；先覆盖高频算子（实测 GP 生成的公式里 elementwise + TS_MA/TS_STD
占比很高），剩余回落 CPU 即可拿到大部分加速。

### 数值一致性验收（硬性要求）
必须有一个 parity 测试：
- 随机生成 500 个合法 token 序列，同一份 bars；
- GPU f32 与 CPU f64 各算一遍 `composite`；
- 断言 **Spearman 秩相关 ≥ 0.98**（粗排只需保序，不需数值相等）；
- 断言 **CPU 口径下的真实 top-10 有 ≥ 8 个落在 GPU 粗排的 top-30 内**（召回率）。

若达不到，说明 WGSL 实现有偏差，**不允许上线**——粗排选错了候选，
后面 f64 精算再准也救不回来。

### 风险登记
| 风险 | 缓解 |
|---|---|
| WebView2 版本过旧无 WebGPU | `probeGpu` 明确提示升级；GPU 选项置灰 |
| 集显/老显卡性能反而不如多核 CPU | 首次运行跑一次 20 候选的 micro-benchmark，若 GPU 慢于 CPU 则提示用户 |
| `device.lost`（驱动重置/休眠唤醒） | 监听后转 `paused`，恢复时重建 device 并从上一代继续 |
| f32 精度在 1m 长序列上累积误差 | 前缀和用 Kahan 补偿；或对 cumsum 分块（每 4096 个元素重置基准） |
| 工作量失控 | 严格限定在 M4，且以「算子分级 + 回落」保证任何时候都能停在可用状态 |

---

## 2.9 UI 改动

### 超级因子挖掘页（`super-factor-page.tsx`）
在 `MiningConfigForm` 的品种/周期之下、参数之上，插入一组新控件：

```
执行位置    ○ 服务器计算机     ● 本地计算机
            └ 服务器长程运行，关闭软件也继续；受配额限制
              本地免配额，占用本机 CPU/GPU，关闭软件会暂停

本地算力    ○ 自动   ● CPU (并行度 3)   ○ GPU  ⓘ当前 WebView 不支持 WebGPU
```

- 「执行位置」选服务器时，「本地算力」整组**不渲染**（不是置灰，是不存在），
  `device` 恒发 `"cpu"`。服务端没有 GPU 挖掘，见「范围约束」。
- 「本地算力」三个 radio，GPU 不可用时置灰并把 `probeGpu().reason` 放进 tooltip。
- 任务列表每行加两个标签：`本机`/`服务器` + `CPU`/`GPU`（服务器行恒为 `CPU`）。
- 本地任务的详情面板增加「用时 / 每代平均耗时 / 预计剩余」——本地跑几小时，
  没有 ETA 体验很差（服务端任务同样可显示）。
- 本地 `running` 任务在关闭窗口前拦截：`onbeforeunload` 提示「有本机挖掘任务在运行，
  关闭后将暂停」。

### 因子实验室（`factor-lab-page.tsx` / `use-factor-lab-page.ts`）
现有的二态按钮（L75-84）改为三态下拉：`服务端 / 本地 CPU / 本地 GPU`。
- `localStorage` 键从 `qh_factor_local`（"0"/"1"）迁移到 `qh_factor_engine`
  （`"server" | "cpu" | "gpu"`），**保留一次性迁移逻辑**读旧键：
  `"0" → "server"`，其他 → `"cpu"`。
- 因子实验室是"快速搜索"（默认 pop30×gen15），仍走一次性调用即可，
  不需要接长程任务状态机；但 GPU 后端可以复用。
- 现有 `onProgress` 只有两条静态文案（`local-factor.ts:35,45`），
  接入 `mine_step` 后改成真实进度：`第 7/15 代 · 当前最优 0.83`。

---

## 2.10 分阶段里程碑与验收

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0** | 修 P0-1 / P2-17 / P1-9 | 见第一部分各条的验收 |
| **M1** | 数据层：`data-source.ts` + IDB 快照 + `idb.ts` 抽公共 openDb | 同一 `(symbol,tf,区间)` 两次 `acquireBarsSnapshot` 返回同一 `id`；bars 严格升序无重复；DB 升到 v2 后旧 K 线缓存仍可读 |
| **M2** | 编排层：`MiningRunner` 抽象 + `remote-runner` 包装 + UI 改造为面向接口 | 行为与改造前**完全一致**（纯重构，无功能变化）；超级因子页仍能创建/暂停/恢复/取消服务端任务 |
| **M3** | 本地 CPU 挖掘：`mine_start/step/dispose` + `cpu-backend` + `local-runner` + `local-store` | ①能创建本地任务并逐代出进度；②暂停/恢复/取消可用；③关掉应用重开，任务为 `paused` 且能恢复；④`islands=1` + 单 worker + 同 seed 时，本地结果与服务端**逐位一致** |
| **M3.5** | 多 worker 按岛并行 + `full_eval_every` 优化 | 4 worker 相对单 worker 加速 ≥ 2.5×；`islands` 相同时结果与单 worker 版一致 |
| **M4** | 本地 GPU：`probeGpu` + WGSL VM + 粗排/精算分工 + parity 测试 | ①Spearman ≥ 0.98、top-10 召回 ≥ 8/30；②不支持的算子正确回落；③`device.lost` 后能恢复；④最终 champion 的所有 metrics 与 CPU 版逐位一致 |
| **M5** | UI 打磨：ETA、标签、关闭拦截、文案、GPU 不可用提示 | 走查清单通过 |

**M1–M3 是必做**；M3.5 是性能优化；M4 独立、可延后、可随时中止在"回落 CPU"的安全态。

---

## 2.11 给执行方的注意事项

1. **不要在 WGSL 里重算特征**。特征一律由 Pyodide 的 `feature_matrix` 产出后上传 GPU，
   否则会出现第三套口径。
2. **不要让 GPU 的数字出现在 UI/DB/实盘挂载路径上**。GPU 只排序，f64 精算才出数。
3. **不要为本地挖掘另写一套评估逻辑**。所有指标、严格筛、walk-forward 一律复用
   `factor_lab` 的既有 Python 实现——这套系统的价值前提就是"本地/服务端同源"。
4. **快照必须冻结**，理由见 2.3。
5. **续训语义保持现状且如实描述**。不要顺手去"修"`start_generation`，
   也不要在 UI 上宣称"精确断点续训"。理由与强制文案要求见 **2.5 决策记录 D-1**。
6. **DB 版本升级只能有一个入口**，理由见 2.3。
7. 本地挖掘同样受第一部分所有内核 bug 影响。**M3 完成后请重跑第一部分的测试清单**，
   确认本地路径与服务端路径在同一批 bug 上表现一致（一致才说明同源没被破坏）。
8. **不要给服务端提 GPU 需求**。服务端挖掘只有 CPU，这是产品范围约束，不是待办事项。
   `device` 字段维持 `"cpu"` 单值透传；`device_options` 若含 `gpu` 项一律过滤。
   本文档不产生任何后端改动需求。
