# crypto-local-v2 实施进度

方案: docs/plans/2026-09-25-crypto-local-factor-optimization-v2.md
基线审查: 2026-09-25, HEAD = ed9e71c (v0.2.21), 内核版本 pykernel-factor-2026-09-25.3
Python: 3.10.9 (CPython 本地跑回归;Pyodide 路径由 vitest + verify-gpu-session 覆盖)

## 基线状态(实施前)

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 通过 |
| `npx vitest run` | ✅ 151 passed / 1 skipped (20 files) |
| `verify-kernel-tests.py` | ✅ 5/5 |
| `verify-crypto-profile.py` | ✅ 10 tests |
| `verify-selection-v2.py` | ✅ |
| `verify-mine-stepwise.py` | ✅ |
| `verify-crypto-mining-cost.py` | ✅ |
| `verify-local-features.py` | ❌ → ✅(修复陈旧断言:并行工作 v0.2.16 追加特征 52-58 后计数未从 52 更新到 59,属测试错误非代码缺陷) |
| `verify-kernel-text.py` | ✅ 44 算子/59 特征文案全覆盖 |
| `verify-gpu-session.py` | ✅ 3 tests(内核侧会话逻辑;真实 WGSL 对拍另行标注) |
| `verify-crypto-gpu.cjs` | 未运行(需真实 GPU 环境,见"受限事项") |

方案 2.1 节 A–H 问题全部在 ed9e71c 代码中确认存在(A: walk_forward.py:281 边界折整折计 OOS;B: split_bars 静默退化全量训练;C: vm.execute 归一化分支按 token 新旧;D: _direct_data_features 填 0 归一化 + active_feature_ids 整行有限;E: run_mine_precise best_seen 截前 60;F: run_llm_vocab 硬排除 52-58;G: 无 funding 现金流;H: 搜索/回测各自取数)。

## 执行清单(按依赖排序)

- [x] B0 基线运行 + 记录
- [x] B1 任务2(P0): split_plan.py + research_context.py;修 WF 边界(A)、短样本静默退化(B)、归一化因果统一(C)、缺失/有效掩码(D)
- [x] B1 回归: scripts/verify-crypto-splits.py(9), scripts/verify-crypto-causal-v2.py(9)
- [x] B2 任务4(P0): scoring/execution.py + scoring/funding.py;次根开盘执行 + funding 事件现金流
- [x] B2 回归: scripts/verify-crypto-execution.py(12) 手算案例
- [x] B3 任务5(P1): archive.py 有界多样性档案;GPU 精算漏斗配额(selectPreciseIndicesQuota 60/25/15);任务6 seed_templates.py 因子族模板(28 条)
- [x] B3 回归: verify-crypto-archive.py(13) + src/lib/mining/gpu/archive.test.ts(5)
- [x] B4 任务8: robust_zscore/rolling_winsor 算子(append-only id 44/45);LLM 词表修复(F,双侧)
- [x] B5 任务3: 两入口配置贯通(TS research_profile/execution_model/label_span 全路径穿透;backtest 复测同口径)
- [x] B6 任务10: scoring/research_report.py SearchStats 账本接入 stepwise 快照;champion 状态徽标 UI
- [x] B7 基准实验: scripts/benchmark-crypto-mining.py(真实 Binance Vision BTCUSDT)基线+消融,见 docs/experiments/crypto-local-v2/RESULTS.md
- [x] B8 全量回归 + 构建 + 提交推送

## 基准实验结论(2026-09-26,详见 docs/experiments/crypto-local-v2/RESULTS.md)

真实 BTCUSDT 1h × 3600 根(hash 30bb3f0c)、5 种子、240 试验/种子:
- v2: 8 个验证通过冠军,legacy 0(口径可信度差异,非收益改善);
- v2_exec(执行成本+funding): 0/8 全拦截——诚实负结果,小预算下无因子扛真实成本;
- holdout: 0 通过;确定性 ✓;v2 效率 ≈3.4×(同预算)。

