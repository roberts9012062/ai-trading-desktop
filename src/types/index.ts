/** ===== 行情相关类型 ===== */

/** 合约基础信息 */
export interface Contract {
  /** 合约代码，如 "rb2510" */
  code: string
  /** 合约名称，如 "螺纹钢2510" */
  name: string
  /** 交易所 */
  exchange: string
  /** 品种 */
  category: string
  /** 合约乘数 */
  multiplier: number
  /** 最小变动价位 */
  minTick: number
  /** 是否星标 */
  starred: boolean
}

/** 实时行情报价 */
export interface Quote {
  /** 合约代码 */
  code: string
  /** 最新价 */
  lastPrice: number
  /** 涨跌额 */
  change: number
  /** 涨跌幅（百分比） */
  changePercent: number
  /** 开盘价 */
  openPrice: number
  /** 最高价 */
  highPrice: number
  /** 最低价 */
  lowPrice: number
  /** 昨收价 */
  preClose: number
  /** 买一价 */
  bidPrice: number
  /** 卖一价 */
  askPrice: number
  /** 成交量 */
  volume: number
  /** 持仓量 */
  openInterest: number
  /** 更新时间戳 */
  timestamp: number
}

/** 盘口档位 */
export interface OrderBookLevel {
  price: number
  volume: number
}

export type MarketFieldQuality = "direct" | "derived" | "estimated" | "missing"

export interface MarketDepthField {
  value: number | null
  source: string
  quality: MarketFieldQuality
}

export type MarketDepthStats = Record<string, MarketDepthField>

/** 盘口数据 */
export interface OrderBook {
  symbol: string
  asks: OrderBookLevel[]  // 卖盘，索引0为卖1
  bids: OrderBookLevel[]  // 买盘，索引0为买1
  /** simnow/sina 表示快照主源；旧 quote_l1/realtime 仍兼容 */
  source?: string
  /** 服务端统一计算的盘口统计及字段质量 */
  stats?: MarketDepthStats
  /** 服务端接收快照的 Unix 秒 */
  asof?: number
  /** 快照是否过期 */
  stale?: boolean
  trade_date?: string
  last_direction?: "buy" | "sell" | ""
}

/** 成交明细 */
export interface TradeRecord {
  time: string
  price: number
  volume: number
  direction: "buy" | "sell"
  /** 有值时表示非真实逐笔（当前后端默认不推送假成交） */
  source?: "synthetic" | "realtime"
  /** 交易所完整时间戳（交易日+时刻），秒级唯一，增量去重用 */
  ts?: string
  /** 四路开平估算（后端持仓差分比例分摊），缺失时仅可累积总手 */
  open_long?: number | null
  close_long?: number | null
  open_short?: number | null
  close_short?: number | null
}

/** K 线数据 */
export interface KlineBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** 持仓量（数据源不支持时为 null/undefined） */
  openInterest?: number | null
  /** 结算价（数据源不支持时为 null/undefined） */
  settle?: number | null
  /** 持仓量（后端字段名 open_interest，数据源不支持时为 null/undefined） */
  open_interest?: number | null
  /** UTC epoch milliseconds, independent of the display time zone. */
  open_time?: number
  market_source?: "binance_spot" | "gate_spot" | "gate_usdt" | "binance_usdt" | "okx"
  quote_volume?: number | null
  trade_count?: number | null
  taker_buy_volume?: number | null
  taker_buy_quote_volume?: number | null
  /** Last settled rate available before this bar, not the next predicted rate. */
  funding_rate?: number | null
  funding_time?: number | null
  derivatives_time?: number
  taker_imbalance?: number | null
  long_short_ratio?: number | null
  liquidation_imbalance?: number | null
  /** 服务端 forming bar 版本号（同 time 键幂等覆盖用：只接受更高版本） */
  version?: number
  /** "correction" = 权威对账修正帧（OHLCV 已被权威值替换） */
  kind?: string
  /** OKX confirm: true only after the exchange confirms the candle closed. */
  is_closed?: boolean | null
}

/** K 线周期 */
export type KlinePeriod = "tick" | "1m" | "5m" | "15m" | "30m" | "60m" | "1d"

/** ===== 新闻相关类型 ===== */

/** 新闻条目 */
export interface NewsItem {
  title: string
  source: string
  url: string
  time: string
  symbols: string[]
  /** r20 模型：重要度分级与摘要 */
  importance?: "high" | "mid" | "low"
  summary?: string
}

/** 文章正文内容 */
export interface ArticleContent {
  title: string
  content: string
  source_url: string
}

/** ===== 交易相关类型 ===== */

/** 订单方向 */
export type OrderDirection = "buy" | "sell" | "close"

/** 订单类型 */
export type OrderType = "limit" | "market" | "conditional"

