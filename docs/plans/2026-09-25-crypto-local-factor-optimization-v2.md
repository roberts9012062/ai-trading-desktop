# 虚拟货币本地因子与算子优化实现方案

> 交付对象：负责实现的 AI。本文仅制定方案，未修改业务代码、运行收益实验或触发发布。实施时按任务顺序推进，先建立可复现基线，再逐项验证；不要把所有实验同时合入默认配置。

**Goal：** 在相同本地计算预算下，发现更多通过独立验证、扣除合理成本、彼此具有不同信息或组合贡献的加密货币因子。

**Architecture：** 超级因子挖掘和因子实验室继续共用 Python 因子内核与 CPU/WebGPU 后端。增加统一研究配置、数据能力清单、分层候选档案和评估契约；先改进现有搜索，再通过独立的 v3 表达式格式承载参数化特征与算子。

**Tech Stack：** React / TypeScript、Tauri、IndexedDB、Pyodide / NumPy、Python、WebGPU / WGSL、Vitest。

**审查基线：** 2026-09-25。最初读取为 0491372（v0.2.20）；编写时工作区已更新为 ed9e71c（v0.2.21），中间提交未修改本文审查的因子内核。执行前重新核对 HEAD 与相关文件，避免覆盖其他 AI 的并行改动。下文路径均相对仓库根目录 D:\pyobj\AI Trading Desktop。

路径简写：factor_lab/ 指 public/pykernel/factor_lab/，其中 features.py、ops.py、vm.py、search.py、express.py、token_encoding.py 位于该目录；evaluate.py、walk_forward.py、portfolio.py、deflated.py 位于其 scoring/ 子目录；factor_local.py 指 public/pykernel/factor_local.py。TS 文件以 src/ 下的完整路径或同段已列目录为准。

---

## 1. 结论与实施优先级

当前的主要瓶颈是：有限搜索预算大量投入相似公式；部分可用衍生品信息尚未进入种子生成；评估边界与样本充分性仍有问题；特征和算子缺少可参数化、可描述数据依赖的统一格式。

推荐按以下顺序实施：

1. **P0：建立可信评估。** 修正滚动验证边界、短样本静默降级、归一化因果性、搜索与回测数据不一致；区分信号研究与可执行收益。
2. **P1：提高现有搜索产出。** 扩大有界且多样的候选档案，改善 GPU 精算候选选择；按因子族生成模板与种子，按真实数据能力提供 LLM 词表。
3. **P1：扩展表达能力。** 新增 v3 表达式与参数窗口，在保留旧公式的同时补充资金费率、订单流、量价状态、跨币残差等方向。
4. **P2：组合贡献与性能。** 用冻结的组合评估检验候选增量价值，再优化真正占时的算子。
5. **P2：积累盘口历史。** 先建立持续采集与质量记录，有足够历史后再开盘口因子搜索。

“更多优质因子”不能用增加 top_n、放宽验证门槛或显示更多兜底结果来实现。允许一次搜索得到 0 个合格因子；仍可保留有研究价值的失败候选及失败原因。

第一批可以只完成任务 1～5、8 的基础部分与任务 10，不必等 v3、盘口和跨币扩展全部完成。

## 2. 当前已有能力与真实缺口

旧研究文档 docs/crypto-local-factor-research-2026-09-25.md 描述的是较早状态，其中多项问题已修复。本方案以当前代码为准。

| 项目 | 当前已有 | 本次需要补齐 |
|---|---|---|
| 共同内核 | 两入口共享 Python CPU 和同一 GpuBackend | 两入口共用完整研究上下文、快照和参数校验 |
| 加密市场口径 | 365 天年化、UTC 日历、crypto_ohlcv_v1 | 新配置显式区分现货研究、现货多头、永续交易 |
| 特征 | 共 59 个，ID 0～58；40～51 为加密扩展，52～58 为直连数据 | 不能继续按窗口大量追加 ID；新格式支持参数化 |
| 算子 | 44 个；已有中心化秩、线性衰减、相关、回归残差、EMA | 稳健变换、参数窗口、类型约束、能力注册 |
| 数据 | Binance 现货成交额/主动买量/笔数；Gate 永续 funding/OI/统计 | funding 事件成本、缺失掩码、额外原始字段、跨币面板 |
| 防过拟合 | selection_v2、行为去重、验证/封存分离，最后一代揭示封存结果 | 修正 WF 边界；跨任务记录封存揭示与研究试验次数 |
| 进化 | 点变异、收缩变异、克隆降权、停滞重启、岛模型 | 按因子族/周期分配预算，保留互补候选 |
| 缓存 | 特征矩阵、训练评估、因子序列、分段指标、GPU 粗排缓存 | 统一配置哈希；按实际瓶颈决定是否增加子表达式缓存 |
| 盘口 | 页面每 10 秒采集前 20 档摘要，最多 2000 条，离开停止 | 持续历史采集、分市场存储、断档与时间质量管理 |
| 权限 | 本地公式/研究公式与服务端挂载已有门禁 | 新格式沿用本地研究权限，不因优化自动放开实盘 |

### 2.1 已确认、应优先修复的具体问题

**A. 滚动验证可能把部分训练样本计为样本外。**

public/pykernel/factor_lab/scoring/walk_forward.py 的 walk_forward_eval 以 test_end <= train_len 判断整折是否在训练区。跨越训练边界的折被整体计入 OOS。例如可见数据 850 根、原训练 700 根、3 折，最后一折约为 [636,850)，其中 64 根仍属于训练区。应使用明确区间交集与标签时间边界，不再用一个布尔值代替实际切片。

**B. 短样本可能失去验证，却继续显示搜索结果。**

同文件 MIN_TEST_BARS=120，split_bars 在任一段不足时退化成全量训练；search.py 的 holdout_len 在测试不足 240 根时不封存。Gate 默认 120 根左右日线不具备当前完整训练/验证/封存条件。不能通过降低到几十根或把 WF=None 视为通过来“改善产出”。

