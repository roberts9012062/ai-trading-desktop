# OKX 本机历史取数验收（v0.2.103）

## 结果与范围

桌面端历史回测、因子实验室和超级因子的 OKX 渠道改为本机获取官方 ZIP；短线实验室新任务默认选择 OKX 官方归档，也可选原 Binance 归档。服务器实时行情、账户查询、实盘任务和下单接口不变，无服务器代码或容器更新。

取数链路没有交易后台历史接口的失败回退。生产请求由桌面已有 Tauri 原生 HTTP 发送，不需要 OKX API Key，也不传应用登录令牌。浏览器开发预览的代理运行在同一台电脑，仅用于跨域测试。

## 数据正确性与缓存

- 数据文件取自 static.okx.com 的官方 DNS CNAME dfccd2aelcoyz.cloudfront.net；该别名本机实测可达，保留官方静态域重试。未引入第三方镜像。
- K线日/月文件为 1 分钟，重采样时要求整个周期有连续、已关闭的分钟，跨文件保留未完成周期。截止时间后的价格不进入结果。文件日期按北京时间，内部 epoch ms 不做重复时区偏移。
- OKX USDT 合约逐笔 size 为张数。用同日 K线 vol_ccy/vol 校验面值，再转换为币量；buy/sell 对应主动买/卖。空字段、品种错位、重复成交、时间回退或日期错位拒绝使用。
- ZIP 缓存独立 store（数据库 v7，旧 store 保留），SHA256 校验，256MiB 文件缓存预算；逐笔 Worker 聚合为一秒 digest 后存本机，和原 Binance 键分开，累计摘要预算 3GiB。按日恢复，重复启动只补缺日。
- 缺失文件不假装成功；摘要写入等待事务提交，下载/解析可中止；不完整逐笔区间阻止启动挖掘。建议挖掘天数按已有本机内存护栏调整（上限180天）。
- 资金费率读取官方 monthly/swaprates 归档，按已结算事件因果合并。未发布/覆盖不到的数据为 null；复核加入本地已有的结算现金流，报告仍声明未独立封存验证和资金费可能不完整。
- 原冻结挖掘快照、旧 Binance digest、实时交易任务未迁移。收藏备注、黄金夹具及复核指纹记录数据源。

## 验证证据

2026-09-28 BTC-USDT-SWAP 官方日文件本机直接下载：

- candles ZIP：43,058 bytes，SHA256 `93368fa8b7a5f882f6adf86e5365ad496b3088454e4978ed9c3bca771cd5a69a`。
- trades ZIP：17,599,557 bytes，SHA256 `cc4e7d658a5234dacb3c5b87b7394686689fbf4ef6eb9eadeea82ba342815093`。
- 合约面值 0.01；聚合78,692个秒桶，digest SHA256 `ba6771269b5efbfbeeefd2b711beebdb724aab51d6c9c8f1e797b21ee607be97`。
- 整天1,440分钟逐一比较：OHLC相等，基础量精度1e-6、金额精度1e-3以内一致。数据文件只保存在忽略目录 .local-data，不提交仓库。
- Edge 隔离验收：真实官方下载→Worker聚合→IndexedDB读取通过；数据源切换显示不同缓存天数；OKX和旧Binance执行复核、报告参数变动失效、移动窄屏通过。隔离页面拦截所有交易接口。
- `pnpm exec vitest run`：80套、685项通过，1项GPU环境跳过。首轮旧Binance在线测试超时，单独重跑及最终全套均正常。
- `pnpm typecheck`、`pnpm build`：通过；生产构建含两个Worker文件。保留原有构建的分包体积提示。

首次较长区间需要下载文件，之后走本机缓存。归档存在发布延迟，界面研究截至日默认当前北京时间前两天；具体币种上市晚或文件尚未发布时会提示调整区间。当前月资金费率可能到下月才可获得，本机网络不可达时会明确报错。

官方资料：[历史数据页面](https://www.okx.com/historical-data)，[OKX 官方 PublicData SDK](https://github.com/okxapi/python-okx/blob/master/okx/PublicData.py)。文件路径另以实际下载和整天对照验证。
