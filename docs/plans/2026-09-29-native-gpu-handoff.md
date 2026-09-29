# Native GPU Engine：实现交接清单

更新：2026-09-29，约北京时间 09:45。本文是实现状态交接，不替代或改写原设计。

## 1. 接手结论

**M1、M2 已完成并提交；M3 已写主要接线，但尚未通过出口；M4 尚未开始。没有推送、打 tag 或发布 Native GPU 版本。**

当前原生版本 `native-gpu-v1-m3.1` 的 G1、完整 G2、47 内核 IR 审计和真实核心后端完成/暂停/释放验证已通过。当前版本的 G3、完整 G4、G5、G6、最终 G7 尚未完成。8 小时长跑尚未开始。

接手方应继续现有 worktree 和未提交代码，先完成 M3，不能把“代码已写”当作“验收已过”。

## 2. 工作目录、分支和环境

| 项目 | 当前状态 |
|---|---|
| 原仓库 | `D:/pyobj/AI Trading Desktop` |
| **实现 worktree** | **`C:/Users/bbsx1/.codex/worktrees/native-gpu-engine/AI Trading Desktop`** |
| 分支 | `codex/native-gpu-engine` |
| HEAD | `ea260183d34a9b6e55dcef083ec44d37276912be` |
| M1 commit | `2ae7e33 feat(native-gpu): implement M1 sidecar, deterministic CUDA VM and benchmarks` |
| M2 commit | `ea26018 feat(native-gpu): complete deterministic GPU research pipeline and qualification gates` |
| M3 | 大量 tracked 修改及 untracked 新文件，**尚未提交** |
| 原生引擎版本 | `native-engine/VERSION`：`native-gpu-v1-m3.1` |
| app 版本 | 当前 worktree `src-tauri/tauri.conf.json` 实际是 **0.2.43**；任务起始文字写 0.2.42，0.2.43 是已有基线提交，本任务没有 bump |
| GPU | RTX 4050 Laptop，6,141 MiB、20 SM，驱动 617.14 |
| CPU | i9-13900H，测试看到 20 线程 |
| 原生 Python | `.local-data/native-engine-venv/Scripts/python.exe`，3.11.14 |
| 原生依赖 | Taichi 1.7.4、numpy 1.26.4、msgpack 1.1.1、websockets 15.0.1 |
| 浏览器控制 Python | 默认 `python` 是 3.10.9，已装 Playwright；原生 venv **没有 Playwright** |
| Rust target | `D:/pyobj/AI Trading Desktop/src-tauri/target` 可复用已有构建 |
| Git remote | `https://github.com/roberts9012062/ai-trading-desktop.git` |

**所有实现/测试命令显式设 workdir 为上述 worktree。不要在原 checkout 继续写代码。不要切分支、清理未提交文件或重建工作树。**

最新状态快照：`.local-data/native-gpu-reports/handoff-state-2026-09-29.json`，含 HEAD、dirty 文件列表、G2 哈希复核及 app/native 版本。快照生成后又新增了本文和对接提示词，属于正常新增文档。

### 正在运行的进程

- 原生核心测试已正常结束，没有本轮原生 GPU 测试进程继续占卡。
- Vite preview **4209** 仍在运行，主要 node PID 当时为 **24352**；进程号需重新核实。
- 4205、4206、4207、4208 可能仍有旧 preview。不要用它们获取新构建。
- 4209 已构建 M3 core/runners 和原 G3 页面，**不含刚新增的 soak 页面**。
- 下一次构建用 **4210**，再下一次 4211，依次递增；每次构建都换新端口。
- 未启动任何长跑、定时任务、发布流程。

## 3. 必须保留的约束和已批准调整

先完整阅读 `docs/native-gpu-engine-plan.md`（218 行）。原文保持不动；以下是产品在本会话明确批准的补充。

### 不可变约束

