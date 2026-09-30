# 短线因子实验室 —— 实现级冻结决策（桌面端）

> 2026-09-30，feat/shortline-lab。本文档记录方案 B（`2026-09-30-shortline-lab-desktop.md`）
> 落地时做出的实现级决策。与方案冲突处以"修正"标注并给理由。数值口径一经本文冻结，
> 修改需升 profile 版本号。

## 1. token 区间修正（方案说 ≥104 → 实际 ≥115）

方案原文"v4 特征只进 ≥104 本地专属 token 区间"。盘点事实：桌面 v2 编码中
特征占 [0,64)、算子占 [64,64+51=115)，token 104-114 已被算子 40-50 占用
（TS_CRANK_20=104 … DELTA_24=114）。方案意图是"现有分配之上的本地专属区间"，
故 **短线 v4 特征 token = 115-122**（8 个，append-only）：

| token | 名称 | 定义（冻结） |
|---|---|---|
| 115 | SL_OF_IMB | 主动买占比 takerBuyVol/vol ∈[0,1]（bar 无量→0） |
| 116 | SL_BIG_SHARE | 大额秒占比：vol≥5×bar 内秒均 vol 的秒的 vol 之和 / bar vol |
| 117 | SL_TRD_INT | ln(1+tradeCount)（tradeCount 为量时间归一后值） |
| 118 | SL_PV_DIV | 量价分歧：秒内 close-open 方向翻转频率 ∈[0,1] |
| 119 | SL_VWAP_DEV | close/(Σquote/Σvol) − 1 |
| 120 | SL_BURST | 爆发比 max 秒 vol / 均秒 vol（cap 1000） |
| 121 | SL_STREAK_SIG | 强单连击：最长同主导方向秒连击长/秒数×方向 ∈[−1,1] |
| 122 | SL_RHYTHM_ENT | 节奏熵：秒 vol 分布的 Shannon 熵 / ln(秒数) ∈[0,1] |

全部从 1 秒 tick 桶计算（见 §3），bar 级（挖掘列）与形成中 bar（流式/重放）
同一实现（`src/lib/shortline/orderflow.ts`）。zscore 归一化：`_masked_zscore_causal`
口径（与直连特征 52-61 同族，缺失=NaN 不冒充 0），固定窗口 **300**。
VM 准入按 52-61 族语义（头部缺失容忍、中段缺口拒绝）。

引擎内 v4 特征行 = 特征矩阵第 62-69 行（`FEAT_COUNT=62` 不变，矩阵按需扩到 70 行）。

## 2. shortline_v1 profile 语义（复用 v2，最小新增面）

- **特征计算完全复用 crypto_local_v2 语义**（zscore_window=norm_window_for_bars、
  masked 归一化、VM causal_v2 输出归一化）。base 特征数值面 = v2 逐位同源。
- 新增仅三类：①v4 特征行（§1）；②fitness 短线惩罚（§4）；③TS 侧重放合格门（§5）。
- `research_profile = "shortline_v1"` 进 KNOWN_PROFILES；resolve_context 按 v2
  分支解析（split/execution/norm 全同 v2），附加 shortline 元数据键。
- 挖掘仍在收盘 K 线训练（引擎权威）；v4 列由桌面回填管道按 bar 注入
  （bar dict 键 `sl_of0..sl_of7`，经 packNativeBars 动态数值列自动过协议，
  native/pykernel 免协议改动）。

## 3. tick 桶（digest）与形成中 bar（冻结规格 forming-bar-spec/1）

- **digest/1**：1 秒桶 `{ts(秒,u32), open,high,low(close 同 OHLC), vol, quote, takerBuyVol,
  takerBuyQuote, count(u32)}`，空秒不存（稀疏）。二进制定长记录 60B/条，
  SHA256 清单。来源：Binance Vision UM daily aggTrades zip（回填）或 WS aggTrade（实时）。
- **形成中 bar**（与服务器契约逐字段一致；量时间归一）：
  - 周期 [barStart, barStart+span)；t 时刻 cut：
    open=首笔价（无交易→前收盘），high/low=截至 t 极值，close=最后价（无→前收盘）；
    vol/quote/takerBuyVol/takerBuyQuote/count=截至 t 累计。
  - **量时间归一**：elapsed = min(t−barStart, span)，下限 1 秒；scale = span/elapsed；
    归一量字段 = 原始累计 × scale。归一只用于"绝对量类"语义（SL_TRD_INT 的 count、
    VOL_* 特征输入）；比例类（SL_OF_IMB 等）天然不变。
  - cadence 网格：`t % cadence_seconds == 0`（UTC 对齐）；每步以 [closed bars…, forming bar(t)]
    为求值窗口。
