# 短线因子实验室（桌面端）验收报告

> 分支 feat/shortline-lab。按 M-D1→M-D4 分期交付，每期区分
> **实现已写 / 测试通过 / 验收门通过** 三档陈述，未达门不冒充达门。

---

## M-D1：数据管道 + Tick 重放验证器（验收门 D1）

### 交付物（实现已写 ✅）

| 模块 | 文件 | 说明 |
|---|---|---|
| 冻结规格 | `src/lib/shortline/spec.ts` | cadence 档位 3\|5\|10\|15\|30\|60、v4 token 115-122、live 白名单、决策/风控默认参数、tanh 打分映射 |
| tick 摘要 | `src/lib/shortline/digest.ts` | digest/1 定长 72B 记录编解码 + 纯 TS SHA-256（node/浏览器逐位一致） |
| 桶累积器 | `src/lib/shortline/bucket-stream.ts` | WS aggTrade 事件与归档 CSV 双入口 → 1 秒桶；乱序拒绝 |
| **形成中 K 线** | `src/lib/shortline/forming-bar.ts` | forming-bar-spec/1：量时间归一（elapsed 下限 1s）、无交易 bar 前向填充 |
| v4 订单流 | `src/lib/shortline/orderflow.ts` | 8 特征原始值（同一实现三处共用：回填列/重放/流式） |
| 算子镜像 | `src/lib/shortline/ops.ts` | 51 算子与 pykernel OPS_CONFIG 逐条对齐（cumsum 同构、头部部分窗口、winsor/robust_zscore/centered_rank 全量） |
| 特征镜像 | `src/lib/shortline/features.ts` | live 特征 45 个 + v4（v2 口径：normWindowForBars、masked zscore） |
| 求值器 | `src/lib/shortline/evaluator.ts` | 栈式 VM + causal_v2 输出归一化 + 52+/v4 族缺失准入 |
| **重放器** | `src/lib/shortline/replay.ts` | cadence 网格逐时刻重建形成中 K 线 → 逐冠军+组合分数流；严格因果（秒桶 s 在 cut t 可见 ⇔ s+1≤t） |
| 流式引擎 | `src/lib/shortline/live.ts` | LiveScoringEngine（与重放器同一套构造/求值代码） |
| 环形缓冲 | `src/lib/shortline/ring-buffer.ts` | 50 步 + 陈旧标记（age > 2×cadence） |
| 回填管道 | `src/lib/shortline/backfill/pipeline.ts` | Vision UM daily aggTrades → digest → IDB；断点续传 + 3GB 预算 + 占用统计/清理入口 API |
| IDB v6 | `src/lib/idb.ts` | 新 store `shortline-digest`（key=symbol:date，含 SHA256） |

**同一套代码约束（红线 #2）**：重放器与流式预览共用 forming-bar.ts / orderflow.ts / evaluator.ts / features.ts / ops.ts——`live-parity.test.ts` 以同一 tick 序列双向验证（见 D3 早期证据）。

### 测试通过 ✅

- 短线包 48 用例全绿（`npx vitest run src/lib/shortline/`）：
  digest 编解码/SHA 向量、orderflow 冻结口径（含归一不变性）、forming-bar 语义、
  51 算子镜像语义、D1 双跑、D3 实时=回放、回填管道（断点续传/预算/missing）。
- 全量 Vitest **511 passed / 1 skipped / 0 failed**（idb v5→v6 升级测试同步更新）。

### 验收门 D1：重放器双跑逐位一致 ✅ 通过

**合成数据**（`replay-determinism.test.ts`）：3 数据集（种子 11/22/33，1m+5m）
× 全部 6 档 cadence × 6 公式（含 v4 token、CORR_20/BETA_20 二元、深窗
TS_ZSCORE_60/ROBUST_ZSCORE_20）→ 两独立重放实例 `replayBits`（f64 位模式序列）
完全一致；digest 序列化 roundtrip 后仍逐位一致；不同 cadence 指纹互异（网格生效）。