### B9 验证缺口补齐批次 2026-09-26

针对完成度审查提出的 6 项缺口逐一补齐:

1. **两入口一致性显式测试** `scripts/verify-crypto-entries.py`(5 tests):
   实验室入口(run_search)与超级因子入口(mine_start/mine_step 会话)对相同
   bars+配置(含 v2 与 legacy)冠军序列/综合分逐位一致(会话路径指标按
   _round_metrics 4 位圆整精度比对——序列化差异,决策字段精确相等)。
   **测试暴露并修复 2 个真实缺陷**:
   (a) `_reveal_v2_holdout` 把未过封存的候选从 validation_passed 覆盖成
   rejected(验证裁定不得被封存覆盖;通过才升级 holdout_passed);
   (b) CPU 会话路径(超级因子 CPU 任务)从不做 v2 封存揭示,与实验室入口
   不一致——mine_step 末代快照后现在与 run_search 同口径一次性揭示。
2. **任务 3 快照复用(问题 H)落地**: local-factor.ts 新增 SearchBarsSnapshot
   (搜索冻结 bars+取数区间+成本+v2 profile),backtestFactorLocal 默认复用
   (symbol/timeframe/channel+区间匹配才复用;用户改区间/品种回退重新取数;
   复测未显式给 cost 时注入冻结值)。TS 测试
   `src/lib/local-factor-snapshot.test.ts`(4 tests):复用不重新取数、
   网络修订隔离(fetch 层返回篡改数据后复测仍收冻结引用)、冻结成本注入、
   不匹配回退。内核侧 verify-crypto-entries 快照复现测试同步覆盖。
3. **benchmark --mode time + 峰值内存**: time 模式(固定时间内反复搜索,
   不同子种子,unique 跨重复累计)与 peak_rss(Windows psapi
   PeakWorkingSetSize,显式 argtypes 修复返回 0 的问题)落地并实测:
   60s×3 种子:legacy 724 unique/91.6MB,v2 1078/98.9MB,v2_exec 951/98.9MB
   (详见 RESULTS.md)。
4. **浏览器两页面实际操作联调**(vite dev + in-app 浏览器):
   因子实验室——BTCUSDT 60m 搜索(74849 根,Pyodide 冷加载约 6 分钟)、
   冠军表渲染、单因子复测(资金曲线/实盘口径/状态分解)、无控制台错误;
   超级因子——本地任务创建运行完成(3 冠军+组合评估:等权 Sortino 2.06 vs
   最优单因子 1.51)、暂停(代 4/30 边界生效)→恢复(代 6 继续)验证通过。
   "刷新"语义由 local-runner 单测的"重启恢复:持久化 running→paused"覆盖
   (刷新即重建 runner,同一代码路径);版本不兼容由内核未知 profile 拒绝
   + verify-crypto-entries 未知会话用例覆盖。
5. 进度文档与 RESULTS.md 同步更新;基准 JSON 归档。

## 关键决策记录

- 旧 profile(crypto_ohlcv_v1)行为保持逐位不变;新能力挂 crypto_local_v2 显式版本,未知版本拒绝执行。
- v2 token 空间(特征 0-63、算子 offset=64)冻结不动;新算子 ROBUST_ZSCORE_20/WINSOR_20 append-only(id 44/45),GPU 不支持→CPU 回落;参数化走 v3 表达式(未在本批实施,见受限事项)。
- funding 特征(52-58)与 funding 结算现金流分开:特征层 known-at 语义,现金流层按 funding_time 去重的事件原值结算;标记价缺失用结算前收盘估算并标注 estimated。
- 验证折计分只在验证区内(v2),上下文允许延伸进训练区;跨训练边界折按区间交集判 in_train(fix A 对旧路径同样生效)。
- 档案指纹仅近似索引不用于丢弃(方案 §8.1);容量 256、配额 50/30/20。
- 内核版本 2026-09-25.3 → .4 三处同步(factor_local/kernel-version.ts/crypto-profile.ts)。

