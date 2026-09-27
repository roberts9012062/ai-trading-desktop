# 原生 GPU 挖掘引擎（Native GPU Engine）实现方案

> 版本：v1.0（2026-09-28）
> 状态：**仅设计，未实现**。交付给实现方按本方案执行。
> 范围：因子实验室 + 超级因子 两个挖掘入口共用同一引擎。
> 前置结论（本轮已实测的事实，实现方不必重验）：
> - WebGPU 无 f64，GPU 只做 f32 粗排，每代 GPU 占用 1-4%，权威精算全在 CPU（单点段为每代瓶颈）；
> - 消费级 GPU FP64 速率为 FP32 的 1/32~1/64；业界共识是混合精度（搜索 f32 + 关键统计 f64）；
> - 现有数据规模锚点：7 万根 × 8 worker 稳定 / 24.6 万根 OOM（内存护栏按档位 10/20/30 万根）。

---

## 0. 一句话目标

在 Tauri 桌面端挂一个**本地原生计算 sidecar 进程**（Python + Taichi），把"特征计算 + 因子表达式求值 + f64 精算（walk-forward/严格筛/指标）"整条管线搬上原生 GPU（可选 Float64），绕开 WebGPU 无双精度的平台限制；JS 侧只保留进化与编排。**现有 WebGPU/Pyodide 引擎全量保留为降级路径**，新引擎作为第三引擎接入。

---

## 1. 目标与非目标

### 目标
1. GPU 承担除进化外的全部数值计算（特征矩阵、表达式求值、指标、WF 折、严格筛），GPU 利用率目标 **≥60%**（挖掘认为持续型负载时）。
2. 双精度可选：`Float64 严格模式`（科学卡/高配用户）与 `混合精度模式`（默认，f32 主体 + 补偿求和）。
3. 因子实验室与超级因子共用（`ComputeBackend` 接口第三个实现），UI 增加引擎选项"本地 GPU（原生）"。
4. 失败自动降级链：**Native GPU → WebGPU 引擎 → CPU 多核引擎**，任何一级不可用不影响可用性。
5. 打包可分发：安装包含 sidecar（或首启下载），不破坏现有更新器。

### 非目标（本期不做）
- 不改变进化算法（JS 侧 nextGeneration 原样）。
- 不做服务端/集群执行（本地单机）。
- 不做 AMD/Intel GPU 的 f64 优化（Taichi Vulkan 后端 f64 支持弱，非 NVIDIA 卡直接落到 native-CPU 档）。
- 不移除现有 Pyodide 内核与对拍体系（见 §7 精度哲学）。

---

## 2. 总体架构

```
┌────────────────────────── Tauri 桌面应用 ──────────────────────────┐
│  WebView (React)                       Rust (tauri-app)            │
│  ┌────────────────────────┐           ┌──────────────────────┐    │
│  │ 进化/编排(JS)           │           │ sidecar 进程管理       │    │
│  │ factor-lab-runner      │──spawn──▶ │ (tauri-plugin-shell)  │    │
│  │ LocalMiningRunner      │           └──────────┬───────────┘    │
│  │      │ NativeGpuBackend│                      │ stdio          │
│  │      ▼ (新 ComputeBackend)                    ▼                │
│  │  IPC 客户端(ws/127.0.0.1:随机端口+token) ─▶ ┌────────────────┐ │
│  └────────────────────────┘                 │ sidecar: Python │ │
│                                             │  + Taichi 引擎    │ │
│                                             │  features/vm/    │ │
│                                             │  scoring/WF/strict│ │
│                                             │  GPU(CUDA f64/f32)│ │
│                                             └────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 技术选型：Taichi（推荐），理由与替代对比

| 候选 | 优势 | 劣势 | 结论 |
|---|---|---|---|
| **Taichi** | 内建 f32/**f64** dtype；kernel 语言接近 numpy；AOT 可预编译；CUDA/Vulkan/CPU 三后端自动回退；wheel 自带 CUDA runtime（用户只需装显卡驱动） | 生态小众；AOT 工具链有版本耦合 | **推荐** |
| CuPy | numpy 兼容、成熟 | 树解释器需手写 RawKernel，f64 循环滚动算子开发量大 | 备选 |
| Numba CUDA | 纯 Python JIT | 每次启动 JIT 编译慢；分发需锁 LLVM 版本 | 不推荐 |
| Julia(PySR 方式) | f64 最强、可逐表达式代码生成 | 打包 Julia 运行时进 Tauri 极重（500MB+） | 不推荐 |

**端口策略**：把现有 WGSL 栈式求值 VM（`src/lib/mining/gpu/wgsl/eval-vm.wgsl.ts`，每候选 1 workgroup、256 线程合作扫 T 根、栈槽 9 层）**逐语义移植为 Taichi kernel，dtype 参数化**（f32/f64）。该 VM 已经过粗排与对拍锤炼，比重新设计树求值器风险低得多。

### 2.2 sidecar 形态

- 运行时：**嵌入式 CPython 3.11（python-build-standalone）+ 依赖目录**，随安装包分发（预计 180-280MB，详见 §6）。不用 PyInstaller onefile（解压慢、杀软误报率高）。
- 目录布局（打进 `resources/native-engine/`）：
  ```
  native-engine/
    python/            # 嵌入式解释器
    site-packages/     # taichi, numpy, pyarrow(可选), msgpack
    engine/            # 本方案新增的 Python 包（§5）
    VERSION            # 引擎版本戳（进 kernel_version 元数据）
  ```
- 进程管理：`tauri-plugin-shell` sidecar（`tauri.conf.json > bundle.externalBin` 或 resources + 手动 spawn）。启动握手 → 心跳（1s）→ 崩溃自动重启（≤3 次/任务，超限任务转 paused）。

---

## 3. IPC 协议

### 3.1 传输层
- **WebSocket `ws://127.0.0.1:<随机端口>`**，启动时 sidecar 打印端口与一次性 token 到 stdout，Rust 侧转发给 WebView；所有帧带 `Authorization: Bearer <token>`（仅本机回环，防其他本机进程乱入）。
- 双通道：文本帧 = 控制消息（JSON），二进制帧 = 数据块（msgpack 或 Arrow IPC）。
- 选 ws 而非 stdio 直通 WebView 的原因：Tauri WebView 无标准 stdio 通道，且 ws 天然支持二进制与多路复用。