1. 严格 M1 → M2 → M3 → M4；本次 M3 出口 G5/G6 未通过，不能开始 M4 实现。
2. 只改桌面端。**禁止修改或操作服务器仓库 `D:/pyobj/Decentralized transactions`。**
3. 旧 CPU/WebGPU 数值算法、`cpu-backend.ts`、`gpu-backend.ts`、`shard-pool.ts`、`public/pykernel/`、旧 `scripts/verify-*.py` 保留。
4. `device-profile.ts` 的 100k/200k/300k 护栏不变。已有“70k 稳定 / 246k 旧路径 OOM”事实不必重验，不用修改它们为原生实现辩护。
5. 同机同卡同版本逐位确定；固定归约树、禁止浮点 atomic、固定滑窗顺序、禁止 `ti.random`；每次启动 20 tokens 双跑，不一致拒绝上线。
6. composite **真相对差 `<1e-9`**；CPU 为 0 时 native 必须为 0，不能加宽分母掩盖误差。合格冠军一致率 ≥99%，严格筛判定一致率 ≥99.9%。
7. 不擅自增加 DSR/PBO/换手率阈值，也不能为了产出冠军跳过任务已有门。
8. 原生的数值版本完整随历史/收藏/进度保留；降级后改回旧内核版本，不能混用两种数值评分。

### 已授权，无需重复确认

| 调整 | 产品批准的执行口径 |
|---|---|
| mixed 精度 | **GPU f32 粗排 + GPU f64 权威重算**，保留全部精度阈值 |
| VM 并行布局 | 每条指令按候选 × 时间块并行；保留栈式 VM、语义、固定滑窗顺序与 f64 权威 |
| 性能 | **每代 ≤5,000ms**；G2 是数值门，其精度阈值没有变化；G3 GPU 占用 ≥60%、3000×100 不变 |
| 合格冠军 | 按现有严格筛及任务配置；只发布证据完整且通过的合格冠军，可以为 0 |
| 两层 G2 | 原始研究候选进行数值对拍；两引擎应用相同合格门后再比冠军 ≥99% |
| 封存 | 封存数据不参加进化、补选或重排；缺失/失败 OOS WF 证据不能作为合格冠军 |
| M3 接线 | 允许 `docs/plans/2026-09-29-native-gpu-m3-wiring-scope.md` 列出的原生专属分支和可选字段，旧路径逻辑不变 |
| 恢复 | 启动/明确驱动不可用 → WebGPU → CPU；运行中普通进程丢失按 D-1 自动重试最多 3 次；第四次丢失 paused；预算跨暂停/恢复保留；运行中确认驱动不可用直接降级 |
| 原生组合 | **权重只拟合冻结训练段；指标只计算冻结封存段，无封存时用测试段**，旧 portfolio.py 不改 |
| IDB 测试 | 仅 `src/lib/idb.test.ts` 两个版本断言和两个标题 4→5；这四行已在 M2 commit 内完成 |

相关批准方案还包括 VM layout proposal、champion qualification proposal、portfolio boundaries。发现需要再次改设计时先与产品讨论。

## 4. 已完成实现：M1 / M2

### M1：已完成、已提交

- [x] Python sidecar、loopback WS、随机端口/一次性 token、控制/二进制协议、会话与心跳。
- [x] Rust spawn/kill/status，开发环境 runtime 路径，启动握手，旧启动回调不能杀掉新进程。
- [x] JS IPC client、认证、msgpack f64 列、请求超时、错误/心跳。
- [x] WGSL VM 逐语义移植、mixed/f64、固定窗口及固定归约、自检。
- [x] 真实 70,174 根 / 3,000 tokens，5 轮实际 8 worker 对照；mixed 加速 **11.056–15.703×**，f64 **10.424–14.029×**，均通过 M1 ≥8×出口。
- [x] 有效候选及重复 multiplicity 一致，均 2,515。
- [x] M1 26 个原生测试、TS/Rust 测试、自检及 IR 审计。

证据：M1 plan 尾部和 `m1-mixed-authority-r3.json`、`m1-f64-authority-r3.json`、`ir-m1.5.json`（均在 `.local-data/native-gpu-reports/`）。早期 m1.x 的失败诊断不是最终证据。

### M2：已完成、已提交