**C. 新加密任务里使用旧 token，仍可能继承旧归一化问题。**

features.py 的旧特征使用由整段数据推导的 zscore_window；vm.py 的输出归一化分支还按公式是否包含新 token 判断是否采用严格因果路径。仅用旧特征/旧算子的加密公式不能因此自动获得一致的因果契约。

**D. 缺失处理既损失信息，也可能污染统计。**

features.py 的 _direct_data_features.normalize 先把缺失填 0 参与滚动归一化，再恢复 NaN；active_feature_ids 要求整行全部有限，一个缺口即可排除整项特征。全缺失序列返回 0，而追加未来有效数据后同一历史前缀会变成 NaN。新配置应显式区分“值、有效性、数据年龄”。

**E. GPU 候选档案过窄。**

factor_local.py 的 run_mine_precise 将 best_seen 按训练分截为前 60；但 search.py 的增强去重需要扫描至多约 300 个候选才能凑到 30 个不同想法。头部被同质变体占满时，下一代会丢失有差异性的历史候选。只把 60 改成更大数字还不够，应做有界多样性保留。

**F. LLM 看不到已经接入的数据。**

src/lib/llm-factor-seed.ts 拉取词表时传空 bars；factor_local.py 的 run_llm_vocab 对加密固定排除 OI 和 52～58，提示词还固定声明没有 funding/OI。需按本次冻结数据能力生成词表，不能一律开放所有特征，也不能继续一律禁止。

**G. 资金费率是输入，尚不是收益现金流。**

evaluate.py、walk_forward.py、portfolio.py 仍使用收益减换手静态成本；Gate 加入的 funding_rate 只作特征。必须保留原始结算事件列表，不能用每根 bar 前填的费率反复扣款，也不能用日线前填值重建当天所有结算。

**H. 搜索后复测口径未完全冻结。**

超级因子有 IndexedDB 快照；local-factor.ts 的 searchFactorsLocal 与 backtestFactorLocal 分别重新取数。单因子回测自动成本也不必然等于搜索时冻结的训练段成本。实验室应复用同一快照和已解析配置。

## 3. 统一研究与结果契约

新增一份两入口通用、运行前解析后不可变的 ResearchContext。避免页面、CPU、GPU 各自维护不同默认值。

    ResearchContext {
      schemaVersion, profileId, kernelVersion,
      expressionVersion, registryHash,
      venue, instrumentId, marketType, timeframeSeconds,
      snapshotId, snapshotHash, capabilities,
      featurePolicy, operatorPolicy, normalizationPolicy,
      splitPlan, executionModel, costModel,
      searchBudget, seed, campaignId
    }

关键规定：

- profileId 新增 crypto_local_v2；旧 crypto_ohlcv_v1 与旧公式继续按旧版本解释。不要覆盖旧 ID 的含义。
- marketType 由渠道和合约元数据确定；不能仅凭 USDT 后缀决定现货或永续。
- executionModel 至少区分 signal_research、spot_long_flat、perp_next_open。无借币数据的现货不输出可执行做空收益。
- splitPlan 存真实 UTC 时间边界、索引、标签跨度、预热、可评估条数；所有入口和报告直接消费同一对象。
- capabilities 记录字段单位、覆盖区间、可用时点、发布延迟假设、最大过期时间、缺失率、数据源。
- 固定 source、原始事件、合约元数据、配置的内容哈希；新快照使用稳定序列化 + SHA-256。旧快照仍可读取，不能原地改 ID。
- checkpoint 包括档案、RNG 状态、种群、预算计数、已揭示状态和全部版本；不能把“用旧冠军作种子重跑”宣称为精确续跑。

候选状态独立于本地/服务端执行权限：

    exploratory            探索结果或统计样本不足
    validation_passed      通过预先规定的验证，封存尚未揭示
    holdout_passed          冻结候选通过最终封存评估
    rejected               未通过，记录明确原因
    portfolio_component    仅作为已验证组合的组成部分

现有 fallback + overfit_warning 映射成 exploratory/rejected；不计入合格因子数。holdout_passed 仍是研究证据，不自动取得实盘权限。未知字段/版本不允许静默走旧执行器。

首版“通用单因子”的默认判定应固定为：数据与因果检查通过、样本充分、验证段在 1 倍和 2 倍交易成本下净收益及 Sortino 均 >0、声明的验证折均有充分样本且净表现为正、未超过任务开始前设定的风险上限。全部候选冻结后，封存按相同预注册标准评估，不根据封存指标重新排序或补选候选。没有可评估折、零波动、未完成收益标签或关键成本未知，均不能默认通过。状态型和组合型使用任务 9 的独立标准与标签，不混入此口径。

## 4. 任务 1（P0）：固定基线和评估诊断

**文件：** 新建 scripts/benchmark-crypto-mining.py、scripts/benchmark-crypto-mining.mjs、docs/experiments/crypto-local-v2/；修改 search.py、factor_local.py、src/lib/mining/backends/{cpu-backend,gpu-backend}.ts 的统计输出。

实施步骤：

1. 保存当前版本、硬件、配置、数据哈希与真实行情快照清单；行情文件放本地数据目录，不把大型数据或密钥提交仓库。
2. 区分 generated、syntax_valid、unique_expression、train_valid、precise_evaluated、distinct_behavior、validation_passed、holdout_passed 等计数。
3. 每项淘汰记录一个主原因及可选次原因：非法式、常数、缺失、预热不足、同质、成本失败、WF 失败、封存失败等。
4. 基准支持固定表达式批次、固定唯一候选预算、固定时间预算三种模式；明确 Pyodide 冷启动是否计时。
5. 基线、每个增量模块均输出相同 JSON/CSV 字段。不要只有最后一个冠军的收益截图。

**验收：** 同版本同快照同 seed 的 CPU 结果可重复；CPU/GPU 的固定表达式精算结果可比较；每个计数可追溯。此阶段只测量，不改变现有评分。

## 5. 任务 2（P0）：修复数据切分、归一化与样本充分性

