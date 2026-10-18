# 加密货币行情接入分析与待实施清单

日期：2026-10-18。本文件保留实施前的分析基线；实施结果见 [v0.2.201 说明](releases/v0.2.201.md)。

## 1. 已确认范围

- 桌面端：`D:\pyobj\AI Trading Desktop`，当前本地与 GitHub 最新 Release 均为 `v0.2.200`。
- 接口中心：`D:\pyobj\API Collection`，用户入口为 https://lium.eu.org ，文档为 https://lium.eu.org/#docs 。
- 按用户本轮补充，只接入加密货币，不添加股票、期货、基金或外汇市场。
- 目标：个人中心新增“数据配置”，用户到接口中心获取自己的 API Key，填写后即可使用其套餐允许的行情。
- 本轮先列出清单。未修改业务代码，未调整服务器配置，未上传仓库或触发打包。
- “成交单”在本清单中指公共市场成交明细。账户自己的成交、委托、余额与实际下单仍属于交易接口，需要独立的交易所凭证和授权。
- 实时行情当前可接入范围为 OKX USDT 永续。研究接口的 Binance/Gate 数据集不等于已具备这些交易所的在线 WS 行情。

## 2. 已完成的在线验证

使用用户提供的测试 Key，仅进行行情查询与短时 WS 验证。Key 未写入本文件或业务源码。下表是本次验证结果，不代表全部币种、网络、长连接续签及所有周期均已验收。

| 检查 | 结果 | 对接含义 |
| --- | --- | --- |
| GET `/v1/my/permissions` | HTTP 200 | 测试 Key 有效；120 RPM，最多 5 个同时数据请求/连接，加密货币订阅额度 200 |
| GET `/v1/capabilities` | HTTP 200 | 市场能力总览可用，但最终要检查具体合约能力 |
| GET `/v1/symbol-capabilities`，BTC-USDT-SWAP | HTTP 200 | history、quotes、stream_quotes、stream_ticks 当前可用；ticks、stream_bars 不支持 |
| POST `/api/tickets` → GET 票据 URL，history | HTTP 200，实际返回 3 根 BTC 一分钟 OHLCV | 签票与数据网关链路可用 |
| history 携带更早 `end` 再查询 | HTTP 200，返回的 3 根均早于上一页 | 小样本历史游标推进通过；完整范围、极限页数仍需验收 |
| POST `/api/tickets` → GET 票据 URL，quotes | HTTP 200 | 可取得最新价、买一、卖一、上游时间；此次未提供 24 小时统计 |
| 一条批量 `stream_quotes` WS，BTC + ETH | 两个合约均收到实际报价 | 列表可批量订阅，不能每行建立一个连接 |
| 单合约 `stream_ticks` WS | 收到多帧真实成交事件 | 有时间、价格、数量，但公开结构缺成交 ID、方向和数量单位 |
| 签发 crypto `ticks` / `stream_bars` | 均 HTTP 400 `not_supported` | 不是桌面转换字段即可解决，接口中心需要补能力 |
| 带 `http://tauri.localhost` 的 WS 握手 | HTTP 403 | 接口中心当前来源限制拒绝桌面 WS |
| http/https tauri.localhost 与 localhost:5173 的 HTTP 预检 | 均 HTTP 403 | 浏览器直接跨域受限；已打包桌面端已有 Tauri 原生 HTTP fetch 通道可复用 |
| GET `/v1/research/channels` | HTTP 200，所有渠道 entitled=false | 研究数据独立授权，测试 Key 当前未开通；未执行研究归档下载验证 |

协议要点：长期 Key 用 `X-API-Key` 请求头；票据 30 秒有效且只能消费一次；行情流最长 45 秒，续接必须重新签票。批量报价请求只接受其专用字段，不能直接复制单证券请求中的 `count/resolution` 等参数。

## 3. 必须适配的接口清单

以下“拟新增/扩展”是建议契约，不是当前已经存在的接口。

