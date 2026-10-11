# v0.2.177：SOL 历史归档修复走 Snippets

v0.2.176 的数据交叉校验能识别和修复 SOL 2024-04 的错误成交量，但新增 API 请求直接访问 `www.okx.com` / `app.okx.com`，漏接桌面端现有 Snippets 代理。因此用户在本机仍然遇到连接失败。

本次把校验请求接到 `refreshSnippetPool` / `snippetPublicGet`，使用当前分配的 REST 节点及现有成功、失败、限流上报机制。历史行情不回退到业务服务器 K 线接口，也不再尝试官方 API 域名。公共请求不携带产品 token、交易所签名或 Cookie。产品 token 仅用于现有线路分配接口。

实测还发现已部署 Snippets 的 `history-candles` 白名单只允许每页最多 100 根：原来的 `limit=300` 返回 `invalid_market_query`，改成 100 返回 OKX `code=0`、完整 100 根。因此同步调整分页，并保留严格的 OHLC、合约数量、成交额和成交量换算校验。修复 ZIP 的元数据记录 `transport=snippets` 和实际使用的代理 origin，进度和错误提示也显示 Snippets。

共享公共请求函数新增可选取消信号，与超时信号合并；用户主动取消不会将健康节点上报为故障。已有两参数调用保持兼容。

验证包括：

- 使用真实异常行，经生产修复函数访问已部署的 `okx-rest-test.kins.eu.org`，成功恢复 2253.3、911.6、1585.7 SOL 三根成交量。此项是实际在线代理请求；命令行诊断使用本会话配置的 HTTP 传输代理，没有更改应用配置。
- 重放独立采集的全月真实 API 数据，按代理的 100 根上限分页，完成 43,200 根分钟线的修复和 30 根日线聚合。此项验证全月修复及分页逻辑，未把它表述为全月在线代理压测。
- 回归覆盖分配节点、产品 token 隔离、代理失败不直连官方域名、取消、旧缓存修复、缺口和数据冲突；同时运行已有 Snippets 冷却/线路池、桌面路由、OKX/Binance 历史及逐笔数据对照测试。
- TypeScript 类型检查及 Vite 生产构建通过。

精简证据：[2026-10-11-sol-snippets-repair.json](experiments/2026-10-11-sol-snippets-repair.json)。只有桌面端代码变更，服务器业务代码和 Snippets 部署文件均未修改。