**真实数据**（`replay-real-data.test.ts`，ETHUSDT aggTrades 2026-09-28 归档，
144.49 万笔真实成交 → 83,877 桶，取尾部 2 小时 6,465 桶）：

```
digest_sha256 = 8366ef6ce879096cde1a4aec6c4854fb6138b07130dfbd8733a8c64f7c9549e9
cadence= 3s  steps=2380  bits_sha256=dd5ada8cf1f2b62e2450b0d37169e6e301f35a5a9d3ffd2e0ce8043779fbb16d
cadence= 5s  steps=1428  bits_sha256=842ea1f6aecb4a133361f6969f3f28802c2253cb094a3b8f7915df388903a490
cadence=15s  steps= 476  bits_sha256=867b105be1d72bf99e517772bff77d104caf24f570ebd326fe5722ba17db7205
cadence=60s  steps= 119  bits_sha256=a703088de0c3ef155a021c41e532a12b35e627493c325714fb0a6ed9b9c86250
```
每档均为双跑逐位一致（bits 完全相等才输出上述指纹）。

### D3 早期证据（页面接线前）

`live-parity.test.ts`：cadence 3/15/60s，同一事件流分别走
重放器与 LiveScoringEngine，逐步分数**逐位相等**（37 步 0 差异，含 v4 公式）。

### 已知边界与说明

1. **token 区间修正**：方案写"≥104"，实际算子占用至 114，v4 落在 **115-122**
   （见实现决策文档 §1；方案意图=现有分配之上的本地专属区间，未变更契约 schema）。
2. TS 求值器与 Python 引擎无逐位约束（挖掘 fitness 权威仍在引擎）；TS 是
   重放/流式/黄金夹具的权威实现。跨语言 ULP 风险（exp/log/tanh）在夹具
   manifest 中声明（M-D4）。
3. 真实回填的 UI 入口（进度/占用/清理）随 M-D3 页面交付；管道本身已可用。

---

## M-D2：v4 特征批次 + fitness + shortline_v1 门（验收门 D2）

### 交付物（实现已写 ✅）

**pykernel**（全部加法分支；v2/legacy 路径逐位不变）：
- `token_encoding.py`：SHORTLINE_TOKEN_OFFSET=115、SHORTLINE_FEATURE_COUNT=8
- `features.py`：SHORTLINE_FEATURE_NAMES/列键 sl_of0..7、shortline_feature_rows（masked zscore 窗 300）、feature_matrix 附加行 62-69、bars_signature 纳入 sl 列
- `vm.py`：token ≥115 分发（行 62+k）+ 52+ 族缺失准入 + token_name
- `research_context.py`：PROFILE_SHORTLINE_V1、KNOWN_PROFILES、is_v2_family、resolve_context 复用 v2 分支
- `market.py`：SHORTLINE_PROFILE 标记并入 V2 族（is_v2/is_crypto/prepare_bars）
- `search.py`：is_v2_config→语义族、树编码 62-69↔token 115-122、search 入口 fitness 开关
- `scoring/evaluate.py`：flip_rate/half_life 指标（恒算）+ shortline_penalty 乘子（模块开关，入口 try/finally 复位）
- `factor_local.py`：v2 族判定 10 处统一；mine_step 会话携带 fitness 开关

**native-engine**（VERSION → `native-gpu-v1-m3.4-shortline`）：
- `features_ti.py`：v4 行宿主计算（直接复用 pykernel shortline_feature_rows → 与 CPU 逐位同源）后上传 GPU；prepare_features v2 族判定 + feature_names 扩展
- `vm_ti.py`：矩阵行上限 64→70、validate_tokens ≥115、_execute kernel 特征行映射；kth_value 存量 AugAssign 改显式赋值（位级等价，修存量守卫失败）
- `phase_vm_ti.py`：decode/kernel 同款映射
- `metrics_ti.py`：METRIC_NAMES +flip_rate/half_life；summary 16→22 槽（sum_pos/pos²/lag/flip/p0/pN）；_finish 短线乘子（与 pykernel 同式）
- `session.py`：_accepted v4 缺失准入、plan_tile F 预算 70、TrainingMetrics shortline 标志、eval_shards 指标显式排除 factor_std（修正原 `[:-1]` 对新指标序的隐式依赖）
- `signatures.py`：KEYS 同步 sl 列（与 bars_signature 逐字段一致）
- `runtime.py`：plan_tile F 上限 64→70

