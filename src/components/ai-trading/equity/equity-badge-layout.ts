/**
 * 收益图末端徽章：钉在「现在」时刻的精确价位
 * 允许多模型徽章重叠（不再强行错开，避免「亏越多越往上」的错觉）
 */

import type {
  IChartApi,
  ISeriesApi,
  LineData,
  Time,
} from "lightweight-charts"
import type { MutableRefObject } from "react"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { resolveSeriesColor } from "@/lib/provider-avatar"
import type { EndBadgeLayout } from "./equity-end-badges"
import {
  getTradeSessionRange,
  type EquityAxisMode,
} from "./equity-session"

/** 根据当前可见区计算各任务徽章坐标（严格按 value → Y，允许重叠） */
export function scheduleBadgeLayout(
  chartRef: MutableRefObject<IChartApi | null>,
  seriesMapRef: MutableRefObject<Map<string, ISeriesApi<"Line">>>,
  tasksRef: MutableRefObject<AITradingTask[]>,
  setBadges: (layouts: EndBadgeLayout[]) => void,
  axisMode: EquityAxisMode = "live",
): void {
  requestAnimationFrame(() => {
    const chart = chartRef.current
    if (!chart) return
    const ts = chart.timeScale()
    const layouts: EndBadgeLayout[] = []
    const list = tasksRef.current
    const sessionNow = getTradeSessionRange(Date.now(), axisMode)
    const nowT = sessionNow.nowSec as Time

    for (const [taskId, line] of seriesMapRef.current) {
      const data = line.data() as LineData[]
      if (!data.length) continue
      const nowPt =
        data.find((d) => (d.time as number) === sessionNow.nowSec) ??
        data[data.length - 1]
      // X 钉在「现在」；Y 严格按当前浮盈价位，不做防碰撞偏移
      const x = ts.timeToCoordinate(nowT) ?? ts.timeToCoordinate(nowPt.time)
      const y = line.priceToCoordinate(nowPt.value)
      if (x === null || y === null) continue

      const task = list.find((t) => t.id === taskId)
      const color = task
        ? resolveSeriesColor(
            task.model_id,
            task.provider_name,
            task.model_display_name,
            0,
          )
        : "#3b82f6"
      layouts.push({
        taskId,
        left: x as number,
        top: y as number,
        value: nowPt.value,
        color,
      })
    }

    // 收益高的画在上层，重叠时仍能看到领先者
    layouts.sort((a, b) => a.value - b.value)
    setBadges(layouts)
  })
}