**文件：** 新建 factor_lab/research_context.py、factor_lab/scoring/split_plan.py；修改 features.py、vm.py、search.py、scoring/{walk_forward,portfolio,regime}.py、factor_local.py。对应 TS 配置新增 src/lib/mining/research-context.ts 与测试。

### 5.1 切分与标签边界

1. 新配置默认 60% 训练、20% 验证、20% 封存；仅在样本条件满足时启用。旧配置保持原行为并标识版本。
2. 原训练区内的多段评估叫“训练内部稳定性”，不得标成独立 OOS。候选是看过整个训练区后找到的，不能因把训练区再切片而获得新样本外证据。
3. 对固定候选的验证折，仅在 [train_end, validation_end) 内切分。每折记录 score_start/score_end/context_start；历史上下文可以在训练区，计分样本不可以。
4. 如果实现真正滚动重训，每折必须在其 train_end 前重新搜索/拟合，不能复用看过后续训练数据的最终冠军。
5. 按标签区间清除跨边界训练样本。h 根预测、次根开盘成交等都用实际 label_start/label_end 判断；末尾没有完整收益标签的 bar 不补 0 参加统计。
6. 对纯前向切分，先实现标签重叠清除即可；不要机械丢掉整个 lookback。以后如增加双向组合切分，再明确 embargo 的用途和长度。
7. splitPlan 被所有单因子、组合、跨币、成本压力路径复用；不得各自重新 round 比例。

### 5.2 因果归一化与缺失

1. 新 profile 显式传递归一化策略，与 token 是否“新”无关。固定窗口/参数随公式保存，不依赖传入完整段长。
2. 先用共同全历史前缀计算，再按 splitPlan 计分。定义每个节点 lookback，串联时累加、并联时取最大；含输出变换及特征自身预热。
3. EMA 使用连续状态或显式 burn-in 容差。首版保留 CPU 能力，不用一个假定有限窗口替代递推语义。
4. 使用 values + valid_mask。NaN 不参加均值、方差和分位数；全缺失始终无效。可选 masked rolling 要声明 min_periods，首版默认完整窗口有效。
5. 对 OI、已结算 funding 等状态值只允许有 TTL 的前填；成交量、成交笔数、统计流量不能跨缺口前填。缺口后按节点规则重新预热。
6. 首版优先使用连续有效区间，避免每条公式自行挑选有利的有效日期。含不同数据依赖的候选在同一数据能力子组内比较，并共享评分日历与掩码政策。
7. “有值但为 0”与“没有观测”明确分开。funding=0、零成交、平盘口都是合法观测；除零或未知值不得冒充中性信号。
8. 输出变换也显式注册，例如 preserve_signed_bounded 或 rolling_zscore；绝对 funding 符号等经济含义不能在 VM 最后一层再次被强制去均值抹掉。输出映射在训练前固定，所有路径使用同一仓位转换规则；不同映射计为不同实验。

### 5.3 样本充分性

运行前显示：原始 bars、有效 bars、预热消耗、训练/验证/封存长度、验证折数、独立结算事件数。

- 首版每个验证折/封存段保留当前至少 120 个有效收益样本的底线；同时要求有足够日历跨度与交易事件，120 根 1m 不等于充分证据。
- 建议初始研究门槛：训练有效样本至少 500；验证/封存各至少 max(120, 20×预测跨度)；用于正式验证的验证、封存各至少 30 个自然日。作为预注册默认值，不根据结果临时降低。
- 离散执行评估增加完成交易次数与持仓周期分布；例如不足 30 个完成交易只作探索。连续持仓模型应另报告有效收益样本，不以每根持仓 bar 冒充一次交易。
- 以上是工程门槛，不是统计显著性的保证；长周期低频因子还需更长历史。
- 不足时返回 insufficient_samples 和具体缺口；允许明确选择“探索”，但不输出通过样本外验证的标记。
- Gate 当前应用限制最近 175 天，默认日线 120 天通常只能探索。优先研究同一市场 15m/1h 的充分样本，不为了更多 bars 把不同市场拼接成连续历史。

**必须新增的回归：** 700/850 边界案例；120 根日线不得静默得到 OOS 通过；追加极端未来数据不改变已有有效输出；修改封存不改变训练候选/验证名单；只含旧 token 的新 profile 也通过前缀不变性；中间缺失和全缺失前缀测试。

## 6. 任务 3（P0）：两入口冻结相同数据与配置

**文件：** src/lib/mining/{data-source,types,local-runner,crypto-profile}.ts、src/lib/local-factor.ts、src/lib/py-worker.ts、src/workers/pyodide-backtest.worker.ts、src/components/factor-lab/hooks/use-factor-lab-page.ts、src/components/super-factor/super-factor-page.ts、src/lib/idb.ts、src/lib/local-backtest.ts、src/lib/binance-kline.ts。

实施步骤：

1. 实验室搜索也调用快照层，SearchResult 附 researchContextId/snapshotId；单因子复测、组合评估、LLM 种子和继续进化均复用。
2. 把表单输入解析为同一 ResearchContext，再分别交给 CPU/GPU。新增字段必须穿过 LocalFactorPayload、MiningConfig、CPU buildPayload、GPU RPC、Python _CFG_FIELDS；不靠页面 spread 推断已传到所有路径。
3. 快照包含原始 bars、funding_events、合约单位与来源元数据；只冻结搜索需要的数据，不冻结当前盘口当历史数据。
4. 全渠道统一只接受已闭合 K 线；以 UTC 数字时间戳排序/去重。核验日线的 UTC 起点，避免 Binance 的日期字符串被当北京时间转换。
5. 搜索时解析好的 costModel、归一化和时间边界写入结果；复测不根据新拉行情或末端价格重算默认成本。
6. 增加版本不兼容诊断；旧任务可查看，无法复现的旧版本不能标成当前结果。明确“原样恢复”和“以旧结果重新开始”两种操作。
7. 快照仍需有引用计数和容量限制；估算完整新结构大小，不能继续用仅 OHLCV 的固定每 bar 大小低估新增字段。

