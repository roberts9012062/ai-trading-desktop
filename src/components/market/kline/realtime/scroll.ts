/**
 * 数据到达时的视口维持策略（自 use-chart-series.ts 抽出，行为不变）
 *
 * 两条规则：
 * 1. 懒加载 prepend：用户正在看左侧历史时保持锚点（视口随增量右移）
 * 2. 数据到达 / 切品种：贴最新半空布局；bar 数量剧变也视为切品种
 */

import type { IChartApi } from "lightweight-charts"
import type { MutableRefObject } from "react"
import { scheduleHalfEmptyScroll, scrollToLatestHalfEmpty } from "../utils"

/** 视口维持所需的引用集合 */
export interface ScrollAnchorRefs {
  mainApiRef: MutableRefObject<IChartApi | null>
  isNearLatest: MutableRefObject<boolean>
  scrollTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  skipScrollRef: MutableRefObject<boolean>
  savedRangeRef: MutableRefObject<{ from: number; to: number } | null>
  prevBarsCountRef: MutableRefObject<number>
}

/**
 * currentBars 变化后的视口维持（在 setData 成功后调用）。
 * prevCount 为本次变化前的 bar 数。
 */
export function maintainViewportAfterData(
  refs: ScrollAnchorRefs,
  currentCount: number,
  prevCount: number,
): void {
  const { mainApiRef, isNearLatest, scrollTimerRef } = refs
  if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current)

  if (refs.skipScrollRef.current && refs.savedRangeRef.current) {
    // 懒加载 prepend：仅用户在看左侧历史时才保持锚点
    const chart = mainApiRef.current
    if (chart && !isNearLatest.current) {
      const delta = currentCount - prevCount
      if (delta > 0) {
        const saved = refs.savedRangeRef.current
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            chart.timeScale().setVisibleLogicalRange({
              from: saved.from + delta,
              to: saved.to + delta,
            })
          })
        })
      }
    } else if (chart && isNearLatest.current && currentCount > 0) {
      scrollToLatestHalfEmpty(chart, currentCount)
    }
    refs.skipScrollRef.current = false
    refs.savedRangeRef.current = null
    return
  }

  if (currentCount <= 0) return
  // 切品种 / 数据到达：贴最新时半空；bar 数量剧变也视为切品种
  const countJump =
    prevCount > 0 &&
    Math.abs(currentCount - prevCount) > Math.max(20, prevCount * 0.5)
  if (isNearLatest.current || prevCount === 0 || countJump) {
    isNearLatest.current = true
    const m = mainApiRef.current
    if (m) scrollToLatestHalfEmpty(m, currentCount)
    const cancel = scheduleHalfEmptyScroll(
      () => mainApiRef.current,
      currentCount,
      [0, 80, 250],
    )
    scrollTimerRef.current = setTimeout(() => {
      cancel()
      scrollTimerRef.current = null
    }, 400)
  }
}