- [x] GPU 特征矩阵、指标、WF、strict、去重、joint/selection/report graph/precise 全管线。
- [x] f32 粗排评分私有，公开/归档权威数据用当前版本 GPU f64。
- [x] CPU f64 oracle 语义对拍，边界/舍入/复杂表达式回归。
- [x] 研究候选与合格冠军分层，OOS/WF/封存/执行口径证据门。
- [x] 全部 130 个原生测试通过（662.241s）。
- [x] 完整 G2：7 品种 × 4 周期 × mixed/f64 = **56/56**；CPU/native 各 14 个合格冠军，raw/qualified overlap 和 strict agreement 最低均 100%；数值门全部通过。
- [x] mixed G3：真实 ETHUSDT 15m 永续 **70,174 根、3000×100** 全部完成。
  - max **4.5971s**，median 1.54435s，mean 1.885782s；最后一代 1.6464s。
  - nvidia-smi 每 200ms，912 samples，覆盖 100%，时间加权 GPU **76.393984%**。
  - 显存峰值 **2,539 / 6,141 MiB = 41.345%**。
  - 最终 1 个 raw research、0 个 qualified：确有 strict/WF OOS/封存失败，已批准允许 0；不得人为补冠军。
- [x] M2 G1 和 40/40 IR 内核，无 atomic。

证据：`native-suite-m2.28-r1.log`、`g2-full-m2.28-r1.json`、`g3-mixed-m2.28-100-r1.json/.gpu.csv`、`ir-m2.28-r2.json`、M2 plan 尾部。

## 5. 已写实现：M3（未提交，出口未过）

### 5.1 新增前端文件与职责

| 文件 | 已写内容 / 测试 |
|---|---|
| `src/lib/native-engine/bars.ts` | f64 列、字符串时间/渠道、可选缺失值、boolean、原数据护栏；2 测试 |
| `src/lib/mining/backends/native-gpu-core.ts` | 沿用原 JS Rng/进化；GPU coarse→f64→strict→precise；训练 bestSeen；最终才揭示 sealed；cleanup；5 测试 |
| `native-gpu-backend.ts` | ComputeBackend snapshot/direct、拥有自己的连接/取消、清理、probe；6 测试 |
| `native-recovery-backend.ts` | 恢复包装器，按 origin 委派原 CPU/GPU 后端；管理 stage/recovery 和私有 abort |
| `src/lib/native-engine/process-lease.ts` | 两入口共用一条 FIFO GPU 队列、精度切换仅 idle、invalidate/release 幂等；3 测试 |
| `recovery.ts` | 3 次重启预算、第四次暂停、启动/驱动降级、跨 origin 清分数、只携 tokens；7 测试 |
| `qualification.ts` | Python 合格门的元数据 JS 版本，用于降级输出；4 测试 |
| `qualification-golden.test.ts` | 56 个 G2 用例×CPU/native×中间/最终及哈希，共 **225** 测试 |
| `version.ts` | `native-gpu-v1` 标签、精确 VERSION、当前 f64 provenance 判断 |
| `finalize.ts` | 原生结果组装，保留 tag/version，接受 GPU 组合结果，不盖 Pyodide 戳 |
| `origin.ts` | 按 native 版本分组，旧记录不改数 |
| `progress.ts` | 阶段、资格失败原因的用户文案 |
| `use-native-availability.ts` | 仅选 native 时懒探测 G1，不可用原因、重试；共享队列 |
| `src/lib/mining/native-runner-integration.test.ts` | mock 后端的真实 LocalMiningRunner 状态/归档/预算等，2 测试 |
| `native-factor-lab-integration.test.ts` | mock 后端的真实 FactorLabSearchRunner 暂停/立即恢复/预算等，3 测试 |

文件名未写目录时接续同一模块目录。可通过 `git status --short` 获取全部新增文件，不要漏加 untracked 文件。

### 5.2 已改授权接线点

