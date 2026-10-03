/** 因子实验室 API 客户端 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
const SEARCH_TIMEOUT_MS = 180_000
const LLM_TIMEOUT_MS = 240_000

/** 训练/测试段的纯指标快照（防过拟合改造，可选） */
export interface SegmentMetrics {
  ann_ret: number
  sortino: number
  calmar: number
  ts_ic: number
  avg_turnover?: number
  exposure?: number
  bars?: number
}

/** walk-forward 单折明细 */
export interface WalkForwardFold {
  train: SegmentMetrics
  test: SegmentMetrics
}

/** walk-forward 汇总 */
export interface WalkForwardDetail {
  folds: WalkForwardFold[]
  wf_stable: boolean
  wf_mean_test_sortino: number
  wf_mean_test_ann: number
  wf_consistency: number
  n_folds: number
}

export interface FactorMetrics {
  data_channel?: string
  research_only?: boolean
  crypto_profile?: boolean
  research_profile?: string
  periods?: number
  cost?: number
  cost_model?: string
  /** 产出该指标的内核口径版本(发布前清单第 2 步;旧记录无此字段=旧口径) */
  kernel_version?: string
  /** 派生标记:版本戳与当前内核不一致(championFromHistory/Favorite 打标,
   *  旧口径记录禁止直接挂载实盘,清单第 7 步) */
  stale_kernel?: boolean
  /** 桌面端本地专属特征标记(内核 factor_local 打标):公式含 id ≥ 36 的
   *  特征 token,服务端无法执行——禁止收藏同步;挂实盘自动切本地引擎 */
  local_only?: boolean
  ann_ret: number
  sortino: number
  calmar: number
  ts_ic: number
  symmetry: number
  turnover_q: number
  oos_sortino: number
  oos_mult: number
  /** OOS（后 25%）Sortino 为负，composite 已被强压制。前端据此标红警告 */
  oos_negative?: boolean
  consistency: number
  composite: number
  avg_turnover: number
  exposure: number
  /** 防过拟合：训练段纯指标（搜索时所见） */
  train_metrics?: SegmentMetrics
  /** 防过拟合：独立测试段纯指标（搜索时未见，用于验证） */
  test_metrics?: SegmentMetrics
  /** 防过拟合：walk-forward 滚动验证明细 */
  walk_forward?: WalkForwardDetail
  /** 防过拟合：兜底回退标记（严格筛全军覆没时，该因子测试段亏损，仅供参考） */
  overfit_warning?: string
  /** v2 研究状态(crypto_local_v2):holdout_passed|validation_passed|
   *  rejected|exploratory;旧口径无此字段 */
  candidate_status?: string
  /** v2 样本不足:仅探索,不计入合格因子数(带 sample_gaps 缺口明细) */
  insufficient_samples?: boolean
  sample_gaps?: string[]
  /** v2 封存通过判定(指标复用 selection_v2 的 holdout_metrics 字段) */
  holdout_passed?: boolean
  validation_passed?: boolean
  /** v2 执行口径指标(次根开盘成交 + funding 事件现金流) */
  execution_metrics?: Record<string, number>
  /** v2 切分计划摘要(训练/验证/封存边界与充分性) */
  split_plan?: Record<string, unknown>
  /** P5 统计严谨性：PBO 代理（训练段最优 K 个候选中样本外失败比例） */
  pbo_proxy?: number
  /** P5 统计严谨性：测试段四等分最差子段 Sortino（样本外保守下界） */
  oos_conservative?: number
  /** P5 统计严谨性：本次搜索总试验数（多重检验语境） */
  trials?: number
  /** 跨品种验证：同板块伙伴品种 sortino 明细（报告指标） */
  cross_symbol?: Record<string, number>
  /** 市场状态分解：测试段趋势上/趋势下/震荡分项指标（报告指标） */
  regime?: Record<
    string,
    { bars: number; sortino: number | null; ann_ret: number | null }
  >
  /** 增强遴选(本地 selection_v2):封存段指标——遴选全程不可见,仅最终评估一次;
   *  开了实盘口径门时附 live_discrete_sortino/ann_ret */
  holdout_metrics?: SegmentMetrics & {
    live_discrete_sortino?: number
    live_discrete_ann_ret?: number
  }
  /** 增强遴选:Deflated Sharpe(按试验次数折扣的真实夏普>0 概率,0-1) */
  dsr?: number
}

