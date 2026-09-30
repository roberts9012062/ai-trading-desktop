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