- [x] 两个工厂 native 分支：`local-factor.ts::createSearchBackend`、`local-runner.ts::backendFactory`。
- [x] `backends/types.ts`、`mining/types.ts` 增加 native device/precision/version、可选训练归档及 qualification/recovery/progress 字段。
- [x] `device.ts` 原生桌面判断；原 CPU/GPU 分支不变。
- [x] `local-store.ts` 原生 checkpoint 元数据；`local-runner.ts` 原生归档、持久化预算、实际 origin、GPU portfolio、paused 语义。
- [x] `factor-lab-runner.ts` 原生 pending cleanup、独立 bestSeen、预算/版本、阶段/恢复/完成 guard；导出类供测试，原 module singleton 保留。
- [x] 因子实验室 hook 选择/持久化 native 与 precision，避免强制转换为 CPU。
- [x] 两页面 native 按钮、可用性原因、f64 开关、进度/SM/资格计数与失败原因。
- [x] 历史/收藏 native 来源分组；当前版本兼容分支。
- [x] `ipc.ts`/Rust 握手要求精确 VERSION 和 portfolio 自检证据。

### 5.3 GPU portfolio 与内存实现

- [x] `native-engine/engine/portfolio_ti.py`：冻结训练 IC 权重、封存/测试评分，7 个固定树 GPU f64 内核；只接受最终合格冠军，少于 2 个返回 null。
- [x] `precise_ti.py` 只在 final + include_portfolio 时返回组合；`selfcheck.py` 增加组合双跑和版本 digest。
- [x] `memory.py`：GPU resident buffer 去别名统计；静态 reserve 和驱动/WebView reserve；prepare_features 前预检；深数据自动缩 tile 或 actionable MemoryError。
- [x] 3 个 portfolio CUDA 比较测试：legacy/plain/selection/v2 显式边界 CPU oracle、逐位双跑、封存扰动不改变训练权重、无训练/少于 2 冠军不生成组合。
- [x] 2 个内存规划 host 测试：70k tile128、246k tile 缩小、1GB 卡明确错误。
- [ ] **246k 真实设备显存/内存验证**仍未完成；上述 host 规划不等于完整 G4。

### 5.4 测试工具

- [x] `scripts/native-gpu-m3.ts/.html` + `verify-native-gpu-m3-core.py`：真实 NativeGpuBackend complete/pause/dispose。
- [x] `scripts/native-gpu-m3-runners.ts` + `verify-native-gpu-m3-runners.py`：真实默认两工厂、真实 sidecar、IDB，complete/kill/fallback/driver 模式，**脚本已写但尚未实跑**。
- [x] `scripts/native-gpu-injected-sidecar.py`：外部测试注入缺驱动、无卡、G1失败和运行中结构化驱动丢失，生产数值源码不改。
- [x] `export-native-qualification-fixture.py`：从冻结 G2 导出一致性 fixture。
- [~] `scripts/native-gpu-soak.ts/.html`：刚新增的长跑浏览器草稿，**未 typecheck、未构建、未跑，有已知问题（§8）**。
- [ ] 长跑 Python 控制器、验收函数及其测试尚未写。
- [~] `test_performance_gate.py` 刚给 sampling fixture 补 `vram_peak_fraction` 并加 70% 边界拒绝断言，**修改后还未跑**。

## 6. 当前验收门及证据

所有证据根目录是 worktree 的 `.local-data/native-gpu-reports/`。

| 门 | 当前状态 | 已验证与缺口 |
|---|---|---|
| G1 | **m3.1 通过** | mixed/f64 20 tokens 双跑，features/reports/selection/layouts/portfolio；`g1-m3.1-r1.json` |
| §4.3 IR | **m3.1 通过** | `ir-m3.1-r1.json`，47/47 compiled，atomic 列表空；IR SHA `9c4171d0aaeed06e4bb961aa7762e8519196cbd3ada0d4794b9d3dd8811fce92` |
| G2 | **m3.1 完整通过** | `g2-full-m3.1-r1.json`，56/56、14 reference qualified，最低 raw/qualified overlap/strict均1.0；交接时所有记录的 native 数值源码 SHA 复核无变化 |
| G3 | **M2.28 通过；m3.1 待复测** | 当前版本增加 portfolio 和内存接线，不用旧报告冒充当前版本结果 |
| G4 | **部分通过** | M2.28 70k 峰值41.345% + M3规划测试；当前实测峰值、246k缩批/可行动错误待验收 |
| G5 | **未通过** | 8h未启动；真实两 runner 杀进程/预算耗尽/恢复尚未实跑 |
| G6 | **未通过** | 三种启动故障和运行驱动丢失脚本已写，尚未实跑；实际桌面 UI 文案待检查 |
| G7 | **阶段回归通过，最终门未完成** | M3全量Vitest225通过+1既有skip；新golden225单独通过；当前组合后的全量、新增脚本、最终旧对拍和发布版回归待跑 |