export interface Champion {
  tokens: number[]
  text: string
  composite: number
  metrics: FactorMetrics
}

export interface FactorRange {
  from: string | null
  to: string | null
}

export interface AppliedConfig {
  population: number
  generations: number
  mutation_p: number
  crossover_p: number
  top_n: number
  seed: number
  cost: number
  /** true = 成本由后端按品种推导，而非前端指定 */
  cost_auto?: boolean
  /** 该周期每年 bar 数（年化基数），日线 243，1m 约 8 万 */
  periods?: number
  seed_count: number
  source: string
  /** 防过拟合：训练段占比（0=关闭） */
  train_ratio?: number
  /** 防过拟合：强制最近 N 根作测试段（0=关闭） */
  test_recent_bars?: number
  /** 防过拟合：walk-forward 折数（0=关闭） */
  walk_forward_folds?: number
}

export interface PortfolioMetrics {
  ann_ret: number
  sortino: number
  calmar: number
}

/** 冠军组合评估（相关性去重后的 top-N 因子组合，≥2 个可组合才返回） */
export interface PortfolioResult {
  n_factors: number
  avg_abs_corr: number
  equal: PortfolioMetrics
  ic_weighted?: PortfolioMetrics | null
  best_single: PortfolioMetrics
  /** 评估区间(本地内核):缺省=全段(含训练段,样本内);test=测试段;holdout=封存段 */
  segment?: "full" | "test" | "holdout"
  /** 评估区间 bar 数(segment 非 full 时) */
  eval_bars?: number
  /** 原生引擎组合压力口径:2× 成本下的同一封存段计分 */
  equal_2x?: PortfolioMetrics
  ic_weighted_2x?: PortfolioMetrics | null
  best_single_2x?: PortfolioMetrics
  /** 成员 token 列表与是否研究级(仅未过执行级门槛的组合救活来源) */
  members?: number[][]
  member_research?: boolean[]
  any_member_research?: boolean
  /** 组合因子(勾选「组合因子」的任务):末代自动组合测试超级因子 */
  combo_super?: boolean
  /** 成员来源:quality=优质因子(合格+研究级);rescued=无优质时从失败因子回捞 */
  combo_source?: "quality" | "rescued"
  /** 超级因子测试通过:等权或 IC 加权在验证区折全正(1×)且封存段 2× Sortino>0 */
  super_passed?: boolean
  /** 通过的组合口径(等权或 IC 加权) */
  pass_mode?: "equal" | "ic_weighted"
  /** 逐折 1× Sortino(验证区按任务折数均分;折数=0 时不产出);*_ic 为 IC 加权口径 */
  wf_fold_sortinos?: number[]
  wf_fold_sortinos_ic?: number[] | null
  /** 折检验是否全正(折数=0 视为 true) */
  wf_stable?: boolean
}

export interface SearchResult {
  symbol: string
  timeframe: string
  bars: number
  range: FactorRange
  champions: Champion[]
  portfolio?: PortfolioResult | null
  coach_note?: string | null
  applied_config?: AppliedConfig
}

export interface EquityPoint {
  time: string
  equity: number
  position: number
  price: number
}

export interface FactorLiveMetrics {
  /** 实盘离散口径（±1 手、0.3 入场/0.05 平仓）的年化 */
  ann_ret: number
  sortino: number
  calmar: number
  avg_turnover: number
  exposure: number
  n_trades: number
}

export interface FactorBacktestResult {
  symbol: string
  timeframe: string
  bars: number
  /** 实际回测区间（bar 首尾时间；近期模式也有） */
  range?: FactorRange
  metrics: FactorMetrics
  /** 实盘离散口径指标（±1 手全进全出，可对比连续仓位理论值） */
  live_metrics?: FactorLiveMetrics
  equity_curve: EquityPoint[]
  /** 防过拟合：单因子 walk-forward 视图（请求时 folds>0 才返回） */
  walk_forward?: WalkForwardDetail
}