| 编号 | 功能 | 当前接口/能力 | 桌面端改造 | 接口中心改造 |
| --- | --- | --- | --- | --- |
| A01 | Key 校验、套餐与到期状态 | GET `/v1/my/permissions` | 保存前检测；展示市场、能力、到期、RPM、连接及订阅额度 | 保持现有接口；盘口等新能力要进入套餐授权体系 |
| A02 | 合约列表、搜索 | GET `/v1/symbols?market_type=crypto&exchange=okx`，支持 limit/offset | 处理分页与目录降级；统一 btcusdt ↔ BTC-USDT-SWAP；避免以另一交易所行情填充 | 拟扩展合约规格元数据，提供价格步长、数量步长、最小量、合约面值及单位；现有公开列表没有这些字段 |
| A03 | 按合约探测能力与周期 | GET `/v1/capabilities`、`/v1/symbol-capabilities` | 禁用不支持/未授权项目，明确错误原因 | 补能力后同步能力发现结果，避免“宣称支持但实际取不到” |
| A04 | 历史 K 线与左侧翻页 | `history`；GET `/v1/history` 为 307 快捷入口，建议统一使用 POST `/api/tickets` 后兑换 | records → bars；end_time → Unix 秒；按 timestamp 排序去重；按实际范围处理分页 | 保留现有 history；扩展公开 K 线的币量、张数、成交额、收盘确认及口径字段；不能把缺失字段填成有效零 |
| A05 | 实时 K 线、当前未收盘 bar | 当前 crypto `stream_bars` 不支持 | 统一形成中 K 线来源；同开盘时间更新、下一时间追加；处理乱序、断线补历史与跨周期 | 接入 OKX business WS candle 频道，开放 stream_bars；不能把 quote 采样的 OHLCV 冒充交易所原始 K 线 |
| A06 | 报价快照、首屏价格 | `quotes` → quotes[] | 映射 price/bid/ask/timestamp；未知统计保留未知 | 补充可获得的 open24h/high24h/low24h/vol24h/volCcy24h、买卖一数量，统一 HTTP 与 WS 的统计含义 |
| A07 | 列表/自选实时报价 | `stream_quotes`；symbols 数组最多 100 个 | 按可见窗口和自选列表订阅、共享连接、节流更新；切换窗口先释放旧连接；续签 | 现有批量接口可复用；保留每证券错误隔离、额度检查与最新报价合并 |
| A08 | 实时盘口 | 现有报价只有买一卖一价格；无公开多档深度能力 | 映射 bids/asks、档位数量、时间、单位和过期状态 | 拟新增深度快照与 stream_orderbook 能力，优先接 books5 快照；如提供增量深度，必须处理序列与重建；接入签票、授权、限额、能力发现与文档 |
| A09 | 市场成交明细 | `stream_ticks` → trade_updates_possible_gaps | 映射价格、数量、时间；用真实成交 ID 去重；保留同毫秒多笔成交；方向用于买卖颜色和筛选 | 保留并公开 trade_id、side、原始数量、单位及可确认的标准化数量；目前 side 在上游解析模型中也未保留，tradeId 未进入公共 Tick |
| A10 | Tick 初始快照、断线补点 | crypto HTTP `ticks` 不支持 | 初始窗口 + WS 增量；明确可回补范围和缺口，禁止假装完整逐笔历史 | 拟接交易所公共最近成交查询；如需要更长回补，再增加有界历史查询或短期缓存；不得承诺完整成交带 |
| A11 | Tick 图与分时图 | 桌面 period=tick 当前实际调用分钟分时实现 | 保留分时语义；真正 Tick 图若纳入首版，应独立用真实逐笔源，不能继续把分钟点称为逐笔 | 依赖 A09/A10，不应拿报价更新当成交 |
| A12 | 历史量价、盘口和成交衍生显示 | 大单、成交量分布、AI 页面等依赖已有接口 | 梳理使用公共行情的消费者；更换数据后不能继续读取另一来源的公共成交统计 | 若要保留跨天成交查询与服务端累计，需定义留存范围及按用户 Key 授权的查询；实时 WS 本身不能替代旧历史数据库 |
| A13 | 所有实时消费者共用接入 | 图表、行情页、交易页、看盘页、本机秒级因子/策略等 | 收敛到一个公共行情适配层；取消旧请求，隔离账号/Key/来源缓存，防旧连接回写 | 评估多频道复用以降低连接消耗，保留公共与私有数据边界 |
| A14 | 研究/回测长期 K 线（独立项） | GET `/v1/research/channels`、POST `/api/research/tickets` → `/edge/research` | 若纳入统一接入，单独处理 archive、before_ms、next_before_ms、资金费率和冻结快照；不能套用普通 history | 需要开通研究渠道；当前测试 Key 无此权限；OKX 研究契约也未提供逐笔归档，不能直接覆盖桌面已有逐笔研究下载 |

在线首版应完成 A01–A13 涉及的现有行情功能；A11 真正逐笔图属于与现有分时图区分的产品项。A14 作为独立研究迁移项，本轮不默认变更研究渠道授权或下载行为，实施前明确是否纳入同次版本。