### M3 额外真实证据

1. `m3-core-real-m3.1-r1.json`：**passed=true**；complete3代、pause1代、dispose1代；每路径 connect1/dispose1；180首代权威值对照冻结CPU全部通过；`integration_complete=false`。
   - 本轮 G1 cold startup159.312s；测试在交接核对期间正常结束，未被杀掉。
2. `m3-core-real-r1.json`：早期 m2.28 核心验证同样通过，180条。当前优先用上面的 m3.1 报告。
3. `m3-portfolio-r1.log`：3 native portfolio 测试通过（106.690s）。
4. `vitest-m3.1-r2.log`：35文件，225passed+1skipped。该全量运行早于 golden225 和 soak草稿。
5. `m3-golden-qualification.log`：225passed，锁定 Python qualification SHA；gzip fixture 286,629bytes，展开约7.85MB。
6. `m3-app-tsc.log`、`m3-harness-tsc-r4.log`：此前 app/M3 harness tsc通过；**soak不在原 tsconfig include 内**。
7. `m3-rust-r1.log`：3 Rust native生命周期/能力/precision测试通过。
8. `g7-stepwise-m2.11.log`、`g7-strict-shard-m2.11.log`：旧 stepwise/strict脚本通过；最终再跑一次以覆盖交付状态。

注意：G2 JSON 约146MB，IR log约748MB。读取小型 summary 或提取字段，别把大文件整行输出到上下文。

## 7. 未完成任务：建议按这个顺序继续

### M3-A：审查 dirty 代码与测试草稿（先做）

- [ ] 完整阅读原设计、批准补充和本文；核对 git status，保留未提交工作。
- [ ] 修复 §8 中确定的 soak 脚本问题；补 Python控制器和验收测试。
- [ ] 将 soak TS 明确纳入测试 tsconfig；跑 app/harness类型检查。
- [ ] 运行新增的 performance fixture测试；运行当前整个 native suite，预计旧130+portfolio3+memory2=135，以实际发现数量为准。
- [ ] 运行合并后的全量Vitest（不能把两次225的独立结果当作一次450全量绿）。保留既有1skip的性质，不伪造全绿。

### M3-B：真实双入口完成、暂停/恢复、共享进程

- [ ] 新端口构建（至少4210），实跑 runner `--mode complete`。
- [ ] 因子实验室与超级因子均3代完成、实际Native、origin/version正确、0合格时private bestSeen仍在。
- [ ] 确认defaultfactory、IDB每代归档、GPUportfolio/null、会话释放均工作。
- [ ] 对两入口同时排队、取消等待不杀另一任务、精度切换仅idle进行真实验证。现有 lease3测试只是hostmock，不是完整桌面实测。
- [ ] 核对实际Tauri开发版spawn/kill/status/UI。浏览器命令适配器只监督真实子进程，不能等价声称测过桌面打包程序。

### M3-C：G5进程丢失与D-1

- [ ] runner `--mode kill`：每入口第1/2/3次自动重启，第4次paused、预算3、记录最后完整代数。
- [ ] 手动resume后完成剩余代数，预算不能归零；只有tokens作为种子跨恢复，非精确演化轨迹恢复。
- [ ] sealed仅最终揭示，暂停/取消不揭示、不补选、不重排；资格失败不进public champs。
- [ ] 此测试可能约9次冷启动，20多分钟；单次G1约150–210s，不能误判“安静”为崩溃。

### M3-D：G6降级链

