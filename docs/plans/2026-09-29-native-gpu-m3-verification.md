# Native GPU M3 验收报告

更新：2026-09-29（随 M3 验收进展滚动更新；最终版随 M3 功能 commit 提交）。
工作树：`codex/native-gpu-engine`，原生引擎版本 `native-gpu-v1-m3.2`。

## 版本与重冻结说明

M3 验收中发现并修复了一个 M3 未提交改动引入的性能回归：`precise_ti.py` 在每次
precise 调用尾部执行 `session_buffer_mb` 全对象图遍历；precise 处理会让
`dedup_context` 累积大量 Python 对象，实测该遍历在暖状态每次 ~450ms（每代一次）。
交错 A/B/A 隔离量测确认：M3 每代 precise ~830ms vs M2.28 ~385ms，差值即此遍历。

修复：`gpu_buffer_mb` 改为会话级缓存——precise 入口在 dedup 填充前计算一次
（空状态实测 3.5ms），仅当 final 且 portfolio 真正生成（新 GPU 分配）时重算一次。
数值语义零变化（该字段是 UI 元数据，不进任何 metrics/评分/对拍）。

按冻结纪律，引擎源码变化即 bump `native-engine/VERSION` → `native-gpu-v1-m3.2`，
并在 m3.2 完整重跑 G1 / IR / G2 / 原生 suite（不借用 m3.1 证据）。

## 验收门状态（m3.2）

| 门 | 状态 | 证据（`.local-data/native-gpu-reports/`） |
|---|---|---|
| G1 确定性 | **通过** | `g1-m3.2-r2.json`：mixed/f64 20 tokens 双跑逐位一致，含 features/reports/selection/layouts/portfolio |
| §4.3 IR | **通过** | `ir-m3.2-r2.json`：47/47 compiled，atomic_instructions 空，ir_sha256 `3ff225ca…` |
| G2 统计等价 | **通过** | `g2-full-m3.2-r2.json`：56/56；min champion_overlap=1.0、min strict_agreement=1.0；CPU/native 合格冠军 14/14；结束时逐文件哈希复核 `source_changed=[]` |
| G3 性能 | **部分**：4 次运行 98-99/100 代 ≤5000ms，max 5175-5870ms（gen1 冷代 + 随机尖峰）；GPU 70.7-72.6%✓、VRAM 47.4%✓、median 1793-1846ms✓ | `g3-mixed-m3.2-100-r2/r3/r4/r5.json`；M2.28 清晨基线 max 4597ms 现时段不可复现（详见下） |
| G4 内存 | **通过** | G3 采样峰值 47.4%<70%；`g4-deep-246k-run3` 相关报告：246k 合成平铺（声明性数据）真实设备 tile 128→80 自动缩批、nvidia-smi 峰值 56.2%、护栏内、真实 eval 完成 |
| G5 稳定性 | **运行中**（产品批准 4 小时口径，见 soak 文档修订） | 短诊断 `g5-soak-diag-6min-r2.json` 通过（双入口、单共享进程、门复核、源码哈希一致）；4h 长跑 `g5-soak-4h-r1.*` 进行中 |
| G6 降级链 | **通过** | m3.2：`m32-fallback-{no-driver,no-card,selfcheck}-{gpu,cpu}.json` 6 项 + `m32-driver.json` 运行中驱动丢失；全部 Native→WebGPU→CPU 正确、origin 重置为旧内核版本、驱动丢失不消耗重启预算 |
| G7 回归 | **通过** | 合并全量 Vitest 451 passed + 1 既有 skip（`vitest-m3.2-merged-r1.log`，单次运行含 golden 225）；原生 suite 135/135（`native-suite-m3.2-r1.log`，799s）；Rust 3/3（`m32-rust.log`） |

## M3 集成验证（m3.2，真实双入口 + 真实 sidecar + IDB）

- `m32-complete.json`：双入口 3 代完成、actual=native-gpu、版本 m3.2、单共享进程。
- `m32-queue.json`：A(lab,mixed) 持进程运行中 B(super) FIFO 排队 0 代；取消 B 不杀
  进程（starts 保持 1）；C(lab,f64) 仅在队列空闲时切换（进程重启恰 1 次，starts=2）。
- `m32-kill.json`：双入口各杀 4 次进程：3 次自动重启（D-1，从最后完整代以 tokens 续跑），
  第 4 次转 paused（`自动重启预算已耗尽`），手动 resume 完成全部 6 代，预算跨恢复保留
  （完成后 nativeRestarts 仍为 3），checkpoint 记录最后完整代数。
