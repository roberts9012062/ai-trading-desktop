# Lium Crypto Market Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用户填写自己的接口中心 Key 后，桌面在线 OKX USDT 永续行情统一使用接口中心，并发布 patch 更新。

**Architecture:** 保留业务 JWT 与私有交易线路。公共行情采用独立 Key、一次性票据、共享订阅与字段转换。报价能力扩展可选深度快照；实时 K 线与 Tick 查询使用原有能力授权，避免新增未授权的旁路。

**Tech Stack:** FastAPI/Pydantic、Go gateway、React/Zustand、Tauri/Rust、pytest/Vitest。

## Task 1 — 接口中心公开协议
- Test: adapter/tests/test_crypto_desktop.py；先验证 candle 量纲/confirm、成交 ID/side、盘口白名单、操作与参数权限。
- Modify: market/types.py、public/{schemas,presentation,symbols}.py、providers/{contract,okx}.py、providers/okx_socket/public.py。
- Implement: quotes 的可选 depth（仅 crypto 单合约 quotes/stream_quotes），ticks 最近成交，原生 candle stream；历史使用最新 candles 和历史 history-candles。
- Run: .venv/Scripts/python.exe -m pytest adapter/tests/test_crypto_desktop.py（从 adapter 工作目录设置对应解释器）。

## Task 2 — 原生凭据与票据客户端
- Create: src/lib/collection-{config,api,stream}.ts 与对应 tests；src-tauri/src/market_data.rs。
- Test before implementation: 域名白名单、Key 隔离、游标与秒/毫秒、成交去重、过期票据重签、原生加密存储。
- HTTP 使用原生通道；Key 按业务服务器及用户隔离，Windows DPAPI 加密保存；浏览器调试只用会话内 Key。

## Task 3 — 桌面入口与路由
- Create: src/components/profile/data-config-panel.tsx，复用现有个人中心视觉。
- Modify: profile/page.tsx、api.ts、market store、okx-forming、realtime-factor/market；配置后公共行情不回退旧代理。
- 共享行情连接与主动释放；保留通知/任务订单等业务 WS。
- Run: pnpm exec vitest run 相关 tests；pnpm typecheck；pnpm build；cargo test 新模块。

## Task 4 — 线上部署与集成验收
- 修改接口中心公开文档，精确加入桌面 WS 来源。
- 先本地测试再用用户提供 SSH 身份部署接口中心，保留服务器私有配置。
- 使用测试 Key 验证 BTC/ETH/不同精度合约：历史翻页、7周期、当前 candle、盘口、最近成交及成交流、45秒续签与无权限。
- 研究历史保持独立接口和现有行为，不自动添加研究授权。

## Task 5 — 发布
- 更新已批准分析文档的实施状态并记录验证结果。
- 从最新已发布版本增加 patch，提交并推送两仓库所需更新。
- 推送桌面 v* 标签，跟踪 release.yml，核验安装包、签名、Release 与更新清单。
