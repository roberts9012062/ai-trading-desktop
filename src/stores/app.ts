"use client"

import { create } from "zustand"
import type { CodeTreeMap } from "@/types"

/** 当前选中合约的本地持久化 key（全局，多页面共用） */
export const ACTIVE_CONTRACT_KEY = "qihuo_active_contract"

/** 历史版本的出厂默认合约（非用户选择）：主力前移时随主力迁移 */
export const STALE_DEFAULT_CONTRACT = "rb2610"

/** 读全局合约记忆（无记忆返回 null；SSR 返回 null） */
export function readActiveContract(): string | null {
  if (typeof window === "undefined") return null
  try {
    const v = localStorage.getItem(ACTIVE_CONTRACT_KEY)
    return v ? v : null
  } catch {
    return null
  }
}

/**
 * 过期合约迁移：跟随品种主力（需要合约树，树未就绪原样返回）
 *
 * 判定「过期」的两条规则（用户主动选择的有效合约一律保留）：
 * 1. 等于出厂默认 rb2610 —— 不是用户选择，主力前移即跟随；
 * 2. 已不在该品种当前合约清单（下市）—— 跟随主力。
 */
export function migrateStaleContract(code: string, tree: CodeTreeMap | null): string {
  const cur = (code || "").trim()
  if (!cur || !tree) return cur
  const product = cur.toUpperCase().replace(/\d+$/, "")
  const node = tree[product]
  const master = node?.master
  if (!master || master === cur) return cur
  if (cur === STALE_DEFAULT_CONTRACT) return master
  const listed = (node?.contracts ?? []).some((c) => c.symbol === cur)
  if (!listed) return master
  return cur
}

/**
 * 行情页自己的合约记忆 key —— 与全局 activeContract 隔离：
 * AI 看盘页选任务也会切全局合约，行情页恢复/保存只认自己的 key，
 * 两边互不串台（AI 看盘的任务选择存于 ai-market-selected-task）。
 */
export const MARKET_VIEW_CONTRACT_KEY = "qihuo_market_view_contract"

/** 读行情页自己的合约记忆（无记忆返回 null） */
export function readMarketViewContract(): string | null {
  if (typeof window === "undefined") return null
  try {
    const v = localStorage.getItem(MARKET_VIEW_CONTRACT_KEY)
    return v ? v : null
  } catch {
    return null
  }
}

/** 写行情页自己的合约记忆，SSR 阶段忽略 */
export function writeMarketViewContract(code: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(MARKET_VIEW_CONTRACT_KEY, code)
  } catch {
    // 隐私模式等写失败忽略
  }
}

/** 仅在客户端写入选中合约，SSR 阶段忽略 */
function persistActiveContract(code: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(ACTIVE_CONTRACT_KEY, code)
  } catch {
    // 隐私模式等写失败忽略
  }
}

/** 交易面板意图：从持仓行点进时自动切到平仓 */
export interface TradePanelIntent {
  /** 递增以重复触发同一意图 */
  seq: number
  /** view=仅切换合约；close=切换并进入平仓；price=填入盘口限价 */
  mode: "view" | "close" | "price"
  /** 平仓时原持仓方向 */
  positionDirection: "long" | "short" | null
  /** 建议手数（可平量） */
  quantity: number | null
  /** 盘口点价时的买卖方向 */
  direction?: "buy" | "sell" | null
  /** 盘口点价时的限价 */
  price?: number | null
}

interface AppState {
  /** 侧边栏是否折叠 */
  sidebarCollapsed: boolean
  /** 切换侧边栏折叠状态 */
  toggleSidebar: () => void
  /** 设置侧边栏折叠状态 */
  setSidebarCollapsed: (collapsed: boolean) => void

  /** 当前活跃合约代码（持久化到 localStorage，由合约列表在客户端恢复） */
  activeContract: string
  /** 设置活跃合约（仅切 K 线/行情，同时持久化） */
  setActiveContract: (code: string) => void

  /** 交易面板意图（持仓点击平仓联动） */
  tradePanelIntent: TradePanelIntent | null
  /** 仅切换合约（委托/持仓点选），并持久化 */
  selectTradeSymbol: (symbol: string) => void
  /** 切换合约并让下单区进入平仓，并持久化 */
  selectPositionForClose: (
    symbol: string,
    positionDirection: "long" | "short",
    quantity: number
  ) => void
  /** 将盘口买卖价填入下单区，不直接提交 */
  selectLimitPrice: (side: "ask" | "bid", price: number) => void
  /** 消费完意图后清空（避免重复应用） */
  clearTradePanelIntent: () => void

  /** 市场状态：交易中/休市/断线 */
  marketStatus: "trading" | "closed" | "offline"
  /** 设置市场状态 */
  setMarketStatus: (status: "trading" | "closed" | "offline") => void

  /** 合约搜索弹窗 */
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void

  /** 自选列表刷新版本号，+1 触发重新加载 */
  watchlistVersion: number
  bumpWatchlistVersion: () => void
}

function normalizeSymbol(code: string): string {
  return code.trim()
}

/** 全局应用状态 */
export const useAppStore = create<AppState>((set, get) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  activeContract: "rb2610",
  setActiveContract: (code) => {
    const normalized = normalizeSymbol(code)
    persistActiveContract(normalized)
    set({ activeContract: normalized })
  },

  tradePanelIntent: null,
  selectTradeSymbol: (symbol) => {
    const code = normalizeSymbol(symbol)
    persistActiveContract(code)
    set({
      activeContract: code,
      tradePanelIntent: {
        seq: (get().tradePanelIntent?.seq ?? 0) + 1,
        mode: "view",
        positionDirection: null,
        quantity: null,
      },
    })
  },
  selectPositionForClose: (symbol, positionDirection, quantity) => {
    const code = normalizeSymbol(symbol)
    persistActiveContract(code)
    set({
      activeContract: code,
      tradePanelIntent: {
        seq: (get().tradePanelIntent?.seq ?? 0) + 1,
        mode: "close",
        positionDirection,
        quantity: Math.max(1, quantity),
      },
    })
  },
  selectLimitPrice: (side, price) => {
    if (!Number.isFinite(price) || price <= 0) return
    set({
      tradePanelIntent: {
        seq: (get().tradePanelIntent?.seq ?? 0) + 1,
        mode: "price",
        positionDirection: null,
        quantity: null,
        direction: side === "ask" ? "buy" : "sell",
        price,
      },
    })
  },
  clearTradePanelIntent: () => set({ tradePanelIntent: null }),

  marketStatus: "trading",
  setMarketStatus: (status) => set({ marketStatus: status }),

  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),

  watchlistVersion: 0,
  bumpWatchlistVersion: () =>
    set((s) => ({ watchlistVersion: s.watchlistVersion + 1 })),
}))