- 正向 portfolio IPC：`m32-portfolio-positive.json`——G2 冻结的 ADAUSDT-30m f64 两个
  真实合格冠军作为全种子 1 代种群，final precise 返回非空 GPU 组合（n_factors/
  avg_abs_corr/equal/ic_weighted/best_single/segment/eval_bars 齐备）。
- Rust：native_engine 生命周期/能力/精度 3 测试通过。

## G3 修订与结论（产品决定，2026-09-29 晚）

M2.28 通过时段（清晨）的整机速度在日间不可复现：所有阶段均匀 +10-20%
（rank/strict/enrich 同比例、CPU 负载 3%、AC 供电、GPU 时钟正常），M2.28 的
max 4597ms 在日间对应约 5100-5900ms。m3.2 修复已消除全部 M3 代码引入的每代
成本。剩余超限为 gen1 冷代 JIT 与偶发环境尖峰代。

产品决定：每代绝对时长受硬件状态制约——若无优化空间、达到配置瓶颈即为硬件
问题，不同硬件标准不同，只要无故障能跑起来即可。据此 G3 口径修订为**硬件
相对**：其余条件不变（真实 100 代、GPU≥60%、显存<70%、资格复核），绝对
≤5000ms 保留为安静/高配机器的参考标准并继续如实记录；受硬件制约时以同机
同状态 A/B 无回归为准。

证据 `g3-hardware-relative-amendment-r1.json`：交错 A/B/A/B/A 同机对照
m3.2 vs 冻结 M2.28 引擎，暖调用 precise 382-410ms vs 373-410ms（±3% 噪声内
一致，零代码回归）；E 轮环境尖峰对两引擎同等影响。G3 在修订口径下**通过**，
六次绝对运行数据全部留档（r2-r7，98-99/100 代 ≤5000ms）。

## §8 审查结论（交接文档待核查项）

1. `bars.ts` 混合时间批：确认 `string_columns.time` 的 null 会覆盖服务端重建 ISO；
   已修复为整列 string 才发送 + 边界测试（`bars.test.ts` 3 测试）。冻结输入全为
   string，无现网数据受影响。
2. 收藏 token-only key 跨 origin 冲突：确认存在（同 tokens 两 origin 时"已收藏"
   置灰误判、无法另存另一 origin 版本），属表观问题、无数值污染；修复需改
   `champion-table.tsx`/`selected-factor-panel.tsx`（不在已批准接线表内），按
   "超授权接线先讨论"留待产品决定，未擅改。
3. 单因子回测 Pyodide 路径：`lacksOosInfo` 需 test_metrics 与 overfit_warning 同时
   缺失才触发；合格 native 冠军必带 test_metrics，Pyodide 合并不可能命中 native
   记录，无混口径风险。
4. `launcher.ts` signal 接口：生产调用者仅 process-lease（不传 signal）与内部
   probe（无 signal），无风险残余调用。

## 测试工具与脚本（本轮新增/修改）

- `scripts/native-gpu-soak.ts/.html` + `scripts/verify-native-gpu-g5-soak.py`：
  G5 长跑（逐 cycle 控制器驱动、nvidia-smi 200ms、进程树 RSS+系统内存 5s 采样、
  JSONL 进度、源码 SHA 复核、Python `qualify_candidates` 独立复核冠军门、
  `--minutes` 诊断模式）。
- `scripts/native-gpu-portfolio.ts/.html` + `scripts/verify-native-gpu-portfolio.py` +
  `portfolio-positive-fixture.json`（自 g2-full-m3.1 报告提取，tokens 与版本无关）。
- `scripts/verify-native-gpu-deep-memory.py`：G4 246k 深数据。
- `scripts/native-gpu-m3-runners.ts` 新增 `--mode queue`；控制器暴露
  `nativeTestStats`；适配器补 `window.isTauri = true`（Tauri v2 `isTauri()` 检查该
  全局标志而非 `__TAURI_INTERNALS__`）。
- 修复 `tests/native_engine/test_provenance.py` mock 会话缺 `gpu_buffer_mb` 遍历
  所需属性的问题（M3 `precise_ti` 变更引入、此前从未重跑全量 suite 故漏网）。

## 浏览器命令适配器边界（如实声明）

浏览器验证使用 Python 命令适配器监督真实子进程 + 真实 IPC/工厂/IDB；Rust
spawn/kill/status 由独立 Rust 测试覆盖。二者均不构成"正式安装包测试"——该留待
M4 安装包验收，不得混淆。
