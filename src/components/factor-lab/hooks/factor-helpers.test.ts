/**
 * 防过拟合三参组装单测（P0-1 回归）
 *
 * 曾经用折叠面板展开状态当启用位：面板默认收起 → 三参以 0 发出、
 * 防护整体失效，UI 角标却显示「已开启」。修复后启用位是独立布尔，
 * 这里锁定「默认开启推荐配置、关闭时全 0」的契约。
 */
import { describe, expect, it } from "vitest"
import {
  antiOverfitPayload,
  championFromFavorite,
  championFromHistory,
  defaultSearchPayload,
} from "@/components/factor-lab/hooks/factor-helpers"
import { CURRENT_KERNEL_VERSION } from "@/lib/kernel-version"
import type { FactorFavoriteItem, FactorHistoryItem } from "@/lib/factor-lab-api"

describe("antiOverfitPayload", () => {
  it("启用时透传三项数值（默认推荐配置 0.7/0/3）", () => {
    const p = antiOverfitPayload(true, 0.7, 0, 3)
    expect(p).toEqual({ train_ratio: 0.7, test_recent_bars: 0, walk_forward_folds: 3 })
  })

  it("关闭时三项全 0（内核防护关闭）", () => {
    const p = antiOverfitPayload(false, 0.7, 60, 3)
    expect(p).toEqual({ train_ratio: 0, test_recent_bars: 0, walk_forward_folds: 0 })
  })

  it("单项数值透传不被改写", () => {
    expect(antiOverfitPayload(true, 0.5, 60, 2)).toEqual({
      train_ratio: 0.5,
      test_recent_bars: 60,
      walk_forward_folds: 2,
    })
  })

  it("表单默认值与 defaultSearchPayload 的推荐配置保持同源", () => {
    // factor-search-form 的 state 默认值是 (antiOverfitOn=true, 0.7, 0, 3)，
    // 组装结果必须与回退用 defaultSearchPayload 的防过拟合三参一致，
    // 避免两条路径行为分裂
    const fromForm = antiOverfitPayload(true, 0.7, 0, 3)
    const fallback = defaultSearchPayload("rb2610", "1d")
    expect(fromForm.train_ratio).toBe(fallback.train_ratio)
    expect(fromForm.test_recent_bars).toBe(fallback.test_recent_bars)
    expect(fromForm.walk_forward_folds).toBe(fallback.walk_forward_folds)
  })
})

describe("championFromHistory(P1-5 回归)", () => {
  const item: FactorHistoryItem = {
    id: "h1",
    symbol: "rb2610",
    timeframe: "1d",
    tokens: [0, 64],
    text: "当日收益 + ?",
    composite: 0.8,
    metrics: {
      ann_ret: 0.2,
      composite: 0.8,
      overfit_warning: "测试段 sortino≤0,过拟合风险高",
      oos_conservative: -0.3,
      pbo_proxy: 0.4,
      test_metrics: { sortino: -0.5, ann_ret: -0.1 } as unknown as FactorHistoryItem["metrics"],
    },
  } as unknown as FactorHistoryItem

  it("全量透传白名单外字段:overfit_warning 不再丢失(拦截依赖它)", () => {
    const c = championFromHistory(item)
    expect(c.metrics.overfit_warning).toBe("测试段 sortino≤0,过拟合风险高")
    expect(c.metrics.oos_conservative).toBe(-0.3)
    expect((c.metrics as unknown as Record<string, unknown>).pbo_proxy).toBe(0.4)
    expect(c.metrics.test_metrics).toBeTruthy()
  })

  it("缺省字段由 emptyMetrics 兜底,composite 回退 item.composite", () => {
    const bare = { ...item, metrics: { composite: undefined } } as unknown as FactorHistoryItem
    const c = championFromHistory(bare)
    expect(c.metrics.composite).toBe(0.8)
    expect(c.metrics.ann_ret).toBe(0) // 兜底
  })
})

describe("旧内核口径判定(发布前清单第 7 步)", () => {
  it("缺版本戳的历史记录 → stale_kernel(旧口径)", () => {
    const item = {
      tokens: [0],
      text: "t",
      composite: 0.5,
      metrics: { ann_ret: 0.1 },
    } as unknown as FactorHistoryItem
    expect(championFromHistory(item).metrics.stale_kernel).toBe(true)
  })

  it("版本戳为当前内核 → 不打标", () => {
    const item = {
      tokens: [0],
      text: "t",
      composite: 0.5,
      metrics: { ann_ret: 0.1, kernel_version: CURRENT_KERNEL_VERSION },
    } as unknown as FactorHistoryItem
    expect(championFromHistory(item).metrics.stale_kernel).toBe(false)
  })

  it("收藏记录同样按版本戳判定", () => {
    const fav = {
      tokens: [0],
      text: "t",
      composite: 0.5,
      metrics: { kernel_version: "pykernel-factor-2026-08-23.1" },
    } as unknown as FactorFavoriteItem
    expect(championFromFavorite(fav).metrics.stale_kernel).toBe(true)
  })
})