/** 订单状态 */
export type OrderStatus = "pending" | "partial" | "filled" | "cancelled"

/** 委托订单 */
export interface Order {
  id: string
  code: string
  contractName: string
  direction: OrderDirection
  type: OrderType
  price: number
  quantity: number
  filledQuantity: number
  status: OrderStatus
  createdAt: string
  updatedAt: string
}

/** ===== 持仓相关类型 ===== */

/** 持仓方向 */
export type PositionDirection = "long" | "short"

/** 持仓记录 */
export interface Position {
  id: string
  code: string
  contractName: string
  direction: PositionDirection
  quantity: number
  availableQuantity: number
  avgPrice: number
  currentPrice: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  margin: number
  forceLiquidationPrice: number
}

/** 历史开仓点位 */
export interface PositionDetail {
  time: string
  price: number
  quantity: number
  direction: PositionDirection
}

/** ===== 资产相关类型 ===== */

/** 账户概览 */
export interface AccountSummary {
  totalEquity: number
  availableMargin: number
  frozenMargin: number
  unrealizedPnl: number
  todayPnl: number
  totalDeposit: number
  totalWithdraw: number
  riskRate: number
}

/** 资金流水 */
export interface FundFlow {
  id: string
  time: string
  type: "deposit" | "withdraw" | "fee" | "settlement" | "transfer"
  amount: number
  balance: number
  description: string
}

/** 出入金记录 */
export interface DepositRecord {
  id: string
  applyTime: string
  bank: string
  amount: number
  status: "pending" | "approved" | "rejected" | "completed"
}

/** ===== 用户相关类型 ===== */

/** 用户信息（兼容后端 snake_case 字段） */
export interface User {
  id: string
  username: string
  phone: string | null
  email: string | null
  avatar: string | null
  /** 后端: real_name_verified */
  realNameVerified?: boolean
  real_name_verified?: boolean
  role: "user" | "admin"
  status?: "active" | "frozen"
  /** 会话绑定：live 实盘数据 / virtual 虚拟盘 */
  trading_mode?: "live" | "virtual"
  /** 后端: created_at */
  createdAt?: string
  created_at?: string
  updated_at?: string
}

/** 登录请求 */
export interface LoginRequest {
  account: string
  password: string
  /** live=实盘数据；virtual=虚拟盘 openctp 7×24 */
  trading_mode?: "live" | "virtual"
}

/** 注册请求（对齐后端 RegisterRequest） */
export interface RegisterRequest {
  username: string
  password: string
  phone: string | null
  email?: string | null
}

/** 认证响应（与后端 TokenResponse 匹配） */
export interface AuthResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

/** ===== 消息相关类型 ===== */

/** 消息类别 */
export type MessageCategory = "system" | "risk" | "trade" | "fund"

/** 消息 */
export interface Message {
  id: string
  category: MessageCategory
  title: string
  content: string
  read: boolean
  createdAt: string
}

/** 价格预警 */
export interface PriceAlert {
  id: string
  symbol: string
  contract_name: string
  direction: "above" | "below"
  target_price: number
  enabled: boolean
  triggered_at: string | null
  created_at: string
  trading_mode: string
}

/** 通知开关 */
export interface NotifySetting {
  notify_trade: boolean
  notify_fund: boolean
  notify_price_alert: boolean
  /** 消息提示音开关（新消息弹窗时是否播放提示音） */
  notify_sound_enabled: boolean
}

/** ===== 管理后台类型 ===== */

/** 管理后台用户列表项 */
export interface AdminUser {
  id: string
  username: string
  phone: string
  email: string
  registeredAt: string
  realNameVerified: boolean
  status: "active" | "frozen"
  riskRate: number
}

/** 管理后台合约列表项 */
export interface AdminContract {
  code: string
  name: string
  exchange: string
  category: string
  multiplier: number
  minTick: number
  feeRate: number
  marginRate: number
  status: "trading" | "suspended" | "delisted"
}

/** 系统日志 */
export interface SystemLog {
  id: string
  time: string
  level: "INFO" | "WARN" | "ERROR"
  module: string
  message: string
}

/** 系统公告 */
export interface Announcement {
  id: string
  content: string
  createdAt: string
}

/** ===== AI 相关类型 ===== */

/** AI 渠道商 */
export interface AIProvider {
  id: string
  user_id: string
  name: string
  /** 接口规范：openai / claude 对话规范，jev 为 TypeSafe System One 决策模型 */
  api_type: "openai" | "claude" | "jev"
  base_url: string
  api_key: string
  api_key_masked: string
  is_active: boolean
  /** 思考模式：null=跟随模型自动，true=强制开启，false=强制关闭（仅 Claude 规范生效） */
  thinking_enabled: boolean | null
  created_at: string
  model_count: number
}