**TS 侧**：`src/lib/shortline/gate.ts` shortline_v1 合格门（live 可用性/翻转率≤0.15/bar/稳定性 std≤0.20/OOS 采样点 Spearman IC≥0.015/延迟 IC≥0.5×基线；拒因逐条记录，0 合法）。

### 测试通过 ✅

- pykernel：`tests/native_engine/test_shortline_pykernel.py` 10/10（矩阵加法性 62↔70、VM 分发与准入、树编码往返、profile 解析、fitness 公式与乘子、search 端到端 shortline≤v2）
- native：`test_shortline_native.py` 3/3（GPU v4 行与 CPU 逐位一致、token 115 可执行/无列拒绝、composite=v2×penalty 12 位小数一致）
- native 全量套件：**148 测试，仅剩 2 个与 HEAD 相同的存量 DSR ERROR**（CPU DSR 日历不齐已知遗留，非本次引入）；存量 determinism_contract 失败已修复
- TS：`gate.test.ts` 4/4；全量 Vitest 519 passed/0 failed
- metrics 冻结夹具 `training-zero-pyodide.json` 按 `export-native-gpu-training-reference.mjs` 官方流程重生成（新 evaluate.py sha 01e521b2…；行为金样逐位不变）

### 验收门 D2：挖掘全链路跑通 + 门正确拒绝/通过 ✅ 通过

证据 `scripts/shortline-d2-evidence.py` → `.local-data/native-gpu-reports/d2-shortline.json`
（真实 ETHUSDT 15m 16000 根 + v4 列）：
- shortline_v1：矩阵 **70 行**，v4 token 候选（115-117 等）全部可评估；strict_eval/precise/qualification 全链路完成
- v2 对照（同 bars 去 sl 列）：矩阵 **62 行** —— 加法性成立
- 拒因正确产出（holdout/WF/OOS/strict 各门）；**0 合法合格**（候选未过 v2 严格门，不为产出放宽）
- fitness 乘子等价性由 test_shortline_native 以非零 composite 12 位小数锁定

### 重冻结（红线 #3）

- VERSION bump `native-gpu-v1-m3.3` → `native-gpu-v1-m3.4-shortline`
- **G1 通过**：mixed sha256 `a7eb5a46…`、f64 `140d6924…`（两次运行间 metrics 公式修改后自检值不变——非短线分支逐位稳定）
- G2：见下方 M-D2 附录（重冻结执行记录）

---

## M-D3：短线实验室页面 + 流式打分预览（验收门 D3）

### 交付物 ✅ / 测试 ✅

- 路由 `/factor-lab/shortline`（router.tsx）+ 侧边栏"因子实验室"二级菜单
- 页面 `src/components/shortline-lab/shortline-lab-page.tsx`：回填管理（进度/占用/清理）
  → 挖掘表单（品种/1m|5m|15m/种群/代数/成本/cadence，shortline_v1 + 原生 GPU）
  → 任务进度卡 → 冠军表（composite/翻转率/半衰期/avg换手/IC）→ 流式预览 → 挂载区
- 任务接线：`local-runner` create 时对 shortline 快照注入 v4 列（`patchBarsSnapshotColumns` + `task-enrich.ts`，digest 确定性派生；断点续训可复现）
- 流式预览：`ws.ts` Binance aggTrade 直连（重连+退避）；LiveScoringEngine + 50 步环形缓冲
  + 陈旧标记（age>2×cadence 置灰）；**纯预览，无任何下单代码路径**
- 预热：digest 尾部 closed bars（kline+aggTrades 双源喂同一构造器）

### 验收门 D3：流式预览与重放器同一 tick 序列分数一致 ✅ 通过

