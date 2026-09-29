# 给接手 AI 的提示词

请接手并继续完成 AI Trading Desktop 的 Native GPU Engine。你的任务是继续实现和验收，直到 G1–G7 全部通过并发正式版本；不要从头另起实现，也不要把已有代码或阶段报告误当作最终验收。

**先完整阅读：**

1. 实现工作目录：`C:/Users/bbsx1/.codex/worktrees/native-gpu-engine/AI Trading Desktop`。
2. 唯一原设计：该目录下 `docs/native-gpu-engine-plan.md`，完整218行。
3. 详细交接：`docs/plans/2026-09-29-native-gpu-handoff.md`，尤其§3授权、§6证据、§7待办、§8已知草稿问题。
4. 已批准补充：同目录中的 VM layout proposal、champion qualification proposal、M3 wiring scope、portfolio boundaries。

**当前状态：**

- 分支`codex/native-gpu-engine`，HEAD`ea26018`；M1`2ae7e33`、M2`ea26018`已完成提交；M3大量未提交文件必须保留并继续，M4尚未开始。
- 原生VERSION`native-gpu-v1-m3.1`；工作树已有app版本0.2.43，这是基线，不是本任务release。
- m3.1 G1、完整56/56 G2、47/47无atomic IR、真实core complete/pause/dispose和180CPU权威对照已通过。
- M2.28真实3000×100 G3 max4.5971s、GPU76.394%、VRAM41.345%已过；**当前m3.1仍需复测G3**。
- M3全量Vitest225passed+1既有skip、新golden225单独passed、Rust3passed；它们不是最终组合全量结果。
- 真实双runner杀进程/G6脚本已写未跑；8小时未开始；G4深数据未实测；打包/签名/更新/发布未开始。
- soak.ts是未验证草稿，版本字段比较和LocalMiningRunner初始化时机有确定问题，Python控制器尚未写。先处理交接§8。
- 最近真实core已正常结束，没有本轮GPU测试占卡。旧preview还可能运行，下一新build使用4210，然后端口递增。

**硬约束与产品已批准口径：**

1. 只改桌面端，禁止碰`D:/pyobj/Decentralized transactions`服务器仓库。
2. 严格M1→M4，M3 G5/G6出口未通过不可进入M4。实现只按原设计和明确授权补充；再改设计先提出讨论。
3. 原CPU/WebGPU/shard-pool/CPU Python/旧对拍逻辑不改；device-profile100k/200k/300k护栏不变。已有70k稳定/246k旧OOM事实无需重验。
4. mixed允许GPUf32粗排+GPUf64权威；每指令候选×时间块VM布局已批准；同机同卡同版逐位确定、禁止atomic/ti.random、固定窗口顺序、启动20tokens双跑拒绝失败。
5. **性能每代≤5秒**，真实ETH15m永续70174、3000×100、持续GPU≥60%不变；composite真相对差<1e-9、strict≥99.9%、合格冠军集合≥99%不变。
6. 冠军按已有严格筛和任务配置，缺失/失败OOS/WF/封存证据不发布，可为0；DSR/PBO等不擅加阈值。两层G2已批准：raw数值对拍+相同合格门后冠军对拍。封存不参加进化/补选/重排。
7. M3最小原生专属接线范围已经批准，不重复问许可；原生组合权重只用冻结训练，指标用冻结封存，无封存用测试。
8. 启动/明确驱动不可用→WebGPU→CPU；运行普通进程丢失D-1自动重试≤3，第四次paused，预算跨resume保留；运行确认驱动丢失直接降级；origin分数不混，仅tokens可携带重算。
9. IDB测试四行4→5已授权且在M2提交；不要扩改旧逻辑。

**接下来执行顺序：**

先检查dirty状态和草稿，补完整验证工具与测试；串行实跑真实两入口完成/共享队列/暂停恢复、第四次kill暂停及手动续跑、缺驱动/无卡/G1失败的WebGPU和CPU链、运行驱动丢失；复测当前G3和G4及正向GPUportfolio IPC；完成真实8小时G5。M3出口全部通过后提交M3，再做默认内置runtime、CI冻结/hash、Windows签名、VERSION/更新器、安装包测试和最终G1–G7，最后功能commit→version bump→release commit→push→v*tag→验证CI正式产物。

默认Python3.10有Playwright；`.local-data/native-engine-venv/Scripts/python.exe`是3.11/Taichi，没装Playwright。浏览器监督脚本用默认python，数值脚本用venv。不要并行启动重GPU测试来污染性能/显存数据。

证据/冻结数据位于该worktree的`.local-data/`，多数不进Git；详细命令、路径、报告解释和保护检查已列在交接文档。所有长任务要保留进度、GPU/内存采样、版本与源码SHA；数值源码/VERSION改变后重新验证G1/G2/G3。浏览器Python命令适配器不是实际Tauri安装包测试，不能混淆。

开始后先用中文简要说明你接手的是哪些已完成内容、将先处理哪三个待办，然后继续行动。只在真正新增设计决策/必要信息缺失时问我，不要重复询问已授权事项。报告必须区分“实现已写”“测试通过”“验收门通过”，不得把未跑脚本、短跑或旧版本报告算作完成。