export interface FactorLabMeta {
  features: string[]
  ops: string[]
  timeframes: string[]
  defaults: {
    population: number
    generations: number
    top_n: number
    /** null = 后端按品种 tick + 手续费自动推导单边成本率 */
    cost: number | null
  }
}

export interface FactorHistoryItem {
  id: string
  symbol: string
  timeframe: string
  tokens: number[]
  text: string
  composite: number
  metrics: Partial<FactorMetrics>
  source: string
  created_at: string | null
  updated_at: string | null
}

export interface FactorFavoriteItem {
  id: string
  symbol: string | null
  timeframe: string | null
  name: string
  tokens: number[]
  text: string
  composite: number | null
  metrics: Partial<FactorMetrics> | null
  note: string | null
  /** 所属收藏文件夹（空=未分类） */
  folder_id?: string | null
  /** 衰减监控（IC 口径）：250 根滚动 IC ≤0 → decay（E10b 验证前瞻差 -0.31） */
  health?: {
    trailing_ic: number
    ic_window: number
    live_sortino: number
    live_ann: number
    window: number
    bars: number
    decay: boolean
    checked_at?: string
  } | null
  created_at: string | null
}

export interface LlmGenerateResult extends SearchResult {
  llm_meta?: {
    attempts: number
    dropped: number
    source: string
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs: number = SEARCH_TIMEOUT_MS,
): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("access_token") : null
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: ctrl.signal,
    })
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.href = "/login"
      throw new Error("认证过期")
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: "请求失败" }))
      const detail =
        typeof error?.detail === "string" ? error.detail : "请求失败"
      throw new Error(detail)
    }
    return response.json() as Promise<T>
  } finally {
    clearTimeout(timer)
  }
}

export async function searchFactors(payload: {
  symbol: string
  timeframe: string
  population: number
  generations: number
  top_n: number
  seed: number
  /** null = 由后端按品种推导（含 1 tick 滑点），显式数值则覆盖 */
  cost: number | null
  seed_tokens?: number[][]
  use_llm_coach?: boolean
  model_row_id?: string | null
  mutation_p?: number
  crossover_p?: number
  /** 防过拟合：训练段占比（0=关闭） */
  train_ratio?: number
  /** 防过拟合：强制最近 N 根作测试段（0=关闭，优先级高于 train_ratio） */
  test_recent_bars?: number
  /** 防过拟合：walk-forward 折数（0=关闭） */
  walk_forward_folds?: number
  /** 长历史区间（YYYY-MM-DD，需与 end_date 成对；不传走近期数据） */
  start_date?: string
  end_date?: string
}): Promise<SearchResult> {
  const timeout =
    payload.use_llm_coach === true ? LLM_TIMEOUT_MS : SEARCH_TIMEOUT_MS
  return request<SearchResult>(
    "/api/factor-lab/search",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    timeout,
  )
}