- [ ] `no-driver`、`no-card`、`selfcheck`三种启动注入，各验证Native→WebGPU。
- [ ] 再强制WebGPU不可用，各验证Native→WebGPU→CPU；应使用真实旧backend，仅环境能力注入。
- [ ] `--mode driver` 验证运行中确认驱动不可用直接降级，清除跨origin评分，预算不被普通重启逻辑误消费。
- [ ] 两入口实际origin、UI/阶段提示、封存/资格门、恢复checkpoint准确。
- [ ] 杀进程可真实做；**不要自动卸载/禁用系统显卡驱动**。结构化故障注入与实际拔驱动测试必须区分；如需系统级驱动操作另与用户明确协调。

### M3-E：当前m3.1性能与内存

- [ ] 当前版本重新完成G3：ETH永续15m70174、3000×100；每代≤5000ms、全循环GPU时间加权≥60%，完整采样覆盖。
- [ ] 用当前真实双runner再核对集成开销（归档、最终portfolio），不要只测VM/eval段。
- [ ] G4：当前峰值<VRAM70%，原device-profile guard未变。
- [ ] 246k使用明确可识别数据/配置做原生缩批或可行动错误验证；别突破本机档位guard，别复测已知旧worker OOM来当新引擎证据。
- [ ] 正向portfolio IPC用至少2个真实合格冠军验证一次；现有ETH性能样本最终0冠军，覆盖不到该路径。可从G2的正向参考用例选取，不能伪造qualified。

### M3-F：8小时长跑（G5真正缺口）

- [ ] 完成长跑控制器与有效验收，再先做短诊断跑验证脚本；短跑不能声明G5通过。
- [ ] 实际持续挖掘≥8小时；草稿方案是独立3000×100任务交替两个入口、预声明seed42+cycle、无前任务封存反馈。
- [ ] 8小时按真实代计算时间累计，startup/features/清理不计入（草稿采用较严格统计）；记录完整wall time与间隙。
- [ ] 记录每代/每任务进度、sidecar/Python/browser/system内存、nvidia-smi、SOURCE SHA。
- [ ] 0崩溃/重启/降级/意外暂停；两入口都完成任务；冠军按冻结门复核；同一共享进程可持续服务。
- [ ] 报告允许合法0冠军，不能为看起来有效而改门或补选。
- [ ] 最后G5/G6全部通过，整理M3实现/验收文档，提交功能commit，再进入M4。

### M4：尚未开始（不能越过M3出口）

- [ ] 默认内置python-build-standalone CPython3.11 + frozen依赖 +engine，组装 `resources/native-engine/{python,site-packages,engine,VERSION}`。
- [ ] 根目录已有`requirements-native.lock`；CI组装必须使用冻结依赖并校验下载/产物SHA，验证离线/无系统Python启动。
- [ ] Tauri bundle resources接线；release Rust已有路径分支，但资源实际尚未被打包。
- [ ] 测包体积/安装/启动/卸载及路径含空格/非ASCII；G1失败正确拒绝，fallback仍可用。
- [ ] 驱动要求明确锁定与探测，保留无驱动/非NVIDIA降级口径；验证2–3驱动版本矩阵的可行证据，不伪称本机一版覆盖矩阵。
- [ ] 检查Windows executable代码签名覆盖sidecar/python及已有流程。现workflow体现Tauri updater签名，**不能自动把updater签名当成Authenticode代码签名**；证书/权限如不可用记录真实阻碍并交产品处理。
- [ ] VERSION协商、错误版本拒绝、安装后旧版本更新到新版本、更新器下载/校验/被动安装。
- [ ] 最终G1–G7用发布候选产物确认；旧对拍与Vitest完整绿，保护文件diff为空。
- [ ] 用户文档/README/限制/precision/首启编译/0合格原因/故障恢复/测试报告/第三方许可证和release notes。
- [ ] 功能commit → 检查远端当前版本/主线 → bump`tauri.conf.json` → `chore(release)`commit → push → `v*`tag → 监督CI → 验证正式安装包及更新清单。
- [ ] 选择新版本时以当前实际远端为准；不要照任务起始的0.2.42盲目打旧/重复tag。本worktree当前0.2.43不是本任务release。

## 8. 已知问题与待核查点

### 已确定的草稿问题（请先修）

