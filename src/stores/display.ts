"use client"

/**
 * 显示偏好（字号/K线涨跌颜色）—— 本地持久化，不依赖后端
 */

import { create } from "zustand"
import {
  applyFontSize,
  normalizeFontSize,
  readStoredFontSize,
  type FontSizeLevel,
} from "@/lib/font-size"
import {
  DEFAULT_CANDLE_DOWN,
  DEFAULT_CANDLE_UP,
  readStoredKlineColors,
  saveStoredKlineColors,
} from "@/lib/kline-colors"

interface DisplayState {
  /** 界面字号档位 */
  fontSize: FontSizeLevel
  /** K线涨跌颜色（#RRGGBB） */
  candleUp: string
  candleDown: string
  /** 是否已从 localStorage 水合 */
  hydrated: boolean
  /** 初始化（客户端挂载时调用一次） */
  hydrate: () => void
  /** 设置字号并立即生效 + 持久化 */
  setFontSize: (level: FontSizeLevel) => void
  /** 设置K线涨跌颜色并持久化（非法值被拒） */
  setCandleColors: (up: string, down: string) => boolean
  /** 恢复默认K线颜色 */
  resetCandleColors: () => void
}

/** 显示设置 store */
export const useDisplayStore = create<DisplayState>((set) => ({
  fontSize: "standard",
  candleUp: DEFAULT_CANDLE_UP,
  candleDown: DEFAULT_CANDLE_DOWN,
  hydrated: false,
  hydrate: () => {
    const level = readStoredFontSize()
    applyFontSize(level)
    const colors = readStoredKlineColors()
    set({ fontSize: level, candleUp: colors.up, candleDown: colors.down, hydrated: true })
  },
  setFontSize: (level) => {
    const next = normalizeFontSize(level)
    applyFontSize(next)
    set({ fontSize: next, hydrated: true })
  },
  setCandleColors: (up, down) => {
    const upHex = up.trim().toLowerCase()
    const downHex = down.trim().toLowerCase()
    if (!/^#[0-9a-f]{6}$/.test(upHex) || !/^#[0-9a-f]{6}$/.test(downHex)) {
      return false
    }
    saveStoredKlineColors({ up: upHex, down: downHex })
    set({ candleUp: upHex, candleDown: downHex })
    return true
  },
  resetCandleColors: () => {
    saveStoredKlineColors({ up: DEFAULT_CANDLE_UP, down: DEFAULT_CANDLE_DOWN })
    set({ candleUp: DEFAULT_CANDLE_UP, candleDown: DEFAULT_CANDLE_DOWN })
  },
}))