**验收：** 两入口对相同快照和配置的固定公式，特征、分段、成本、精算指标一致；搜索后网络原始数据被修订，复测仍复现原结果；刷新/暂停不丢配置与版本。

## 7. 任务 4（P0）：统一执行收益和资金费用

**文件：** 新建 public/pykernel/factor_lab/scoring/execution.py、public/pykernel/factor_lab/scoring/funding.py；修改 evaluate.py、walk_forward.py、portfolio.py、factor_local.py、src/lib/gate-futures.ts、src/types/index.ts、research-context.ts。

先保留旧 signal_research 的连续 tanh 仓位与收盘收益作为对照；新合格状态统一以所选 executionModel 的净收益验证。

### 7.1 时间和成本约定

- 默认可执行路径：bar t 闭合后产生信号，最早于 t+1 开盘执行；持有至后续规定执行时点。同一索引必须同时定义特征可用时间、信号时间、订单时间、收益归属。
- 手续费、滑点分别配置。首版用明确单边费率与固定 bps，2 倍压力仅放大交易费用/滑点；资金费率按历史事件原值计算。
- 有历史价差/成交容量后再引入流动性冲击模型，禁止用今天的盘口估计过去整个区间的成交成本。
- 波动目标、进出场阈值、最短持有、迟滞可作为少量固定策略参数；选择它们也计为研究试验，不能在最终封存上调参。
- 切片首仓状态、首笔成本与尾部平仓规则统一。当前 evaluate_on_slice 从切片首部重新计入开仓成本，而离散切片延续预热状态；新执行器要以连续现金流切片验证一致性。

### 7.2 Funding 事件

保留每次结算的 (venue, contract, settled_at, rate, available_at, source)。把“用于预测的已公布历史值”与“当期真实扣费事件”分开。

    cashflow_at_settlement = - signed_position_before_settlement
                            × contract_multiplier
                            × settlement_mark_price
                            × funding_rate

上式适用于本阶段支持的线性合约；必须匹配交易所持仓单位与结算规则。反向合约先明确不支持，不套用线性公式。

- 正费率时多头付费、空头收款；零持仓为零。每个事件只记一次，多个事件落在一根日线内仍分别累计。
- 同时间戳开仓与结算使用明确的保守排序：先对结算前已持仓计费，再处理该时间点新执行订单；用边界用例验证。
- 历史结算标记价缺失时，只能输出明确标注的估算成本/敏感性区间。不得以成交收盘价替代后宣称精确计费。
- 特征沿用 known-at 的保守时延，不因为事件已用于事后结算而允许信号提前获知该费率。
- 现货 long_flat、永续多空、信号研究分别计数、分别基准比较。

**验收：** 固定多仓、空仓、空头、结算瞬间换仓、一日多次结算、缺失事件、单边/双边成本的手算案例；全段与分段现金流一致；搜索/复测/组合使用同一实现。

## 8. 任务 5（P1）：候选档案与 GPU 精算漏斗

**文件：** 新建 factor_lab/archive.py、src/lib/mining/gpu/archive.ts（仅编排/元数据，精算权威仍在 Python）；修改 search.py、factor_local.py、gpu/{rank,evolve,gp}.ts、backends/gpu-backend.ts、checkpoint 保存路径。

### 8.1 有界档案

把“展示 top_n”“进化精英”“待验证档案”分离：

- top_n：最终展示数量，建议默认 10。
- archive_capacity：首版默认 256，可选 128/256/512，受内存预算控制。
- validation_budget：整个运行累计的唯一验证候选上限，首版默认 60；不是每代额外 60。
- 默认档案保留配额：50% 训练稳健性较好、30% 不同行为/因子族、20% 探索。各区重叠去重，空位按确定性规则回填。
- 按公式复杂度、主要因子族、持有周期、换手区间等分组保留；不要只按训练综合分一次截断。
- 已有指标指纹仅作近似索引，不能证明两条时序等价。指纹碰撞后用共同训练区的序列/仓位比较确认。
- 对最终档案保存指标与表达式；只为热候选缓存有界长度的时序或完整向量，避免 512×多币长历史无界占用内存。

### 8.2 GPU 漏斗

GPU 仍负责粗排、Python float64 负责权威精算，但精算预算不只给全局最高分：

- 60% 给粗排前列的不同候选。
- 25% 给不同族/持有周期/换手的分组前列。
- 15% 给未精算候选的确定性随机探索。

比例是待消融的默认提议，不能宣称已最优。EMA 等 GPU 不支持的合法种子进入单独 CPU 额度，不以 -999 永久淘汰。GPU 支持列表/栈深/长度上限以能力清单报告。

只允许训练指标影响进化、档案和探索预算。重复读取验证结果会形成选择压力，应固定验证预算并记录暴露次数；最终候选及组合冻结后才揭示封存。继续调参使用新封存区间/后续时间数据。

**验收：** 构造前 60 个都是同类变体、后部有互补候选的案例，后者应能在档案和精算中保留；档案/种群/RNG 恢复与连续运行一致；仅更改封存数据不改变档案及验证名单。

## 9. 任务 6（P1）：先补种子模板，再引入 v3 表达式

**文件：** 新建 factor_lab/seed_templates.py、factor_lab/registry.py、factor_lab/expression_v3.py、src/lib/mining/expression-v3.ts、src/lib/mining/registry.ts；修改 token_encoding.py、express.py、vm.py、features.py、ops.py、gpu/tokens.ts、gpu/gp.ts、gpu/wgsl/eval-vm.wgsl.ts。

### 9.1 先用现有能力获得收益

第一批不改 v2 编码，用现有特征和算子生成短模板、不同符号方向、不同经济解释的种子。种子占初始种群约 20%～30%，其余保持随机探索；同族/同结构去重，不让人工模板占满种群。

