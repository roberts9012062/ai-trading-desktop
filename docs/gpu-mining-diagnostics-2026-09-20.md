# 本地因子挖掘 GPU 排查与修复

日期：2026-09-20。范围：桌面项目本地 WebGPU 路径，未改服务端、交易接口或指标公式。

## 结论

发现并修复真实 WGSL 编译失败、存储访问竞争、批次串行读回、训练输入重复准备、
显存过量分配及释放不完整、长跑缓存淘汰导致分数丢失等问题。

持续 GPU 粗排压力测试达到目标：32 次硬件采样平均 **92.1875%**，范围 **84%～96%**。
这不是完整业务任务全程利用率：小种群、缓存命中及 f64 精算会降低任务平均 GPU 使用率。
没有更改种群规模、精算漏斗、严格筛选、walk-forward、成本或最终冠军指标公式来提高利用率。

## 环境核验

| 项目 | 实测 |
|---|---|
| GPU | NVIDIA GeForce RTX 5060 Ti，16311 MiB，WDDM |
| 驱动 | 610.88；nvidia-smi 显示 CUDA UMD 13.3 |
| 本机 Toolkit | nvcc 12.8.61 |
| Python / PyTorch | Python 3.14.3；torch 2.13.0+cu130 |
| PyTorch 运行时 | CUDA 13.0；cuDNN 92000；包含 sm_120 |
| CUDA 功能验证 | is_available=True，1024×1024 GPU 矩阵乘法及有限值检查通过 |
| TensorFlow | 当前 Python 环境未安装；项目不依赖 |
| 实际项目计算框架 | WebGPU/WGSL f32 粗排 + Pyodide 0.26.4 / NumPy f64 精算 |
| 真机浏览器 | Chrome 153.0.0.0；adapter vendor=nvidia，architecture=blackwell |
| WebGPU 限制 | storage binding=2147483644 B；maxBufferSize=2147483648 B |

Toolkit、驱动支持版本及 PyTorch 自带运行时版本不同不等同于不兼容，本机功能测试正常。
项目没有调用 PyTorch/TensorFlow，也没有 CUDA sidecar；因此未安装/升级驱动或框架。
本次真实 GPU 测试运行于 Chrome 开发页面，不等同于安装包内 WebView2 的验收。

## 根因与修复

| 问题 | 证据及修复 |
|---|---|
| P0：着色器根本没有编译成功 | 原 WGSL 第 264 行 `ptr<function, Acc, read_write>` 报 `only pointers in <storage> address space may specify an access mode`。改为合法函数指针；增加 getCompilationInfo、异步 pipeline 创建、validation/out-of-memory 错误作用域。失败立即报错，不再接纳无效读回。 |
| 存储同步错误 | `workgroupBarrier` 不负责 storage 内存可见性，特征写入与后续窗口读取也缺少同步。添加 `storageBarrier`。 |
| 滚动双目算子覆盖输入 | CORR/BETA/RESID 原地写回，其他线程和后续 t 会读到覆盖后的窗口。改为临时层计算、同步后回拷。 |
| 无条件越界读取 | WGSL `select` 不是短路分支，lag/delta 和 sortino 起点会计算负索引。改为显式条件分支；回归分母使用可表达的 f32 常数。 |
| 指标阶段线程浪费 | 原每组 1 个线程。改为每组 64 个线程，每线程一个候选，保留每条序列的 Kahan/时间累加顺序。 |
| 每 tile 等待 mapAsync | 双 staging 环形缓冲，最多两个在途读回；仅复用槽位时等待，取消/异常退出等待未完成读回。WebGPU 只有一个队列，不声称实现 CUDA 多流。 |
| 无效大批上传/显存分配 | 原按设备绑定上限的 85% 分配，与真实种群无关，且每次上传整个 tile。现在按种群、序列长度、设备限制与默认 256 MiB 批缓冲预算规划，只上传实际 token 数。WebGPU 不暴露可用 VRAM，未假装按空闲显存精确自适应。 |
| 缓冲释放不全 | 原 dispose 仅释放 params/tokens/metrics/staging，其他缓冲等待 device.destroy。现登记并释放全部缓冲，初始化失败也释放。 |
| 代间串行等待 | 进化只依赖粗排，不依赖冠军精算；在当前代精算期间预取下一代粗排，最多提前一代。生成器关闭时等待预取结束再释放设备。 |
| CPU 数据准备重复 | 原每代传全部 bars，并在 Pyodide 重建训练特征。以唯一会话 ID 缓存冻结 bars/切分/训练矩阵/close/periods；后续传空 bars。缺失或配置不匹配直接失败，finally 显式清理，会话最多 8 个。 |
| 长跑缓存淘汰丢分 | putBatch 清空缓存后才读取当前代已命中分数，可能产生 undefined/NaN。现在先合并本代分数，再写入可能触发淘汰的缓存。 |
| 统计误导 | UI 原称整个种群为 GPU 计算量。现在展示唯一 GPU 实算数、缓存命中、提交及读回墙钟时间、f64 精算耗时；不把这些值称为硬件利用率。 |

核心文件：`src/lib/mining/gpu/eval-gpu.ts`、`wgsl/eval-vm.wgsl.ts`、
`src/lib/mining/backends/gpu-backend.ts`、`public/pykernel/factor_local.py`。

## 实测结果

### 持续计算压力