桌面现有七个 K 线周期均应适配：`1m/5m/15m/30m/60m/240m/1d` → `1/5/15/30/60/240/1D`。现有 `tick` 不是接口的 K 线 resolution。周线、月线不属于当前桌面周期，不因接口市场总览出现就直接开放。

## 4. 不能只换 URL 的原因

1. **协议不同。** 当前桌面使用业务 JWT、`/api/market/*` 和直接 OKX 代理；接口中心使用用户 Key、票据和独立数据网关，WS 消息也不是现有 `type/data` 格式。
2. **行情单位不同。** 接口中心 OKX history 读取原始 candle 第 5 位数量（合约张数），桌面现有解码使用第 6 位基础币量，并保留第 7 位成交额；成交 WS 当前返回原始 sz。应同时提供 contract_volume、base_volume、quote_volume 及单位，在上游确认时转换；资料不足则保留 null。禁止无依据使用固定乘数，也禁止把张数直接当币数。
3. **时间与状态字段不同。** 接口中心 timestamp 为 Unix 秒；研究 time_ms 为毫秒；桌面大量路径仍使用北京时间字符串。需要以绝对时间为内部主键，在显示层转换；日线保持交易所实际边界。现有公开 K 线丢失 confirm，不能推断为已收盘。
4. **现有降级会绕回旧源。** snippet-rest、desktop-routing、市场 store 均有自动回退。配置并启用接口中心后，Key 无效、未授权或限流应明确提示，不能悄悄回到旧行情掩盖失败。
5. **行情 WS 和业务 WS 混合。** `/ws/market` 还承载通知、任务订单等。应关闭其中重复公共行情订阅，保留原有业务事件，不能直接关闭整条业务 WS。
6. **后台任务不会跟随客户端自动换源。** 本机秒级任务读取的最新 K 线需要适配；服务端托管任务有独立数据运行环境。若要求它们同样使用每位用户的行情 Key，需要另行定义凭证托管和服务端授权，不能由客户端改地址隐式完成。

## 5. 个人中心“数据配置”建议

- 固定服务名称及默认地址 `https://lium.eu.org`，用户只需填写 API Key。
- 提供“获取 Key”“接口文档”链接，以及检测、保存、替换、清除操作。
- 显示连接状态、套餐到期、允许能力、当前合约、最后行情时间和限额；Key 输入框遮盖，保存后仅显示脱敏信息。
- Key 与桌面登录 JWT、交易所 API Key 分开管理；优先采用 Windows 系统凭据保护，原生侧持有并发起签票，不将明文 Key 写入源码、普通日志或安装包。
- 改 Key/切账号后取消旧请求、释放旧订阅并使行情缓存失效，防止旧响应回写；同交易所历史缓存也必须经当前权限验证后使用。
- 启用接口中心后，未配置 Key 时给出配置入口；鉴权/权限错误停止无意义重试；网络故障退避续签；不伪造行情。

## 6. 连接、部署与实现方案

**建议方案：接口中心补齐公开行情协议，桌面端统一接入。** 用户仍只填一个 Key；行情来源、额度和文档统一。相比之下，“只改桌面映射”无法提供缺失的盘口/方向/K 线流；“改用 HTTP 高频轮询”会消耗 RPM，且不能替代真实成交流，均不适合作为完整方案。

- HTTP：复用桌面 `src/desktop-boot.ts` 中 Tauri plugin-http 的原生通道。现有 Rust realtime_http 仅允许秒级任务专用路径，不可直接拿它调用任意接口。
- WS：服务端当前明确校验 Origin。需要精确放行实际桌面来源；开发浏览器来源也需按需配置。另一种方式是原生 WS 桥接，但现有项目未提供该通道。
- 单合约基本连接预算：批量报价 1 条 + K 线 1 条 + 盘口 1 条 + 成交 1 条 = 4 条；HTTP 查询会短时占连接额度。测试 Key 最多 5 条，多分屏、多币种不可无限开流。
- 按用户额度调度订阅、引用计数、取消不可见页面、控制历史预取，优先考虑选中合约多频道共享同一 WS；若扩展票据协议，需同步授权与配额测试。
- 单 WS 批量报价最多 100 个，200 个报价合约需要两批；同一合约多能力虽共用一个订阅合约名额，各连接仍分别占连接额度。
- 流到期及断线重新签票，不能复用已消费票据；重连可能丢成交，明确标记缺口并在可查询范围内补点；不得把网络到达时间当成成交时间。
- 服务端改动先回归和部署接口中心，再发布桌面端，避免客户端请求尚未部署的新能力。此次未使用 SSH 密钥或更改线上服务。

