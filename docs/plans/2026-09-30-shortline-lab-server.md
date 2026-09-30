# 方案 A：服务器端 —— 短线因子挂单任务系统

> 2026-09-30 立项。本文档为服务器仓库（`D:\pyobj\Decentralized transactions`，web 前端 + 服务器端）的实现方案。
> §9 契约与桌面方案 `2026-09-30-shortline-lab-desktop.md` 共用，字段不得单方变更。
> （2026-09-30 桌面端 AI 注：本文件由会话转录恢复重建，内容与原稿一致。）

## 0. 任务与边界

在服务器仓库（web 前端 + 服务器端）新增**短线因子挂单任务系统**：接收桌面端挖掘并挂载的短线因子组合，**实时流式打分（3s–60s 可配）→ 滞回决策 → 挂单执行**。

红线：
- 不改动现有任务类型/回测/收藏/历史接口的语义
- 默认**纸面模式（paper）**，真实下单开关独立且默认关闭
- 先测试网/纸面验收，再放开实盘开关（实盘开关由用户人工确认）
- 执行 AI 开工前必须先盘点仓库现状（框架/ORM/鉴权/现有任务系统/交易所对接现状），本方案的模块名与端点是**规范**不是现成代码位置

## 1. 总体架构

```
MarketData 网关（WS aggTrade + kline，按任务订阅）
   ↓ 形成"未收盘K线"（含按已过时间归一的量）
FormulaEvaluator（增量公式求值器，逐冠军打分 ∈ [-1,1]）
   ↓ 组合分 = Σ wᵢ·scoreᵢ(t)（权重来自任务载荷，冻结）
DecisionEngine（滞回/确认/动作频率闸门）
   ↓ 仅产生"意图"（开/平/不动/撤）
OrderManager（限价挂单优先、超时撤补、持仓对账）
RiskGate（名义上限、每小时翻转上限、日亏停机、陈旧分数熔断、总开关）
持久化 + 监控 API（分数环形缓冲 50 步、决策日志、订单日志）
Web 前端：短线任务管理页（创建/监控/控制）
```

## 2. 数据层

- **订阅**：每任务按 symbol 订阅 Binance USDT-M 永续 `aggTrade` 与 `kline` WS；断线重连后用 REST K 线补洞
- **形成中 K 线（forming bar）构造**（与桌面端冻结规格逐字段一致，见契约 §9）：当前周期内的最新价/最高/最低/累计量；**量字段 = 原始累计量 ÷ 已过时间比例**（时间归一，消除未收盘偏差）
- **预热**：任务启动先拉取最近 N 根历史 K 线（N = 任务载荷 `warmup_bars`，覆盖最大滚动窗）构建算子窗口

## 3. FormulaEvaluator（核心，必须与桌面内核逐位一致）

- 实现任务载荷指定的**特征集 + 表达式 VM**（算子码表、栈式求值、滚动窗语义由桌面端提供的**黄金夹具**锁定）
- **黄金夹具（golden fixtures）**：桌面端导出 `{tick 流, forming bar 规格, cadence, 公式集, 期望分数序列}`；服务器求值器对全部夹具**f64 逐位一致**才可上线（验收门 S1）
- 增量计算：滚动类算子维护运行和，O(1) 更新；每 cadence 触发一次全冠军+组合打分
- 版本戳 `shortline-eval-v1` 写进任务状态与日志，求值器语义变化必须升版本并重过夹具

## 4. DecisionEngine（打分节奏 ≠ 交易节奏，硬性）

参数全部来自任务载荷，默认值：
- 阈值 ±0.25；确认步数 K=3（连续 K 步越阈才动作）
- 每小时动作上限 6 次；**每根 K 线最多 1 次仓位变化**
- 分数年龄 > 2×cadence → 熔断不动作（陈旧分数保护）
- 环形缓冲保留最近 50 步分数（历史接口只暴露这 50 步）

## 5. OrderManager

- 挂单优先：限价单挂在盘口内侧 1 tick（maker）；30 秒未成交 → 撤单重挂；|组合分|>0.6 允许吃单兜底
- 仓位对账：每次动作前后校验交易所实际仓位；不一致 → 任务转 paused + 告警
- 订单/决策全量落库（含分数快照、触发规则、订单状态机）

## 6. RiskGate

单任务名义上限、日亏损上限（触发即平仓+paused）、全局 kill switch（管理员一键停所有短线任务）、纸面/实盘模式开关（用户级确认）。

## 7. API（端点规范）

```
POST /api/shortline/tasks          创建（载荷见契约 §9）
GET  /api/shortline/tasks          列表（状态/模式/持仓/累计PnL）
GET  /api/shortline/tasks/:id      详情
POST /api/shortline/tasks/:id/pause|resume|stop
GET  /api/shortline/tasks/:id/scores      最近 50 步分数
GET  /api/shortline/tasks/:id/decisions   决策日志（分页）
WS   /ws/shortline/:id             分数流推送
POST /api/shortline/tasks/:id/mode        纸面↔实盘切换（需二次确认字段）
```

鉴权、限流沿用仓库现有惯例。

## 8. Web 前端

- 短线任务管理页：创建（从挂载的因子组合）、监控（实时分数曲线、最近 50 步、当前持仓、决策流）、控制（暂停/停止/模式切换带确认）
- 管理端：全局 kill switch、任务总览

## 9. 桌面↔服务器契约（两份方案共用，字段不得单方变更）

```json
{
  "task_type": "shortline_factor_v1",
  "symbol": "ETHUSDT", "timeframe": "15m",
  "cadence_seconds": 3,            // 3|5|10|15|30|60
  "warmup_bars": 300,
  "eval_version": "shortline-eval-v1",
  "champions": [
    { "id": 1, "tokens": [ /* 桌面 v3/v4 编码，仅限载荷白名单特征集 */ ],
      "weight": 0.42 }              // 冻结 IC 权重，Σw=1
  ],
  "decision": { "threshold": 0.25, "confirm_steps": 3,
                "max_actions_per_hour": 6, "max_actions_per_bar": 1,
                "stale_multiplier": 2.0 },
  "risk": { "max_notional_usdt": 1000, "daily_loss_limit_usdt": 50,
            "mode": "paper" },
  "fixture_manifest": "sha256:..."  // 桌面端夹具清单哈希，服务器校验
}
```

## 10. 验收门

- **S1**：求值器对桌面黄金夹具 100% f64 逐位一致
- **S2**：纸面模式连续 24h 无孤儿订单/无对账失败，决策日志与分数流可完整回放
- **S3**：风控规则注入测试（翻转超限/日亏/陈旧分数/kill switch）全部正确触发
- **S4**：测试网实盘小额度冒烟（可选，用户确认后）

## 11. 分期

M-S1 求值器+夹具过关 → M-S2 纸面全链路（S2）→ M-S3 真实订单管理（S3+S4）→ M-S4 Web 前端完善