保留现有 selection_v2/evolve_v2/岛模型。CPU/GPU 都按同一“因子族配额”采样，替代简单把所有 ID>=45 的特征重复一次。可用族等概率起步，再在训练预算内调整，不由封存收益调整权重。

### 9.2 新格式解决容量限制

v2 的特征 0～63、算子 offset=64 **永久冻结**。现在仅剩 59～63 五个特征位，不用它们登记同一特征的十几个窗口，也不把 offset 直接改成 128。

新增显式 v3 AST/IR，示意：

    {
      "version": 3,
      "profile": "crypto_local_v2",
      "registryVersion": "...",
      "root": {
        "op": "ts_corr", "windowBars": 24,
        "args": [
          {"feature": "return", "params": {"lagBars": 1}},
          {"feature": "taker_imbalance_raw"}
        ]
      }
    }

约定：

1. 旧 number[] 继续由旧解码器处理；新式必须携带显式版本和 AST。不猜测整数范围，也不向旧服务端发送伪造的 v2 tokens。
2. 注册表定义名称、版本、参数枚举、输入/输出类型、量纲、范围、缺失规则、lookback、复杂度、CPU/GPU 支持、required_fields。
   以新增 schemas/factor-registry-v3.json 为静态元数据唯一来源，scripts/gen-factor-registry.mjs 生成 Python registry_data.py 与 TS registry-data.ts；registry.py/registry.ts 仅提供访问及校验。计算函数仍分别实现，用自动对拍保证一致。生成文件包含相同 registryHash，CI 检查重新生成无差异。
3. AST 只允许白名单节点和有界参数；禁止 eval/任意 Python。固定最大深度、节点数和累计历史需求，非法式在进入热循环前被拒绝。
4. 首版 CPU 执行 v3；GPU 编译成独立的 instruction buffer（opcode、operand index、parameter index），不侵占旧 feature offset。用能力协商选择 GPU 子集或 CPU 路径。
5. 公式正文、展示文本、哈希、收藏/导出、结果 API 和历史恢复一起支持版本；新 v3 默认 local_only/research_only，服务端不能执行时明确阻断。
6. 规范化只做经语义证明安全的变换；缺失、保护除法、截断与浮点下不能盲目把 x/x 化成 1、0*x 化成 0 或重新结合加法。
7. 参数的物理时长在创建公式时编译为明确整数 bars 并保存；同一公式不能随当前页面周期静默变义。跨周期迁移生成新实验 ID。

**验收：** v2 历史黄金公式结果不变；v3 序列化往返一致；两个相同文本不同窗口公式哈希不同；字段缺失和超出 GPU 能力会清晰报错/明确回退；未知版本不得执行。

## 10. 任务 7（P1）：因子族与新增信息设计

下表均为待验证研究假设，不是已证实的盈利规律。优先保留原始、有经济意义的量，再由算子决定是否归一化；不要把 funding 正负、多空比中点等信息在底层一律 z-score 掉。

记 r 为闭合 bar 的收益，Q 为真实成交额，I 为主动买卖不平衡，OI 为统一单位持仓，z/mean/std/rank 均为因果滚动算子。

| 优先 | 因子族与候选表达 | 数据与约束 | 改进点 |
|---|---|---|---|
| A | 波动调整动量：ret(k)/(std(r,w)×sqrt(k))；短长动量差 | OHLCV；已有 MOM6/24，先作为模板 | 搜索物理持有周期和状态交互，避免只复制新 ID |
| A | 流量压力：sum(buy−sell,w)/sum(buy+sell,w) | Binance 实际主动量；Gate 保存统计原始买卖量 | 比“各 bar 比值简单平均”更准确地保留量权 |
| A | 流量/价格背离：resid(ret(k), aggregate_flow,w) | 同市场同时间；回归参数只能由过去估计 | 捕捉成交推动弱、价格反应强等不同状态 |
| A | 冲击后反转/延续：ret(short) × volume_surprise × liquidity_state | Q 优先；close×volume 只能标成代理 | 通过有界状态模板产生两种方向，不预设必反转 |
| A | funding 拥挤：最近已公布费率、结算间差分、历史分位数、OI 变化交互 | 保留 funding 事件、单位和已知发布时间 | 事件粒度 delta，避免大量前填 bar 的 0 差分主导 |
| A | OI/价格四象限：sign(ret(k))×delta(log(OI),k)，配合量能门 | OI 单位不变且未过期；必要时按 USD 口径另命名 | 描述增仓上涨/增仓下跌/减仓状态 |
| B | 清算强度：liq_quote/Q 与 long-short 清算差 | 当前只保存不平衡；需保留历史真实清算额 | 同样的比值可对应完全不同冲击规模，补上“强度” |
| B | 账户拥挤：log(long_short_ratio)，稳健偏离 × funding/动量 | 比率应 >0，基准 1；已知发布时延 | 区分绝对偏多与相对近期更偏多 |
| B | 成交规模：log(Q/trade_count) 与成交强度的偏离 | 当前 Binance 已有 Q/笔数；0笔无成交不硬除 | 捕捉活动结构，不能把平均单笔解释成大户身份 |
| B | 尾部/跳跃代理：负收益平方占比、历史阈值超越次数、极端回撤后恢复 | 仅已发生价格；阈值不能用未来整段分位数 | 保留有符号、状态相关的风险结构 |
| B | BTC/ETH 残差动量：asset_ret−beta_past×benchmark_ret | 同所同类型行情面板，先做时序对齐 | 区分整体市场上涨与币种特有强弱 |
| C | 基差/标记偏离：(mark−index)/index，变化与 funding 交互 | 要真实历史 mark/index；当前快照不够 | 提供新的价格关系信息，缺历史则禁用 |
| C | 盘口价差、档位不平衡、微价格偏离、流动性恢复 | 任务 12 完成后，从真实积累区间启用 | 不从 OHLCV 或当前盘口回填历史 |