`live-parity.test.ts`：cadence 3/15/60s，同一事件流分别驱动重放器与
LiveScoringEngine（页面所用同一实例），逐步分数与组合分**逐位相等**
（0 差异，含 v4 公式）。形成中 K 线构造/订单流特征/求值器全部共享同一实现
（forming-bar.ts/orderflow.ts/evaluator.ts），无第二套。

---

## M-D4：挂载载荷 + 黄金夹具导出（验收门 D4）

### 交付物 ✅ / 测试 ✅

- `mount.ts`：契约 schema 逐字段组装（task_type/symbol/timeframe/cadence_seconds/
  warmup_bars/eval_version/champions[{id,tokens,weight Σ=1}]/decision/risk/fixture_manifest）；
  白名单校验（v4=115-122 与 55/57/58 → 拒绝挂载并标"仅本地"）；warmup 按公式窗口推导（下限 300）
- `fixtures.ts`：黄金夹具 shortline-golden-fixture/1（digest/1 tick 流字节 base64 +
  forming-bar-spec/1 + cadence + 公式集 + **期望分数 f64 位模式 hex**）+ manifest SHA256；
  导出前自校验（digest roundtrip 重放逐位一致）；libm 敏感算子在 manifest 声明
  （TANH/SIGMOID/SIGNED_LOG——服务器 S1 需按位复现桌面 V8 行为）
- `server-api.ts`：契约 §7 端点客户端（/api/shortline/tasks* + pause/resume/stop/scores）
- 页面挂载区：夹具导出（下载 JSON）+ 挂载按钮 + 仅本地原因展示
- 测试：`mount.test.ts`（schema 逐字段、白名单拒绝、权重归一、warmup 抬升、夹具 manifest 确定性）

### 验收门 D4：部分通过（桌面侧 ✅ / 服务器联调 ⏳ 待服务器 M-S1）

- 桌面侧自洽：载荷过 schema 校验；夹具期望值由 D1 已证确定性的重放器产出，
  manifest SHA 可复算（同输入同 SHA，测试锁定）
- **服务器 S1 联调未开始**：服务器仓库（M-S1）尚未实现 FormulaEvaluator 与
  /api/shortline 端点（桌面按红线 #9 未触碰服务器仓库）。挂载按钮在服务器
  未就绪时报明确错误。联调门保持开放，待服务器 AI 交付后执行。

### M-D2 附录 I：G2 重冻结执行记录（偏差已修复闭环，最终 56/56 通过）

> 首轮结果曾为 54/56（下述根因链保留了当时的调查记录）；按附录 II 修复
> （特征层 log 的 WASM 位级对拍）后全量复跑 **56/56 通过，G2_complete=true**
> （.local-data/native-gpu-reports/g2.json）。

**首轮结果：54/56 通过（未达 56/56 门槛）**。唯一失败 = ETHUSDT/15m 的 mixed 与 f64
两记录，各仅 **1 个候选** `[48,6,66,42,71,68,111,73]` composite 相对误差
1.66e-4 > 1e-9；两记录的冠军重合 1.0 / 严格筛一致率 1.0 / 研究重合 1.0，
其余 54 记录全过（7 币 × 4 周期 × 双精度全覆盖）。

**根因证据链（判定为存量问题，非本分支引入）**：

1. **m1-candidates.json 丢失**（.local-data 不入库，M1 时代的 ETH-15m 冻结
   候选集不可恢复）→ 套件脚本按官方参考页路径**重新生成候选集**（Rng(42)
   确定性；本次重冻结的集合本身已随参考冻结）。新集合含上式，M1 集合未含。
2. **native 侧位级稳定**：该候选的 native 权威 composite 在 HEAD 干净
   worktree 与本分支**逐位一致**（0.18417431977399565，两次独立运行）。
3. **CPU 权威路径位级稳定**：`mine_eval_shard`（参考页 8-worker 池所调用的
   同一入口）与 `mine_precise` 在 HEAD 与本分支 worktree 直跑均得
   0.18417431977399565，与 native 相等。