1. **soak错误比较版本字段**：`native-gpu-soak.ts`目前比较 `candidate.metrics.kernel_version !== NATIVE_ENGINE_VERSION`。正确契约是 `kernel_version === 'native-gpu-v1'`、`native_engine_version === 'native-gpu-v1-m3.1'`、`native_eval_precision === 'f64'`。已有`isCurrentNativeMetrics`可复用。否则任何真实正冠军都会被误判失败。
2. **soak LocalMiningRunner早于写任务构造**：草稿开头`new LocalMiningRunner()`，随后写入IDB新record；runner私有Map不会自动发现后写的record。应在持久化测试record后构造并boot，或用真实create路径/明确的测试搭建方案。不要改生产旧runner行为来迁就测试。
3. **soak缺Python主控**：`window.nativeSoakProgress`未由任何已写控制器提供；未有G5验收函数/日志持久化/内存采样/最终SOURCE SHA复核。
4. **soak未纳入tsconfig也未build/run**，不可当作完成代码。其方案写在`docs/plans/2026-09-29-native-gpu-m3-soak.md`。
5. **新增G3显存断言的test fixture刚补字段**，还没有跑修改后测试。

### 需要核查，不是已确认生产失败

- `bars.ts`当同批时间既numeric又string时，string_columns.time可能对numeric行写null，覆盖server重建时间。实际冻结输入都是string；检查/加有意义边界测试即可，不要宣称现数据已失败。
- 收藏hook当前token-only key可能跨数值origin冲突；历史/收藏已按origin显示，但收藏标记/挂载是否正确分隔需要检查。服务端schema/去重不能在本任务修改；超授权接线须先讨论。
- 因子实验室“选因子后单因子回测”仍走旧Pyodide；审查是否会错误盖native戳/覆盖历史原生数值。挖掘已保留origin，不等于单因子再回测自动原生。
- `launcher.ts`旧可选signal接口取消后直接`stopNativeEngine`；新的生产backend通过lease、且不传共享abort到launch，避免该风险。审查残余调用者，不要无理由改旧数值算法。
- lease队列在同一JS上下文共享；跨WebView并发尚未证明。任务要求两个页面入口，至少真实验证同主WebView两runner。
- `gpu_buffer_mb`是当前resident buffers估算，不是allocator/整卡峰值；UI显存估算可以展示，G4仍必须nvidia-smi真峰值。
- UI的SM数字是设备SM数量/并行信息，不是实时GPU利用率。≥60%的证据来自nvidia-smi。
- portfolio零方差/常量因子相关系数边界可查；现正向CUDA测试通过，不预先宣称bug。
- Python生产数值源码目前与m3.1完整G2哈希一致。修改它们、VERSION或数值语义后必须重新冻结并完成G1/G2/G3，不能借用旧报告。

## 9. 可直接使用的命令

以下PowerShell命令均从**实现worktree**运行。`python`负责Playwright监督，`$nativePy`负责Taichi。GPU重型任务串行跑，避免相互影响性能/显存证据。

```powershell
Set-Location -LiteralPath 'C:/Users/bbsx1/.codex/worktrees/native-gpu-engine/AI Trading Desktop'
$nativePy = '.\.local-data\native-engine-venv\Scripts\python.exe'
git status --short --branch
npx tsc --noEmit
npx tsc --noEmit -p tests/native_engine/tsconfig.m3.json
pnpm test
& $nativePy -m unittest discover -s tests/native_engine -v
```

新构建用4210，并保证build成功后再启动preview：

```powershell
npx vite build --config scripts/native-gpu-m3.vite.config.ts
npx vite preview --host 127.0.0.1 --port 4210 --strictPort
```

真实M3 core/runners（新一轮输出换名字，保留旧证据）：