### 3.2 消息集（对齐现有 py-worker 协议，便于 JS 侧薄封装）

| type | 方向 | 载荷 | 语义 |
|---|---|---|---|
| `hello` | S→C | {engine_version, backend(cuda/cpu/vulkan), fp64_supported, device_name, sm_count, vram_mb} | 握手与能力 |
| `stage` | S→C | {message} | 阶段进度（对齐现 onKernelStage） |
| `load_bars` | C→S | 二进制：列式 f64 数组（time_idx/open/high/low/close/volume/quote_volume/taker_buy/trade_count/funding_rate/...）+ 元数据 JSON | 每（channel:symbol:tf）一次，sidecar 内存常驻（快照冻结口径与现 research cache 对齐） |
| `mine_features` | C→S→S | 配置 | 移植现内核同名模式：特征矩阵常驻 GPU 显存 |
| `eval_shards` | C→S | {candidates: tokens[]} | 全种群 f64（或混合）评估，GPU 批量 → {evaluated[]} |
| `precise` | C→S | {candidates/evaluated, best_seen, prefetched_strict, final_generation,...} | 移植 mine_precise（WF 折、_dedup_top、严格筛）→ {champions, best_seen} |
| `strict_eval` | C→S | {tokens[]} | 严格筛分片预判（可选，precise 内置亦可） |
| `dispose_session` | C→S | {session_id} | 显存/会话释放 |
| `error` | S→C | {code, message, traceback_tail} | 结构化错误 |

- **bars 传输量**：7 万根 × ~12 列 f64 ≈ 6.7MB 二进制，一次性、可复用会话；避免 JSON（15MB+ 且解析慢）。
- 结果回传：每候选 metrics dict（msgpack），每代 ~60 条，量小无瓶颈。

---

## 4. 精度与确定性设计（本方案最关键的决策点）

### 4.1 现状哲学（必须先理解）
当前铁律："对外数字必须出自 CPU f64 内核，逐位可复现"，由 `scripts/verify-mine-stepwise.py` 等对拍体系锁定。**GPU f32 只许排序**。

### 4.2 新引擎的精度哲学（变更点，需产品确认）
原生 GPU 引擎产出**新口径** `engine: "native-gpu-v1"`（写进 champions metrics.kernel_version 与收藏/历史记录）：

- **逐位一致的对象改为"同机同卡同引擎版本"**：CUDA f64 与 numpy f64 在超越函数（exp/log/sqrt/tanh）存在 ULP 级差异，与 CPU 内核逐位一致在工程上不可达、也无必要；
- 与 CPU 内核的关系从"逐位对拍"降为"**统计等价验证**"：同一批 tokens 两引擎跑全流程，断言 composite 相对偏差 < 1e-9、冠军集合（排序前 N）一致率 ≥ 99%（新增 `verify-native-gpu-parity.py`）；
- **混合精度模式（默认）**：表达式求值 f32，归约（sum/dot/mean/std/IC/Sharpe/Sortino 分子分母）用 **two-sum/Kahan 补偿累加或直接 f64 归约树**；归约顺序固定（树形、禁 atomic），保证运行间逐位确定；
- **f64 严格模式（开关）**：全程 Float64。消费卡（1/64 速率）预计仍比 8×CPU 快 ~2-4×；A100/H100 类卡收益 10×+。默认关闭，UI 高级选项里开；
- 降级到 WebGPU/Pyodide 引擎时口径回到旧引擎版本号，**绝不混口径出数**。