窗口首版建议：1h、4h、12h、1d、3d、7d 的有限枚举；转换后至少 2 bars，且不超过任务历史预算。收益 lag 另允许 1 bar。日线可用 2/5/10/20/60 bars 的独立预设，避免把 1h 取整成 1d。每个族最多启用 3～4 个适合该周期的窗口，避免组合爆炸。

Funding 年化/结算间隔：不能固定假设永远 8 小时；当前合约元数据也不能证明历史每个时期的间隔。首版保留原始结算费率与事件间隔；有可靠历史间隔后才提供单位时间费率或周期编码。

新增数据字段优先复用已经调用的接口：保留 Gate 统计返回的原始主动量、清算量/额和 OI 计价信息，比先引入更多交易所更易形成一致样本。Gate 文档列出了这些字段及合约单位，实际覆盖仍需逐合约检查。[Gate 官方期货 API](https://www.gate.com/docs/developers/apiv4/en/futures/)

Binance 现货 K 线官方格式包含成交额、成交笔数和主动买入量；当前适配器已保留其中部分，本阶段重点是让模板和数据能力清单正确消费。[Binance 官方 K 线格式](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#klinecandlestick-data)

**文件：** features.py、seed_templates.py、registry.py、src/lib/gate-futures.ts、src/lib/binance-kline.ts、src/lib/llm-factor-seed.ts、factor_local.py 的 run_llm_vocab。

**LLM 约定：** 取数/预检后才请求词表；仅提供当前可用字段/算子/窗口，要求每条候选给出假设、数据依赖、预期周期。模型返回必须通过 schema、类型、lookback、可用性校验。LLM 不接收封存结果，不宣称所有候选天然无未来信息。

## 11. 任务 8（P1）：算子语义、约束搜索与效率

### 11.1 算子优先级

| 顺序 | 算子/机制 | 明确语义 | 说明 |
|---|---|---|---|
| 1 | 已有 lag/delta/mean/std/corr/beta/resid/decay 参数化 | 有限窗口枚举；窗口与有效样本规定持久化 | 先复用已有数学实现 |
| 1 | 复用已有 SIGNED_LOG | sign(x)×log(1+abs(x)) | 已有相同实现，只接入新注册表/模板，不新增重复算子 |
| 1 | robust_zscore | (x−rolling_median)/(1.4826×MAD) 后有界截断 | MAD≈0 且 x≈median 为 0；否则按约定饱和，不能除出无穷 |
| 1 | rolling_winsor | 按过去窗口分位数裁剪，固定插值规则 | 明确当前值是否参与阈值；首版阈值用 t−1 为止 |
| 2 | ts_quantile/centered_rank 参数化 | 中秩、并列容差、缺失与预热统一 | 已有 TS_CRANK20/60，不重复登记 |
| 2 | bounded_gate / soft_threshold | 用有界权重调节一个信号 | 先模板化，不增加任意三元 IF 的搜索爆炸 |
| 2 | event_delta / event_age | 按已知事件序列计算，区别于 bar delta | funding 等稀疏事件专用 |
| 3 | rolling_residual 多输入/市场中性 | 回归只用过去窗口拟合 | 面板准备后再做，不把当前全段回归当因果算子 |

robust_zscore/分位数的计算代价较高，可先 CPU 精算/小规模搜索；未测性能前不要在大 GPU 种群中默认高权重启用。

### 11.2 约束搜索

1. 类型至少包括 signed_signal、positive_scale、bounded_weight、event_state、raw_price、raw_volume。加减要求同量纲；归一化后成为无量纲信号。
2. 对重复 sign、相同节点自减、零方差相关等先做类型与有效性分析，再裁剪可证明冗余/退化的结构。滚动 rank(rank(x)) 一般不等于 rank(x)，不能凭外观重复就禁止嵌套；滚动 z-score、EMA 也不能随意套用幂等规则。
3. 窗口变异仅走邻近枚举，另保留小比例跨尺度跳跃；结构变异与参数变异分开计数。
4. 经济方向可以成对探索，但 f 与 −f 不应重复占据“独立因子”名额；现货多头等非对称执行模式下，两方向收益仍需分别评估。
5. 复杂度预算包括节点数、累计 lookback 和算子成本。CPU/GPU 分别报告可支持公式集合，不能以不同集合比较数值等价。

### 11.3 性能顺序

先测耗时，再依次评估：安全结构去重 → 常用特征预计算 → 小范围子表达式缓存 → 滚动统计 O(T) 实现 → GPU 批处理改造。

- 已有训练/矩阵/分段缓存保留，不重复建立无界缓存。
- 所有缓存键包括 snapshotHash、registryHash、profile、splitPlan、成本/执行版本和表达式哈希。
- CORR/BETA/RESID 的大数相减问题已做过稳定化修复；新的滚动矩实现必须在小波动大基数、funding 平台和极端值上对拍，不能为速度退回不稳定公式。
- GPU 新算子逐个上线；只在 CPU float64、TS 参考、真实 WGSL 三方验证后进入默认 GPU 搜索空间。

**验收：** 每个算子有常数/缺失/极值/短窗/重复值/前缀测试；参数改变只改变声明的语义；GP 产生非法或必然常数式的比例可测且下降；端到端耗时按实际硬件报告。

## 12. 任务 9（P2）：从低相关候选走向有增量贡献的因子池

**文件：** 新建 factor_lab/scoring/pool_selection.py；修改 archive.py、search.py、scoring/portfolio.py、结果类型与组合展示。

当前相关性去重与等权/IC 加权组合可以保留为基线，但低相关并不自动等于有价值，高相关也不必然没有增量。AlphaGen 的研究强调新增因子对既有组合的贡献；其主要证据来自股票数据，这里只借鉴目标设计，不直接推断币圈收益。[AlphaGen 原论文](https://arxiv.org/abs/2306.12964)

实施：

1. 保留“单独合格因子”和“仅对组合有效的候选”两个池。后者不能混入单因子合格数。
2. 固定一个小规模基准组合（例如最多 8 个成分）；首版采用等风险/等权及有界非负权重，避免高度抵消的巨额多空权重。
3. 在训练内部的前向折上估计方向、标准化、权重和新增候选的增量。外层验证仅检验有限个已冻结组合，最终封存只报告冻结后的最终组合。
4. 记录新增候选后的净收益/风险改善、换手增加、回撤变化，以及 remove-one 消融；风险尺度及执行成本保持一致。
5. 相关性既看因子值，也看实际仓位/净收益；不把高相关原始信号的微小数值差自动认作稳定残差收益。
6. 不要求所有因子同时在所有行情为正。可以预注册“通用型”和“状态条件型”不同假设；条件状态必须可事前计算，并把不触发时期、成本和完整组合收益都计入。
7. 原有严筛不直接放宽；新状态型/组合型模式独立标识，经过自己的预注册验证后才可通过。

不要直接把 IC_5、IC_20 加进现有 composite。代码注释记录过相关实验退化。多持有周期应分别建立带对应成本、标签清除和试验预算的独立实验，再做消融。

## 13. 任务 10（P1）：统计报告、试验账本与两处界面

**文件：** 新建 src/lib/mining/research-ledger.ts、factor_lab/scoring/research_report.py；修改 deflated.py、search.py、src/lib/factor-lab-api.ts、src/components/factor-lab/panels/selected-factor-panel.tsx、超级因子结果组件、两处表单与 factor-access.ts。

### 13.1 试验账本

- campaignId 绑定数据区间和研究问题；记录每次 seed、参数、提示词模板版本、候选数、方向/阈值实验、验证暴露、封存揭示。
- 区分总尝试、唯一公式、可执行公式、行为簇数。当前 population×generations 是预算近似值，不能伪装成精确独立试验数；也不能以行为簇数直接替代独立试验数。
- DSR 当前实现用零假设近似标准误，没有完整试验 Sharpe 分布。先保留并标为近似诊断；补齐试验统计后再按论文约定改进，并披露序列相关假设。
- 对分钟级、自相关收益，补充时间块 bootstrap 的不确定性报告，块长在训练阶段设定/检验敏感性。不要把原始 bar 数都当独立样本。
- 不把 DSR 写成“盈利概率”。它用于研究选择偏差与统计证据诊断，不能保证未来利润。[DSR 作者论文](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
- 当前 pbo_proxy 是被验证候选失败比例；展示改名“验证失败率”。正式 PBO 需要相应的候选收益矩阵与组合对称交叉验证流程，首版不声称已经实现。[PBO 作者论文](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)

### 13.2 界面

两入口使用同一组预设与说明：

- 现货量价研究、永续订单流/资金费率研究、组合互补研究；选项由数据能力决定。
- 搜索前显示启用因子族、禁用原因、数据覆盖、样本是否充分、执行/成本模型和预估资源。
- 进度显示“唯一有效候选 → 不同候选 → 验证通过 → 封存通过”，不只显示代数与最高综合分。
- 结果区分探索、验证通过、封存通过、组合成分；显示持有周期、来源数据、净换手成本、funding 成本、失败原因。
- 阈值/版本/数据修订等详细内容放研究详情和导出，不挤入普通选择流程。
- 封存揭示后继续研究显示新实验关系；旧数据已公开，不再标为未见数据。

收藏、历史和挂载沿用既有权限边界；新格式或新数据依赖不应因缺少 token 范围判断而绕过门禁。只读/导出支持与服务端可执行资格分开处理。

## 14. 任务 11（P2）：跨币验证与残差特征

**文件：** 新建 src/lib/mining/crypto-panel-source.ts、factor_lab/panel.py；修改 cross_symbol.py、factor_local.py、data-source.ts、registry.py、research-context.ts。

1. 分开实现“把同一公式放到另一币种验证”与“公式输入包含 BTC/ETH 同步收益”，两者不是同一个功能。
2. 首版验证 BTC/ETH/SOL 等固定、事先声明的小集合；同交易所、同市场类型、同周期。对历史不可得或后来上市的币明确缺失，不回填上市前数据。
3. 用 UTC 时间戳连接，只使用在决策时已闭合且已发布的伙伴数据；市场停更和数据缺口不得无限前填。
4. 每个币种采用其真实单位/成本，固定共同评估窗口。当前 cross_validate_tokens 在无可执行伙伴时返回 True；新模式改成 not_evaluated，不得显示跨币验证通过。
5. 残差 beta 只从之前窗口估计；先做单一市场基准回归，不首发高维横截面模型。
6. 同期币种高度相关，跨币结果作为迁移诊断，不声称等价于增加独立时间样本。通用因子的迁移要求与单币专属因子分开预注册。

## 15. 任务 12（P2）：盘口历史与直连优先

**文件：** src/lib/crypto-direct.ts、src/components/common/crypto-data-panel.tsx；新建 src/lib/mining/book-collector.ts、book-store.ts、factor_lab/book_features.py；如需要应用退出后采集，再独立评估 Tauri 后台组件。

1. 将采集从页面生命周期移至应用级服务，按 venue/instrument 分桶保存 IndexedDB 或本地持久文件，记录容量和保留策略。
2. 第一阶段仍采定时快照：exchange_time、received_at、sequence（若有）、买卖各档、档位单位、采样间隔、失败记录。现有摘要可迁移为摘要档案，不能伪装成完整深度历史。
3. 定时快照能支持价差/深度不平衡研究；不能用于精确订单新增、撤单或队列位置重建。后者需另做增量订阅、序列连续性与快照同步。
4. 只把过去完整采样窗口聚合成特征，标记覆盖率和断档；不得让本 bar 收盘之后收到的快照参与本 bar 信号。
5. 本地直连优先；只对网络超时、区域连通或跨域等原因评估服务器转发。转发必须保留原市场、原时间和原单位。
6. 历史不足、接口不提供、权限不足不靠服务器转发“补齐”。当前代码最近 175 天约束来自既有 Gate 数据获取限制；实施时复核接口实际限制，并将能力窗口写入元数据。
7. 采集够长、覆盖率合格之前仅提供探索模式；先完成无盘口依赖的 P0/P1，不让盘口阻塞主线。

## 16. 测试与实验验收

### 16.1 必需的工程回归

在现有 scripts/verify-*.py、Vitest 框架中补测试，避免另起一套无法运行的测试体系。

建议新增：

- scripts/verify-crypto-causal-v2.py：前缀不变、缺失、lookback、全段/切片一致性。
- scripts/verify-crypto-splits.py：训练/验证/封存、标签边界、样本不足、跨币时间对齐。
- scripts/verify-crypto-execution.py：次根开盘、资金费用、首尾仓位、组合成本。
- scripts/verify-expression-v3.py：版本、注册表、参数与旧公式黄金回放。
- src/lib/mining/research-context.test.ts：两入口参数与数据能力预检。
- src/lib/mining/gpu/archive.test.ts：同质拥挤、探索配额、容量及恢复。
- 扩展 scripts/verify-crypto-gpu.cjs 与 gpu/parity.test.ts：真实 GPU 数值和精算召回。

现有检查按改动运行：

    npm run typecheck
    npm test
    npm run build
    python -X utf8 scripts/verify-crypto-profile.py
    python -X utf8 scripts/verify-crypto-mining-cost.py
    python -X utf8 scripts/verify-selection-v2.py
    python -X utf8 scripts/verify-mine-stepwise.py
    python -X utf8 scripts/verify-gpu-session.py
    python -X utf8 scripts/verify-kernel-tests.py
    python -X utf8 scripts/verify-kernel-text.py
    python -X utf8 scripts/verify-local-features.py

依赖网络的 verify-crypto-direct.mjs 仅作可用性冒烟，不让实时行情影响确定性回归。实际 GPU 验证按现有脚本要求准备环境，并记录是否真实运行；跳过不能算通过。

### 16.2 基准矩阵

- 市场：Binance 现货、Gate 永续分开。
- 币种：固定 BTC/ETH/SOL，另选若干按历史时点流动性规则确定的标的；不得挑本轮结果最好的币。
- 周期：首版 15m、1h；日线仅在历史满足条件的渠道作为完整验证，其他标成探索。
- 随机种子：先用 5 个固定种子做开发比较，重要结论用更多预注册种子/新区间复核。
- 数据集：开发区间与最终评估区间分开。各开发模块的消融只使用开发数据；最终方案冻结后统一揭示最终区间，不根据各次封存结果反复挑模块。
- 预算：至少同时报告固定唯一候选数和固定机器时间两种比较；性能比较区分冷启动/热启动。

消融组：当前基线 → P0 口径修正 → 档案/漏斗 → 模板/因子族 → 新特征 → 新算子 → 组合选择。P0 口径变化影响收益数值，不能当作策略收益改善；质量提升主要与修正后的共同基线比较。

### 16.3 指标和上线条件

主要结果：

1. 固定预算内封存通过的不同单因子数，以及每个因子的失败/通过依据。
2. 最终冻结组合的扣费后表现、换手、回撤、成本压力与成分增量；与最佳单因子、等权基线同时比较。
3. 每秒唯一有效候选、重复比例、各族覆盖、精算耗时、峰值内存和 GPU 漏斗召回。

GPU 召回建议目标：在多个固定表达式集上，CPU 前 10 的候选被粗排前 50 捕获的比例不低于 90%，并单列近似并列、无效值、不同算子族。若新模型/算子未达标，扩大精算漏斗或走 CPU；不能只验证最终显示数字来自 Python 就认为粗排无损。

数值容差按算子预先声明，CPU float64 前缀测试可用 rtol=1e-9、atol=1e-12 起步；GPU f32 根据极值/排序离散性分层设置，不能为通过测试随意放大容差。

“新增模块上线”为：工程契约全通过，开发消融有证据改善产出/效率且无明显稳健性损害，冻结后的最终实验完整披露。可以将“独立合格因子中位数提升 20%”作为研究目标，不能把它写成必达承诺，也不能通过改门槛制造达标。

若真实行情找不到增量，保留 P0 修正、回退无效搜索扩展并记录负结果。没有足够合格样本时报告不足，不用模拟数据的盈利结果替代真实验证。

## 17. 交付顺序与完成清单

建议拆成可以独立评审的提交组：

| 批次 | 内容 | 依赖 | 完成证据 |
|---|---|---|---|
| 1 | 基线、统一上下文、切分/因果/样本修正 | 无 | 黄金回放、前缀和边界测试 |
| 2 | 快照复用、执行/资金费用、研究状态 | 批次 1 | 两入口一致、现金流手算对照 |
| 3 | 档案、GPU 漏斗、现有算子模板、LLM 词表 | 批次 1～2 | 固定预算消融及召回 |
| 4 | v3、参数算子与新增因子族 | 批次 1～3 | 兼容测试、逐模块收益/性能实验 |
| 5 | 组合贡献、跨币面板 | 批次 4 | 冻结组合增量与迁移报告 |
| 6 | 持续盘口采集与盘口因子 | 可独立积累数据，因子依赖批次 4 | 覆盖质量和足够历史 |

每批完成后更新研究文档与变更清单。Python 文件新增/删除时运行 node scripts/gen-kernel-manifest.mjs；核对 public/pykernel/kernel-files.json 的实际职责与生成逻辑，不手写与工具不符的校验字段。涉及数值口径时统一更新 factor_local.py、src/lib/kernel-version.ts、crypto-profile.ts 的内核版本和兼容判断。

实施 AI 最终应提交：

- 两入口功能与参数贯通的代码及针对性测试。
- 基线/消融结果与数据哈希、配置、seed、硬件、版本。
- 旧公式与旧任务的兼容说明；新公式导出与恢复示例。
- 因子族/算子能力表、数据缺失与单位说明。
- 已验证、未验证、实验无增量、仍受数据限制的事项清单。

本轮交付仅为以上方案；不包含业务实现、GitHub 推送或构建触发。