- **打分**：score = tanh(z)，z = VM causal_v2 输出（滚动 zscore clip ±3，窗 =
  norm_window_for_bars，同 v2）。组合分 = Σ wᵢ·scoreᵢ（w 冻结 IC 权重，Σw=1）。
- 求值窗口：requiredHistory = zscoreWin + maxOpWin + vmNormWin + 60 + 10；
  每步全量重算末值（不做增量态，消除重放/流式漂移；服务器可自行 O(1) 增量，
  黄金夹具锁值）。
- 求值器 = `src/lib/shortline/`（TS）：重放器与流式预览共用同一实现
  （forming-bar.ts / orderflow.ts / evaluator.ts），禁止第二套。

## 4. fitness 短线惩罚（引擎内，仅 shortline_v1 生效，冻结）

composite_shortline = composite_v2 × max(0, 1 − 0.5·min(avg_turnover/0.35,1)
                                           − 0.3·min(flip_rate/0.08,1)
                                           − 0.2·max(0, 1 − hl/48))
- avg_turnover：现有指标；flip_rate = mean(pos_t·pos_{t−1}<0)；hl = 仓位序列
  lag-1 自相关半衰期（bars，ln2/max(−ln|ρ1|,ln2/500)，|ρ1|≤0 → 0.5）。
- 系数/上限为 shortline_v1 v1 冻结值；不调参迁就产出（0 合法）。
- 默认（非 shortline profile）不进该乘子 → 现有口径逐位不变。

## 5. shortline_v1 合格门（TS 侧，与现有门并列）

引擎侧资格仍走 v2 严格门（WF/封存/OOS——qualify_candidates 不改）。
TS 侧附加门 `src/lib/shortline/gate.ts`（拒绝原因逐条记录，0 合法）：
- live 可用性：公式仅含 live 特征集（§6）与 v4；含非 live 特征 → 拒。
- 翻转率：冠军分 cadence 序列符号变化率 ≤ 0.15/bar。
- 打分稳定性：bar 内 cadence 步分数标准差 ≤ 0.20。
- 采样点 IC：OOS 段 score_t vs 下一 bar 收益 Spearman IC ≥ 0.015。
- 延迟鲁棒：10s 延迟 IC ≥ 0.5 × 3s IC。
- 封存段揭示：沿用引擎 holdout 机制（不在 TS 门重复）。

## 6. live 特征白名单（初始值，待服务器同步）

live = kline+aggTrade 可流式计算：**0-13, 17-26, 31-34, 36-51, 54, 55, 58, 61 + v4(115-122)**。
非 live（挖掘可出现但短线门拒）：14-16, 27-30（OI 族）, 35（STRENGTH，镜像成本高暂缓）,
52-53, 56-57, 59-60（funding/LS/强平族）。
挂载白名单（契约 champions.tokens）初始：除 SERVER_MISSING_FEATS={55,57,58} 外的
base 特征 + 全部算子标记"服务器白名单内"；**v4=115-122 标记"仅本地"**（服务器
FormulaEvaluator 未实现 v4 前，含 v4 的公式禁止挂载，UI 明示）。
→ 待服务器 AI 对齐后更新（开放决策项，见验收报告）。

## 7. 重冻结纪律

改动 native-engine/engine/* 或 public/pykernel 数值面 → VERSION bump
（`native-gpu-v1-m3.3` → `native-gpu-v1-m3.4-shortline`）→ G1（20 token 双跑）
→ G2 全量 56/56（fetch suite → export reference → parity，CPU 参考哈希随源码
更新重导）。所有改动为**加法分支**：现有 profile 路径逐位不变，G2 对新参考必须
仍 56/56 通过。

## 8. 磁盘预算与回填

- 默认仅 ETHUSDT；digest 存储 IDB v6 新 store `shortline-digest`
  （key=`symbol:date`，值=60B 定长记录 ArrayBuffer+SHA）。2 年 ≈ 2-3GB，
  UI 展示占用 + 清理入口；逐日断点续传（per-day 状态记录）。
- raw aggTrades zip 下载后即时聚合为 digest 即弃（不存 zip）。