### 4.3 确定性保障清单（实现方必须逐条落测试）
1. 归约全部树形分块、固定块宽（如 1024），禁用浮点 atomic；
2. 滚动窗算子按固定滑窗顺序实现（不做 warp shuffle 重排差异）；
3. Taichi kernel 禁止 `ti.random`；进化随机数仍在 JS 侧（现状保持）；
4. 每次启动跑 20 条基准 tokens 的自检：两次运行结果逐位相同，不同则拒绝上线该引擎（降级）。

---

## 5. 内核移植清单（Python 侧 `engine/` 包）

按现内核（`public/pykernel/factor_lab/`）逐模块映射：

| 现有模块 | 移植目标 | 备注 |
|---|---|---|
| `features.py::compute_features` | `engine/features_ti.py` | 60+ 特征算子 → Taichi field + kernel；`_ac1` 自相关等重算子优先；矩阵常驻显存（62×70k f64 ≈ 35MB，安全） |
| `vm.py::execute/execute_for_bars` | `engine/vm_ti.py` | **移植 WGSL 栈式 VM 语义**（栈 9 层/256 线程合作/算子码表），dtype 参数化 |
| `scoring/evaluate.py` | `engine/metrics_ti.py` | position/pnl/sortino/calmar/ts_ic；归约走 §4.3 |
| `scoring/walk_forward.py` | `engine/wf_ti.py` | 折切片评估：复用 vm+metrics，按 (lo,hi) 批处理；沿用 frozen_view/前缀矩阵思想（GPU 上天然整段计算，缓存层可简化） |
| `search.py::_dedup_top/_strict_gate` | `engine/strict_ti.py` | 严格筛/去重；跨品种 peers 数据随 load_bars 一起传 |
| `factor_local.py` 的模式分发 | `engine/server.py` | ws 服务、会话管理、模式路由、stage 上报 |
| 成本/年化基数等纯标量逻辑 | 直接 numpy | 与 CPU 内核同式 |

**JS 侧新增**：
| 文件 | 内容 |
|---|---|
| `src/lib/mining/backends/native-gpu-backend.ts` | `implements ComputeBackend`（run/runDirect/probe/dispose），内部 = IPC 客户端 + 代循环（结构抄 `gpu-backend.ts`，rank 段换成 `eval_shards`） |
| `src/lib/native-engine/ipc.ts` | ws 客户端：连接/心跳/重连/二进制编解码/超时 |
| `src/lib/native-engine/launcher.ts` | 通过 Rust 命令 spawn sidecar、拿端口/token、健康探测、降级判定 |
| `src-tauri/src/native_engine.rs` | Tauri command：spawn/kill/查询状态（`tauri-plugin-shell`） |
| UI | 引擎按钮组加"本地 GPU（原生）"（因子实验室 `factor-lab-page.tsx`、超级因子 `super-factor-page.tsx` 执行位置组）；不可用时置灰并显示原因（probe 结果） |
| 接线 | `createSearchBackend()`（local-factor.ts）与 `LocalMiningRunner.backendFactory`（local-runner.ts）各加 native 分支 —— **两入口天然共用** |

进度卡片（SearchProgressCard/超级因子任务卡）沿用：`gpuStats.shardWorkers` 报 GPU SM 占用批数，`rankMs` 报 GPU eval 段，`preciseMs` 报 GPU precise 段；新增 `engineTag: "native-gpu-v1"`。

---

## 6. 打包与分发

1. **依赖冻结**：`requirements-native.lock`（taichi==x.y.z、numpy、msgpack），CI 用 `python-build-standalone` 组装 `native-engine/` 目录并哈希校验。
2. **体积预算**：python ~60MB + taichi wheel ~90MB（含 CUDA runtime）+ 自研代码 ≈ **200-260MB**；安装包从现 ~40MB 增至 ~300MB。可接受则内置；否则做**首启下载**（更新器下发 zip 到 appData，校验哈希，二次启动生效）——二选一需产品拍板，方案默认**内置**（离线可用、体验稳）。
3. 签名：sidecar exe 纳入现有 Windows 代码签名流程；杀软白名单问题在 release notes 说明。
4. 驱动：Taichi CUDA 后端要求 NVIDIA 驱动 ≥ 某版本（实现时锁定并探测）；探测失败 → sidecar 以 CPU(LightLLVM/x86-64 SIMD) 后端起 → 仍快于 8×Pyodide 的场景有限，此时 UI 建议直接用现 CPU 引擎（降级链 §1.4）。
5. 更新器：`native-engine/VERSION` 参与版本协商，WebView 端 `hello.engine_version` 落到 metrics。