合成输入，使用真实 GP 候选和生产 WGSL 内核；直接批量求值，故意不经过跨代缓存，
用来检验 GPU 计算能力，不代表真实挖掘吞吐。每轮与首轮全部指标逐项比较。

- 2026-09-20 15:38:53.693～15:39:24.162（UTC+8），预热后计算 30044.9ms。
- T=8192，F=8，population=8192，tile=818，缓冲总计 268536776 B。
- 375 轮，3072000 次候选求值，**102246.97 次/秒**；重复输出完全一致。
- nvidia-smi 采样窗口 15:39:00.260～15:39:20.514，32 次，实际间隔约 0.65 秒。
- 利用率：平均 92.1875%，最低 84%，最高 96%；功耗 106.83～109.61W，
  温度 54～60°C；系统 GPU 总显存 1030～1032 MiB（包含其他进程）。
- 7.5 万根长序列：population=512、tile=89、24 轮/5029.2ms，
  2443.33 次/秒，重复输出一致、无设备丢失。

32 次原始 utilization.gpu (%)：

```text
96,95,92,89,94,91,95,94,88,93,91,91,92,89,95,96,
91,96,88,91,94,91,84,91,94,89,96,91,94,95,94,90
```

### 性能对照

T=4096、population=4096，相同已修复内核，按单/双/双/单顺序各测约 4 秒：

| 读回深度 | 求值/秒 |
|---|---:|
| 1 | 175090.87 |
| 2 | 215401.64 |
| 2 | 212710.16 |
| 1 | 170398.82 |

双读回平均较单读回约 **+24%**。这是读回优化的同内核对照，不是原错误着色器的加速比。

Pyodide 精算对照：1 万根合成 K 线、6 个固定公式，相同 worker 顺序无缓存/缓存/缓存/无缓存。
耗时为 2711 / 61.6 / 51.5 / 204.2ms，四次结果 JSON 完全相等、均 1 个冠军。
首轮包含冷启动成本，不能用其计算缓存加速比；预热无缓存约 204ms，缓存约 52～62ms。

完整生产后端冒烟：600 根合成 K 线、512 候选、3 代、seed=42，
总计 1877ms（worker 已预热），每代均 3 个冠军。GPU 提交及读回 7/6/2ms，
精算 672/306/572ms。说明该小负载仍主要受 f64 精算限制，不能宣称全程 80%。

### 准确性与回归

- 真 GPU 对 Pyodide：500 随机候选、40 特征，CPU 合法且非常数候选 410 个；
  复合分按 1e-6 合并近并列后 Spearman=**0.9801664986**，CPU top-10
  在 GPU top-30 内召回 **10/10**，连续两次 GPU 全指标完全一致。
- f32 粗排仅决定候选名单；最终所有冠军数字仍来自原始 f64 内核。
- 会话缓存对原无状态路径：3 种训练/测试切分×3 代，champions/best_seen 逐项相等；
  交错会话隔离、缺失/重复/配置不符、禁止替换冻结 bars、清理幂等均通过。
- `npm run typecheck` 通过；`npm test` 119 通过、1 跳过。跳过的是 Node 无 WebGPU
  的旧门控用例；本次通过诊断脚本单独运行真 GPU 对拍，不将 mock 当作真机测试。
- `verify-gpu-session.py` 3 项、`verify-local-features.py` 11 项、
  `verify-mine-stepwise.py` 3 组、`verify-kernel-tests.py` 5 项通过。
- `npm run build` 通过；保留现有 chunk 大小与静态/动态混用警告。

## 复现

启动 `npm run dev -- --host 127.0.0.1`，在开发页面控制台运行（不写任务或交易状态）：

```javascript
const d = await import("/scripts/gpu-diagnostics.ts");
await d.runGpuParity();
await d.runMiningSmoke();
// 异步启动，确保另一个终端能在计算期间采样。
d.runGpuStress({ T: 8192, population: 8192, durationMs: 30000 })
  .then(result => console.log(JSON.stringify(result)));
```

另一终端同时运行，完成后 Ctrl+C 停止采样：

```powershell
nvidia-smi --query-gpu=timestamp,utilization.gpu,utilization.memory,memory.used,power.draw,temperature.gpu --format=csv -lms 500
```

`readbackDepth: 1` 与 `2` 可做流水线对照；`T: 75000, population: 512` 可测长序列。
准确性返回 `passed: false` 或任何 WebGPU 错误时，不应使用吞吐结果作为验收。

## 验收边界

- 本次没有用户指定的真实品种冻结快照，因此实机性能与对拍使用固定种子合成数据。
  尚未完成真实多品种、跨品种验证开启、数小时运行及安装包 WebView2 的验收。
- f32 秩相关刚过 0.98 门槛，不能外推所有品种；上线前需扩充真实快照、多随机种子测试。
- 未将精算/WF/最终指标改成 f32 全 GPU：这会违反同源 f64 指标约束。
  多队列 CUDA 流在当前 WebGPU API 不可用，已采用双读回和 CPU/GPU 重叠执行。
- 没有可用空闲显存查询，也没有 GPU timestamp-query/逐 kernel profiler 数据；
  硬件采样为整卡利用率，应用阶段耗时为墙钟，均不等于 SM occupancy。
- 修复前计算本身无效，无法给出可信的端到端“修复前/后”加速比。
  README 旧性能记录已标注作废，不继续引用旧的百万级长序列吞吐。
- 已有任务若曾在错误 GPU 粗排下生成，应重新挖掘；仅恢复历史种子不等于重建正确搜索轨迹。