## 测试与结果日志(汇总)

### B1 任务2(P0)完成 2026-09-25

新增: `factor_lab/scoring/split_plan.py`(SplitPlan/60-20-20/验证折/区间交集)、`factor_lab/research_context.py`(ResearchContext/前缀不变窗口推导/候选状态映射)、`scripts/verify-crypto-splits.py`(9 tests)、`scripts/verify-crypto-causal-v2.py`(9 tests)。

修改: walk_forward.py(fix A:in_train 改区间交集+overlap_train_bars 诊断;新增 walk_forward_eval_v2 验证区内折)、vm.py(normalization 显式策略 NORM_CAUSAL_V2;execute_for_bars 统一分发;直连特征 v2 容忍头部未采样前缀)、features.py(zscore_window v2 前缀不变分支;_masked_zscore_causal 缺失不参与统计/全缺失 NaN;active_feature_ids v2 头部容忍+有效分数)、market.py(V2_PROFILE 标记/prepare_bars 升级)、search.py(SearchConfig.research_profile/execution_model/label_span;search 与 search_stepwise v2 切分+封存不可见+head_trim 共享计分日历;_dedup_top plan 参数;v2 样本不足跳过严格筛防空转通过;fallback 状态标 exploratory/rejected;validation_passed/candidate_status 标记)、factor_local.py(未知 profile 拒绝;research_context 预检入口;_reveal_v2_holdout 封存一次性揭示;shard/precise/features/backtest v2 路径)。

发现的内核 BUG 并修复: (1) v2 样本不足时严格筛空转通过(use_test=False 门全开仍发 validation_passed)→ 跳过严格轮;(2) _search_space 重写引入语法错误;(3) 跨度计算未含末根 bar 区间;(4) 测试拦截点从 wf.execute 迁移到 wf.execute_for_bars(语义不变)。

测试: verify-crypto-splits 9/9 ✓;verify-crypto-causal-v2 9/9 ✓;既有 8 个 verify 脚本全绿。legacy 兼容: 所有 v2 行为挂在 research_profile="crypto_local_v2";默认空 profile 逐位不变(黄金测试 + 既有全部回归验证)。

### B2 任务4(P0)完成 2026-09-25

新增: `scoring/funding.py`(FundingEvent/funding_time 去重/现金流/保守排序/估算标注)、`scoring/execution.py`(ExecutionConfig/perp_next_open 次根开盘现金流/spot_long_flat 截断/全段连续推进切片一致)、`scripts/verify-crypto-execution.py`(12 tests,含多头付费/空头收款/零持仓/同戳换仓/一日多结算/前填不重复扣款/缺失事件/fee+滑点数学/2×压力不动 funding/次根开盘归属/全段=分段/现货不空头手算案例)。

修改: search.py(v2 严格筛接入 execution_model 门:1×/2× 压力净 sortino>0;perp 无 funding 事件=关键成本未知不得通过;_enrich 附 execution_metrics);factor_local(上下文截断 BUG 修复:_executable_metrics_for 原把上下文截到训练段导致 lo==hi 恒 None)。

端到端冒烟: v2+perp_next_open 合成 3600 根 → holdout_passed 候选带 execution_metrics(funding 359 事件计入)。

### B3 任务5/6/8 + GPU 漏斗完成 2026-09-25~26

新增: `factor_lab/archive.py`(BoundedArchive:容量 256、配额 50%稳健/30%多样(族×复杂度×换手轮转)/20%探索(稳定哈希序)、指纹仅近似索引不丢弃、ValidationBudget 60 上限)、`factor_lab/seed_templates.py`(28 条现有能力模板:动量/流量/funding/OI/尾部/规模/拥挤/清算/区间,按数据可用性过滤+每族≤2、注入 20-30%)、`scripts/verify-crypto-archive.py`(13 tests,含 80 变体挤占+低分互补保留的旧缺陷锚)。