```powershell
python -u scripts/verify-native-gpu-m3-core.py --url http://127.0.0.1:4210 --out .local-data/native-gpu-reports/m3-core-next.json
python -u scripts/verify-native-gpu-m3-runners.py --url http://127.0.0.1:4210 --mode complete --out .local-data/native-gpu-reports/m3-runners-complete.json
python -u scripts/verify-native-gpu-m3-runners.py --url http://127.0.0.1:4210 --mode kill --out .local-data/native-gpu-reports/m3-runners-kill.json
python -u scripts/verify-native-gpu-m3-runners.py --url http://127.0.0.1:4210 --mode fallback --fault no-driver --out .local-data/native-gpu-reports/g6-no-driver-gpu.json
python -u scripts/verify-native-gpu-m3-runners.py --url http://127.0.0.1:4210 --mode fallback --fault no-driver --force-cpu --out .local-data/native-gpu-reports/g6-no-driver-cpu.json
python -u scripts/verify-native-gpu-m3-runners.py --url http://127.0.0.1:4210 --mode driver --out .local-data/native-gpu-reports/g6-runtime-driver.json
```

再把fault换`no-card`与`selfcheck`，每种GPU/CPU目标各一次。脚本目前是待实跑状态，若发现问题按证据修，不要跳过。

G1/G2/IR/G3：

```powershell
& $nativePy -u scripts/verify-native-gpu-determinism.py --precision both --out .local-data/native-gpu-reports/g1-next.json
& $nativePy -u scripts/verify-native-gpu-kernel-ir.py --out .local-data/native-gpu-reports/ir-next.json
& $nativePy -u scripts/verify-native-gpu-parity.py --suite .local-data/native-gpu-g2/suite.json --stage full --precision both --out .local-data/native-gpu-reports/g2-next.json
python -u scripts/bench-native-gpu-generations.py --url http://127.0.0.1:4210 --bars .local-data/bench-bars/ETHUSDT-15m-perp-70174.json --precision mixed --generations 100 --out .local-data/native-gpu-reports/g3-mixed-m3.1-100.json
$env:CARGO_TARGET_DIR = 'D:/pyobj/AI Trading Desktop/src-tauri/target'
cargo test --manifest-path src-tauri/Cargo.toml native_engine::tests
python scripts/verify-mine-stepwise.py
python scripts/verify-strict-shard.py
```

G2脚本本身将native_source_sha256写入每record，但结束时哈希复核此前由外部命令做。接手方必须继续复核；交接snapshot已复核当前56record为`source_changed=[]`。

## 10. 数据和证据保存

- `.local-data/native-gpu-g2/suite.json`：冻结7品种×4周期，共28套bars/config/candidates/真实旧8worker CPU参考。
- `.local-data/bench-bars/ETHUSDT-15m-perp-70174.json`：实际性能数据；SHA256 `c95d5a0cea7af5b98a387622a598a3938002244541f8ed488faa200c5483439c`。
- `.local-data/bench-bars/`还有BTCUSDT/ETHUSDT/SOLUSDT60m历史包。
- `tests/native_engine/fixtures/champion-qualification.json.gz`是小型可提交金样fixture。
- `.local-data/`通常被gitignore；**只给另一个AI仓库Git地址不包含这些本地证据/冻结数据/venv/未提交M3代码**。最好让它直接接同一个worktree。若换机器，先显式打包保存需要的文件，不能假设push会带上。
- `data-api.binance.vision`可直连；静态`data.binance.vision`浏览器无CORS需vite `/vision`代理；fapi/OKX直连TLS已知阻断，OKX走现后端转发。
- 不能输出WS token、签名私钥、更新token等秘密到交接或日志。

## 11. 交接时保护文件检查

相对设计基线`6cd2643`，以下文件/目录`git diff --name-only`为空：

- `src/lib/mining/backends/cpu-backend.ts`
- `src/lib/mining/backends/gpu-backend.ts`
- `src/lib/mining/gpu/shard-pool.ts`
- `public/pykernel/`
- `src/lib/device-profile.ts`
- `scripts/verify-mine-stepwise.py`、`scripts/verify-strict-shard.py`

服务器仓库从未触碰。`idb.test.ts`仅已授权四行修改在M2 commit。最后再核对保护范围，不要只依赖本文。

## 12. 对接提示词

见同目录 `2026-09-29-native-gpu-next-ai-prompt.md`。提示词要求接手现状、先补M3验收、遵守已批准修改和原设计，不从头重做。