4. **离群值是浏览器 pyodide(WASM numpy) 参考值** 0.18420497223036278——
   即分歧发生在 pyodide↔native/CPython 的浮点实现边界（复合链
   MUL/NEG/MIN/SNR_60/SQRT 上某 bar 的 |tanh|<0.05 仓位地板翻转放大）。
   f64 与 mixed 同差 → 非粗排问题。native 源码注释本就承认该边界
   （"A one-ULP position change on a flat-price plateau can turn zero cashflow
   into a negative fee"）。
5. m3.3 的 56/56 建立在 M1 冻结候选集上——该集合恰好未触及此边界；
   **G2 的 1e-9 门对"贴边界候选"存在系统性脆弱**，本次由集合重生成暴露。

**结论与请裁决项**：
- 本分支引擎改动未移动任何被测数值（位级证据 2/3）；G1 两过；
  加法性在全部 54 个通过的记录上成立。
- 按红线字面（56/56 才算完成），M-D2 的引擎改动**不宣称 G2 全过**。
- 选项 A：接受 54/56 + 本证据链合入（后续单独开"pyodide↔native ULP 边界
  对拍"任务，系统性收紧或调整贴边界候选的容差政策）；
- 选项 B：本分支回滚全部引擎改动（短线功能不可用）；
- 选项 C：投入专项修复该 ULP 边界（对齐 pyodide 超越函数/求和顺序，
  工作量与风险另估）。
- 复现工具：`scripts/shortline-diag-mixed.py <worktree>`（位级对照）。

### M-D2 附录 II：G2 偏差修复记录（闭环）

**根因（逐步定位）**：时钟 sin/cos 假设被证伪（1447 个相位值三环境一致）→
pyodide vs CPython 全特征矩阵位级 diff → 分歧行 = SKEW20/KURT20/CRYPTO_ILLIQ20/
QUOTE_ILLIQ20 → 分步归因 → **np.log 恰在 idx=240 差 1 ULP**（与特征行首差
bar 完全吻合）；SKEW20 差 1 处来自 `d**3` 幂。即：**pyodide(WASM musl) 与
CUDA/Windows libm 在 log/pow 上差 ULP**。VM 层的 tanh/exp/pow 当年做过 WASM
对拍（libm_ti），**特征层的 log 用裸 `ti.log`（CUDA libm）从没对拍**——失败
候选 [48,6,66,42,71,68,111,73] 含 CRYPTO_ILLIQ20(token 48)，1423 个 bar 的
ULP 级因子差经 |tanh|<0.05 仓位地板放大为 composite 1.66e-4。

**修复**：
- `native-engine/engine/log_table.json`：musl(Arm optimized-routines 2018,
  MIT) log 数据表 128×2×2 + 多项式（与既有 exp_table/pow_table 同模式）
- `libm_ti.py`：移植 Arm log（近 1 域源序多项式 + hi/lo 拆分；主路径表驱动
  归约 + 次正规规格化；负数→负静默 NaN、NaN 输入原样传播，全部对齐 musl
  位模式）；diagnostic mode 5
- `series_ti.py`：特征层 op3 `ti.log` → `self.math.libm.log`（位级对拍 WASM）

**验证**：
- 16 万全域值（对数均匀 1e-320~1e308 + 近 1 域密集 + 边界/次正规/特殊值）
  pyodide 位级对拍 **160018/160018 一致**（对 CPython/Windows 恰差已知 ULP
  点——对齐目标正确）
- 提交夹具 `libm-log-pyodide-{in,expected}.json`（3219 值）+
  `test_libm_log.py`（位级一致 + 双跑确定性）
- G1 重过（mixed/f64 SHA 与修复前相同——20 自检 token 不含 ILLIQ20）
- ETH/15m 单 case G2：**mixed 与 f64 均通过**（此前失败的两记录）
- **全量 G2 复跑：56/56 通过，G2_complete=true，零失败**
  （qualified_reference_count=14；同轮全量 native 套件 151 测试仅剩 2 个
  与 HEAD 一致的存量 DSR 错误，libm 位拍测试 6/6 绿）
- 重冻结链完整闭环：VERSION bump → G1 两过 → 套件 fetch → 参考 28/28 导出
  → parity 56/56。红线 #3（引擎改动必须 56/56）满足。