算子(append-only id 44/45): ROBUST_ZSCORE_20(中位数/MAD 有界、MAD=0 饱和)、WINSOR_20(阈值截至 t−1)。vm 感染分类/文案/TS 镜像(gpu/tokens.ts,标 GPU 不支持→CPU 回落)同步。

GPU 漏斗(TS): rank.ts 新增 selectPreciseIndicesQuota(60/25/15,evolve_v2 时启用)+ familyOfTokens/complexityBand;`src/lib/mining/gpu/archive.test.ts`(5 tests:拥挤互补保留/无效分不占名额/确定性/三族都出现)。

LLM 词表修复(fix F): run_llm_vocab 按训练段特征矩阵可用性生成(bars 传入时),excluded_features 带原因;llm-factor-seed.ts 取数预检后才请求词表(probeBars 按周期选窗口)、系统提示按词表真实内容声明数据能力。

### B4 任务3(TS 贯通)+ 任务10(账本)完成 2026-09-26

MiningConfig/LocalFactorPayload 增 research_profile/execution_model/label_span;cpu-backend buildPayload、gpu-backend mine_features/mine_precise、local-factor GPU 配置/mine_portfolio/backtest 全部穿透。内核版本三处(factor_local/kernel-version.ts/crypto-profile.ts)升至 2026-09-25.4。

`scoring/research_report.py`(SearchStats 漏斗计数+淘汰原因直方图+champion 状态汇总)接入 search_stepwise 快照与 mine_step 输出。

修复: 模板注入块在 search_stepwise 引用未定义 seeds → cfg.seed_tokens(基准首跑暴露)。

测试: 12 个 verify 脚本全绿;vitest 156 passed/1 skipped;typecheck ✓。

## 受限事项

- verify-crypto-gpu.cjs 真实 WGSL 对拍未在本机运行(无浏览器 GPU 会话),以内核侧 + TS 参考实现对拍替代并明确标注;GPU 漏斗召回(§16.3)同样未测。
- v3 表达式(任务 6 §9.2 参数化特征/算子)、组合贡献(任务 9 pool_selection)、跨币面板(任务 11)、盘口采集(任务 12)未在本批实施——本批按方案"第一批"范围完成任务 1-5/8/10 的基础部分;档案/模板/算子已为其预留接口。
- Gate 永续 175 天限制:接口侧能力边界(enrichGateBars 已显式报错),未虚构更早历史。
- 封存段"最终评估区间"未在本批正式揭示(开发迭代用完即止);方案冻结后按预注册流程另行揭示。
- 实验结论受限于 240 试验/种子的小预算与单币种(BTCUSDT 1h);v2_exec 0 通过为诚实负结果,不以放宽门槛制造达标。

## 完成状态核对(2026-09-26)

- [x] 所有当前可实施任务完成(本批范围:任务 1/2/3/4/5/8/10 + 任务 6 §9.1 种子模板)
- [x] 关键路径联调:两入口 payload 贯通、research_context 预检、封存揭示、执行口径门(内核端到端冒烟)
- [x] 相关测试与构建通过:12 个 verify 脚本 + vitest 156 passed + typecheck + vite build
- [x] 发现的可修复 BUG 已处理(6 处,见各批日志)
- [x] 实验与兼容结果有可复现记录(RESULTS.md + benchmark JSON + 进度文档)
- [x] GitHub 提交与构建: feat f9de5c2 + release a64f0cf(tag v0.2.22)已推送;
      Actions run 36162897934 **success**(15m43s),Release v0.2.22 已发布
      (setup.exe + .sig + latest.json):
      https://github.com/roberts9012062/ai-trading-desktop/actions/runs/36162897934
      https://github.com/roberts9012062/ai-trading-desktop/releases/tag/v0.2.22
- [x] 受外部条件限制的事项已明确列出