/** AI 模型 */
export interface AIModel {
  id: string
  user_id: string
  provider_id: string
  model_id: string
  display_name: string
  is_multimodal: boolean
  is_custom: boolean
  capabilities: string[]
  created_at: string
  provider_name: string
  provider_api_type: string
}

/** 预设渠道 */
export interface PresetProvider {
  name: string
  api_type: "openai" | "claude" | "jev"
  base_url: string
  description: string
}

/** 渠道测试结果 */
export interface ProviderTestResult {
  status: "ok" | "error"
  message: string
  models: string[]
}

/** 聊天消息 */
export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** 子代理运行状态 */
export type SubAgentRunStatus = "pending" | "running" | "done" | "error"

/** 子代理列表项（多品种调研） */
export interface SubAgentItem {
  id: string
  name: string
  status: SubAgentRunStatus
  detail?: string
  progress?: number
  longCount?: number
  shortCount?: number
  symbols?: string[]
  error?: string | null
}

/** SSE 流式事件 */
export interface StreamEvent {
  type:
    | "message"
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "confirmation_request"
    | "react_round"
    | "subagent_plan"
    | "subagent_update"
    | "error"
    | "done"
  content?: string
  name?: string
  arguments?: string
  call_id?: string
  message?: string
  round?: number
  max_rounds?: number
  /** subagent_plan */
  agents?: Array<{
    id: string
    name: string
    symbols?: string[]
    product_codes?: string[]
    status?: SubAgentRunStatus
  }>
  total?: number
  /** subagent_update */
  id?: string
  status?: SubAgentRunStatus
  detail?: string
  progress?: number
  long_count?: number
  short_count?: number
  error?: string | null
}

/** ===== AI 对话类型 ===== */

/** 对话列表项（后端返回） */
export interface AIConversationItem {
  id: string
  title: string
  model_id: string
  updated_at: string
}

/** 消息项（后端返回） */
export interface AIMessageItem {
  id: string
  conversation_id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  tool_calls: Record<string, unknown> | null
  tool_result: Record<string, unknown> | null
  created_at: string
}

/** 消息分页结果 */
export interface AIMessagePage {
  items: AIMessageItem[]
  total: number
  page: number
  size: number
}

/** 聊天面板内的消息（前端使用） */
export interface ChatBubble {
  id: string
  role: "user" | "assistant"
  content: string
  thinking: string
  toolCalls: Array<{ name: string; args: string; callId: string; status: "loading" | "done" | "error" }>
  toolResults: Array<{ name: string; content: string; callId: string }>
  /** 需要用户确认的工具调用 */
  confirmations: Array<{ name: string; args: string; callId: string; resolved: boolean }>
  /** 多品种调研子代理列表 */
  subAgents: SubAgentItem[]
  /** ReAct 推理轮次 */
  reactRound: number
  reactMaxRounds: number
  isStreaming: boolean
  isCancelled: boolean
  createdAt: number
}

/** ===== AI Skills 类型 ===== */

/** 商城 skill 列表项 */
export interface MarketplaceSkillItem {
  id: string
  name: string
  author: string
  description: string
  install_count: number
  trigger_word: string
  git_url: string
}

/** 商城 skill 详情 */
export interface MarketplaceSkillDetail {
  id: string
  name: string
  author: string
  description: string
  skill_md_preview: string
  install_count: number
  trigger_word: string
  git_url: string
}

/** 已安装 skill */
export interface InstalledSkillItem {
  id: string
  name: string
  trigger_word: string
  source: "marketplace" | "upload" | "git_url"
  source_url: string
  description: string
  is_enabled: boolean
  created_at: string
}

/** Skill 配置（token 等） */
export interface SkillConfig {
  has_token: boolean
  masked_token: string
}

/** ===== 合约树(三级菜单)相关类型 ===== */

/** 单个合约项 - 对应 backend ContractItemSchema */
export interface ContractItem {
  /** 合约代码,如 "rb2610" */
  symbol: string
  /** 交割月份 1-12 */
  month: number
  /** 交割年份,如 2026 */
  year: number
  /** 当日成交量 */
  volume: number
  /** 是否为主力合约 */
  is_master: boolean
  /** 是否为次主力合约 */
  is_secondary: boolean
}

/** 单个品种代码下的合约树 - 对应 backend CodeTreeSchema */
export interface CodeTree {
  /** 品种代码,如 "RB" */
  code: string
  /** 品种中文名,如 "螺纹钢" */
  name: string
  /** 交易所,如 "上期所" */
  exchange: string
  /** 主力合约 symbol */
  master: string | null
  /** 次主力合约 symbol */
  secondary: string | null
  /** 该品种下全部交割月份合约 */
  contracts: ContractItem[]
}

/** 按品种代码分组的合约树字典 */
export type CodeTreeMap = Record<string, CodeTree>
