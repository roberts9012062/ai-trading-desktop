"use client"

/**
 * 合约规格 store —— 按品种提供 tick_size / decimal_places
 *
 * 数据来自后端 /api/paper/product-specs（复用 TICK_SIZES）。
 * 登录后由 K 线组件触发加载；未加载或未命中时回退默认值（tick=1, 小数=0）。
 *
 * 设计为独立 store，不污染 paper-trading 的交易逻辑。
 */

import { create } from "zustand"
import { getProductSpecs, type ProductSpecItem } from "@/lib/paper-api"
import { useAuthStore } from "@/stores/auth"

/** 默认值：未加载/未命中时按整数 tick 处理 */
export const DEFAULT_TICK_SIZE = 1
export const DEFAULT_DECIMAL_PLACES = 0

/** 从合约代码提取品种字母：rb2610 → RB，cu2607 → CU，IF2512 → IF */
function extractProductCode(symbol: string): string {
  const letters = symbol.match(/^[A-Za-z]+/)?.[0] ?? ""
  return letters.toUpperCase()
}

interface ContractSpecState {
  specs: ProductSpecItem[]
  loaded: boolean
  loading: boolean
  /** 登录后加载（内部 loaded 去重） */
  load: () => Promise<void>
  /** 按合约代码查 tick_size（未命中回退 1） */
  getTickSize: (symbol: string) => number
  /** 按合约代码查价格小数位（未命中回退 0） */
  getDecimalPlaces: (symbol: string) => number
}

export const useContractSpecStore = create<ContractSpecState>((set, get) => ({
  specs: [],
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loaded || get().loading) return
    if (typeof window === "undefined") return
    if (!useAuthStore.getState().accessToken) return
    set({ loading: true })
    try {
      const res = await getProductSpecs()
      set({ specs: res.items, loaded: true, loading: false })
    } catch {
      // 加载失败：保持空，下次重试
      set({ loading: false })
    }
  },

  getTickSize: (symbol) => {
    const code = extractProductCode(symbol)
    const spec = get().specs.find((s) => s.code.toUpperCase() === code)
    return spec?.tick_size ?? DEFAULT_TICK_SIZE
  },

  getDecimalPlaces: (symbol) => {
    const code = extractProductCode(symbol)
    const spec = get().specs.find((s) => s.code.toUpperCase() === code)
    return spec?.decimal_places ?? DEFAULT_DECIMAL_PLACES
  },
}))