export async function backtestFactor(payload: {
  symbol: string
  timeframe: string
  factor_tokens: number[]
  initial_cash?: number
  cost?: number | null
  /** 防过拟合：>0 时返回 walk-forward 多窗口明细 */
  walk_forward_folds?: number
  /** 长历史区间（YYYY-MM-DD，需与 end_date 成对；不传走近期数据） */
  start_date?: string
  end_date?: string
}): Promise<FactorBacktestResult> {
  return request<FactorBacktestResult>("/api/factor-lab/backtest-factor", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function fetchFactorLabMeta(): Promise<FactorLabMeta> {
  return request<FactorLabMeta>("/api/factor-lab/meta")
}

/** ── 因子相似度分析（组合挂载前置检查，web fad6967 同源） ── */

export interface FactorSimilarityPair {
  i: number
  j: number
  /** 指标相似度：tanh 仓位意图序列 Pearson 相关（-1~1） */
  value_corr: number
  /** 赚钱波段重合：逐 bar 隐含盈亏流 Pearson 相关（-1~1） */
  pnl_corr: number
  /** 两因子同时盈利 bar 占任一盈利 bar 的比例（%） */
  win_overlap_pct: number
  /** 综合相似度 0~10（≥7 高度相似 / 4-7 中等 / <4 低相关） */
  similarity: number
  level: "high" | "mid" | "low"
}

export interface FactorSimilarityResult {
  symbol: string
  timeframe: string
  bars: number
  /** 单因子分：与组合内其它因子相似度均值（分接近且偏高的互为相似因子） */
  factors: { index: number; score: number }[]
  pairs: FactorSimilarityPair[]
  verdict: string
}

export async function analyzeFactorSimilarity(payload: {
  symbol: string
  timeframe: string
  token_groups: number[][]
}): Promise<FactorSimilarityResult> {
  return request<FactorSimilarityResult>("/api/factor-lab/similarity", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function listFactorHistory(
  symbol: string,
): Promise<FactorHistoryItem[]> {
  const q = encodeURIComponent(symbol)
  const res = await request<{ items: FactorHistoryItem[] }>(
    `/api/factor-lab/history?symbol=${q}`,
  )
  return res.items
}

/**
 * 桌面端本地引擎搜索结果落服务端历史(配套服务端 POST /api/factor-lab/history,
 * source 服务端写死 "local")。best-effort:端点未上线(404)时由调用方静默降级。
 */
export async function saveFactorHistory(payload: {
  symbol: string
  timeframe: string
  champions: {
    tokens: number[]
    text: string
    composite: number
    metrics: Partial<FactorMetrics>
  }[]
  trials?: number
  bars?: number
  config?: Record<string, unknown>
}): Promise<number> {
  const res = await request<{ ok: boolean; saved: number }>(
    "/api/factor-lab/history",
    { method: "POST", body: JSON.stringify(payload) },
  )
  return res.saved
}

export async function deleteFactorHistory(id: string): Promise<void> {
  await request(`/api/factor-lab/history/${id}`, { method: "DELETE" })
}

export async function listFactorFavorites(
  symbol?: string,
): Promise<FactorFavoriteItem[]> {
  const q =
    symbol && symbol.trim()
      ? `?symbol=${encodeURIComponent(symbol.trim())}`
      : ""
  const res = await request<{ items: FactorFavoriteItem[] }>(
    `/api/factor-lab/favorites${q}`,
  )
  return res.items
}

export async function addFactorFavorite(payload: {
  tokens: number[]
  text: string
  name?: string
  symbol?: string
  timeframe?: string
  composite?: number
  metrics?: Partial<FactorMetrics>
  note?: string
  folder_id?: string | null
}): Promise<FactorFavoriteItem> {
  // 收藏持久化配方与验证证据，不执行交易；服务端信号能力在挂载时检查。
  return request<FactorFavoriteItem>("/api/factor-lab/favorites", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

/** 拖拽排序：按顺序的收藏 ID 持久化 */
export async function reorderFactorFavorites(ids: string[]): Promise<void> {
  await request("/api/factor-lab/favorites/reorder", {
    method: "POST",
    body: JSON.stringify({ ids }),
  })
}

export async function deleteFactorFavorite(id: string): Promise<void> {
  await request(`/api/factor-lab/favorites/${id}`, { method: "DELETE" })
}

export async function patchFactorFavorite(
  id: string,
  payload: { name?: string; note?: string; folder_id?: string | null },
): Promise<FactorFavoriteItem> {
  return request<FactorFavoriteItem>(`/api/factor-lab/favorites/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  })
}

export async function llmGenerateFactors(payload: {
  symbol: string
  timeframe: string
  model_row_id: string
  n_candidates?: number
  top_n?: number
  cost?: number
  seed_tokens?: number[][]
  user_hint?: string
  /** 长历史区间（YYYY-MM-DD，需与 end_date 成对；不传走近期数据） */
  start_date?: string
  end_date?: string
}): Promise<LlmGenerateResult> {
  return request<LlmGenerateResult>(
    "/api/factor-lab/llm-generate",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    LLM_TIMEOUT_MS,
  )
}