## 7. 主要改动位置

桌面端：

- `src/app/(main)/profile/page.tsx`：新增“数据配置”栏目和面板。
- `src/lib/api.ts`：报价、合约、K 线、逐笔/量价相关公共数据入口。
- `src/lib/snippet-rest.ts`、`okx-snippet-ws.ts`、`snippet-pool.ts`、`desktop-routing.ts`：旧线路及降级逻辑的公共行情接入边界。
- `src/lib/websocket.ts`、`src/stores/market.ts`：保留业务 WS，接收统一公共行情并隔离订阅状态。
- `src/components/market/kline/use-kline-history.ts`、`use-realtime-kline.ts`、`use-intraday-chart.ts`、`intraday.ts`、`realtime/accumulator.ts`：历史、实时、分时、去重补点。
- `src/lib/okx-forming.ts`、`display-kline.ts`、`realtime-factor/market.ts`：图表尾部及本机秒级策略的行情读取。
- `src/components/market/market-depth-panel.tsx`、`trade-details.tsx`、`src/types/index.ts`：盘口、成交、缺失状态和数量单位。
- `src/desktop-boot.ts`、`src-tauri/src/`：网络和用户 Key 的本地保护；具体模块在实施设计中确定。
- 研究迁移另涉 `kline-channels.ts`、`okx-history.ts`、`local-backtest.ts`、`mining/data-source.ts`、`research-kline-cache.ts` 等。

接口中心：

- `adapter/app/providers/okx.py`：K 线、报价、最近成交及合约规格。
- `adapter/app/providers/okx_socket/public.py`、`batch.py`：保留成交字段，扩展盘口和原生 K 线频道；business WS 不能误用 public 线路。
- `adapter/app/market/types.py`、`mapping.py`、`public/schemas.py`、`public/presentation.py`、`public/availability.py`：请求能力、公共字段、能力发现与字段白名单。
- `adapter/app/routes/market.py`、`stream.py`、`multiplex/`：签票、分发和潜在复用协议。
- 套餐能力、授权、订阅计费及管理 UI：新增深度等能力不能只增加路由而跳过授权链路。
- `control/internal/httpapi/common.go`、`edge.go` 与部署来源配置：桌面 WS Origin、流转发及错误传播。
- `frontend/src/pages/market/help/` 和 `docs/用户指南/`：同步面向用户的调用文档。

## 8. 实施顺序与验收

1. 接口中心先补齐盘口、真实成交字段与单位、实时 K 线、最近成交查询、必要合约规格和来源配置；完善能力与权限契约。
2. 桌面完成 Key 配置、原生凭据管理、票据客户端、公共行情转换和订阅调度。
3. 接入全部现有加密货币在线页面，处理旧线路、缓存和本机实时策略读取，避免同一画面混源。
4. 验证 BTC、ETH 及至少一个不同合约面值/精度的小币种；覆盖七周期、历史翻页、末根更新、闭合确认、盘口档位、同毫秒多笔成交、分时/Tick 语义、断网重连与 45 秒续签。
5. 验证无效/过期/撤销 Key、缺权限、5 连接限制、120 RPM、分屏、多窗口、切账号和切 Key。取得实际行情才算成功；只连上 WS 或收到元数据不算。
6. 运行改动对应的 TypeScript/Rust/Python/Go 检查和回归，再进行桌面实际运行验收；研究渠道单独验收，当前测试 Key 无法覆盖。
7. 发布时从届时最新版本递增 patch。按本次基线为 `v0.2.200 → v0.2.201`，同步 package.json 与 Tauri 配置等对外版本；推送 GitHub 提交和 `v*` 标签，触发现有 `.github/workflows/release.yml`。
8. 跟踪 Actions 完成，核对 Release 安装包、签名及 latest.json/gist 更新清单，验证旧版更新到新版；不能只推送提交就称已完成打包发布。

## 9. 当前结论

接口中心已可作为加密货币行情的统一入口，但完整覆盖现有桌面体验还需同步补齐其公开能力。建议先做在线 OKX USDT 永续行情 A01–A13 的缺口与统一接入；长期研究 K 线 A14 保持独立范围和授权，避免用普通短页行情代替多年研究历史。

本轮交付为待实施清单，正式实现与发布尚未开始。