---

## 7. 质量保障（验收门）

| 门 | 内容 |
|---|---|
| G1 自检 | §4.3-4 确定性自检（20 条 tokens 双跑逐位一致） |
| G2 统计等价 | `verify-native-gpu-parity.py`：对 7 品种 × 4 周期基准数据，native vs 现引擎 composite 相对差 <1e-9、top-N 冠军一致率 ≥99%、严格筛 pass/fail 一致率 ≥99.9% |
| G3 性能 | 基准机（用户机：20 核 + Lovelace）ethusdt 15m 70k 根、种群 3000×100：每代 ≤2.5s（现 WebGPU 引擎 6.5s、CPU 引擎 25-40s）；GPU 占用（nvidia-smi 采样）挖掘认为持续期 ≥60% |
| G4 内存 | 显存峰值 < VRAM 70%；系统内存遵循 device-profile 档位护栏不变；24.6 万根场景显存超限时自动缩批或报可行动错误 |
| G5 稳定性 | 8 小时连续挖掘无崩溃；杀进程 → 任务转 paused 可恢复（对齐 LocalMiningRunner D-1 语义）；因子实验室后台 runner 同样验证 |
| G6 降级链 | 无驱动/无卡/自检失败三种注入，分别验证自动落到 WebGPU/CPU 引擎且 UI 提示准确 |
| G7 回归 | 现有 vitest 全绿；`verify-mine-stepwise.py` 等旧引擎对拍不受影响 |

---

## 8. 里程碑（建议 4 期，每期可独立合入）

| 期 | 内容 | 出口标准 |
|---|---|---|
| M1 PoC | sidecar 骨架 + ws 协议 + vm_ti（f32/f64）+ eval_shards + 基准脚本 | 单代 eval 段 ≥8×CPU 池；G1 过 |
| M2 内核全量 | features/metrics/wf/strict 移植 + precise + 会话管理 | G2/G3 核心项过 |
| M3 集成 | NativeGpuBackend + 两页面接线 + 降级链 + 进度/暂停语义 | G5/G6 过 |
| M4 发布 | 打包/签名/更新器/文档 + 长跑 + 发版 | 全门过 |

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 消费卡 f64 慢（1/64） | 默认混合精度；f64 作为开关；基准报告里分模式给数 |
| Taichi 版本/驱动兼容地狱 | 锁版本 + 自检 + 降级链；CI 矩阵覆盖 2-3 个驱动版本 |
| 安装包暴涨 | 备选首启下载方案（§6.2），产品拍板 |
| 与现口径混淆 | engine 标签全程随行；收藏/历史/挂载按 engine 分组显示；旧记录永不重算改数 |
| 精算语义移植走样（WF/封存/严格筛细节多） | 逐模块对拍脚本先行（G2 在 M2 出口而非 M4）；以 `crypto-local-v2` 契约文档为口径基准 |
| sidecar 被杀软误杀 | 签名 + 官方渠道说明 + 首启下载版可降低特征命中 |

---

## 10. 实现方上手索引（本仓库现状坐标）

- 引擎接口与代循环：`src/lib/mining/backends/{cpu-backend,gpu-backend,types}.ts`
- WGSL 栈式 VM（移植母本）：`src/lib/mining/gpu/wgsl/eval-vm.wgsl.ts`、`src/lib/mining/gpu/eval-gpu.ts`
- 分片池（参考其错误语义/超时）：`src/lib/mining/gpu/shard-pool.ts`
- 两入口编排：`src/lib/mining/factor-lab-runner.ts`（因子实验室后台）、`src/lib/mining/local-runner.ts`（超级因子）
- CPU 内核（移植母本 + 口径基准）：`public/pykernel/factor_lab/{features,vm,search}.py`、`scoring/*`、`factor_local.py`
- 对拍体系模板：`scripts/verify-mine-stepwise.py`、`verify-strict-shard.py`
- 内存/设备档位：`src/lib/device-profile.ts`（护栏值沿用）
- 数据冻结口径：`src/lib/research-kline-cache.ts`（bars 载荷来源与键规范）

> 实现顺序建议严格按 M1→M4；每期出口未达标不得进入下期。所有口径决策（§4.2）需产品确认后冻结。
