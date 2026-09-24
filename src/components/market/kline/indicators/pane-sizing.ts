/**
 * 副图 pane 高度分配 + 主图价格轴边距（lightweight-charts v5 原生 panes）
 *
 * v5.2 提供 setStretchFactor（比例分配），pane 高度随容器自适应，
 * 无需像素 setHeight + resize 重算。各副图占比沿用重构前
 * scaleMargins 切分的口径（1 副图 26% / 2 各 20% / 3 各 15%），
 * 保证迁移前后观感一致。
 */

import type { IChartApi } from "lightweight-charts"

/** 各普通副图占容器高度的比例（主图保留剩余比例，至少约 48%） */
function subPaneRatio(count: number): number {
  if (count <= 1) return 0.26
  if (count === 2) return 0.2
  if (count === 3) return 0.15
  return 0.12
}

/**
 * 强弱（V1/V2）副图占比：箭头轴边距占上下各 30%，蜡烛实际只占 pane 的
 * 40%——按普通占比（26%×40%≈容器 10%）形态趋同分不清（用户 2026-09-01
 * 验收反馈「柱子太短、看起来都一样」），整体拉长一档。
 */
function strengthPaneRatio(subCount: number): number {
  if (subCount <= 1) return 0.42
  if (subCount === 2) return 0.34
  if (subCount === 3) return 0.3
  return 0.26
}

/** 主图顶部默认留白（箭头+文字高度） */
const MAIN_TOP_DEFAULT = 0.04
/** 开启波段标记时顶部留白加大：「空」等 aboveBar 标记防贴顶裁切 */
const MAIN_TOP_PIVOT = 0.1
/** 成交量叠加区在主图底部：数据映射到主图高度的 [VOLUME_TOP, 1] */
const VOLUME_TOP = 0.8

/**
 * 主图 right 价格轴边距：只保留顶部留白。
 * 副图已独立成 pane，不再通过 mainBottom 挤压主图。
 */
export function mainScaleMargins(pivot: boolean): { top: number; bottom: number } {
  return { top: pivot ? MAIN_TOP_PIVOT : MAIN_TOP_DEFAULT, bottom: 0 }
}

/** 成交量 overlay 轴边距（贴主图底部） */
export function volumeScaleMargins(): { top: number; bottom: number } {
  return { top: VOLUME_TOP, bottom: 0 }
}

/** 副图 overlay 轴边距：铺满所在 pane（等价重构前副图占满自己的槽位） */
export function subScaleMargins(): { top: number; bottom: number } {
  return { top: 0, bottom: 0 }
}

/**
 * 带双向箭头的副图轴边距（强弱 V2 用）：上下各留 30% 给箭头+文字。
 * 副图只有主图的约一半高，15% 的绝对像素仍画不下贴边信号
 * （「顶部」aboveBar / 低位 10–15 的「底部」belowBar 均被裁）——
 * 用户验收要求底部间距至少加倍，取上下对称 30%，蜡烛区中段 40%。
 */
export function subScaleMarginsArrowPad(): { top: number; bottom: number } {
  return { top: 0.3, bottom: 0.3 }
}

/** 应用主图 right 轴边距（波段标记开启时加大顶部留白） */
export function applyMainScaleMargins(
  chart: IChartApi,
  pivot: boolean,
): void {
  chart.priceScale("right").applyOptions({ scaleMargins: mainScaleMargins(pivot) })
}

/**
 * 按启用副图分配各 pane 高度比例，并统一 pane 分隔线样式。
 * pane 0 是主图；本函数须在全部副图 pane 创建完成后调用一次。
 * 强弱副图（id = strength / strengthV2）按 strengthPaneRatio 拉长，
 * 普通副图在有强弱同屏时打 8 折让位，主图保持约一半。
 * 分隔线允许拖拽：用户可上下拖动自行调整各窗口长短
 * （用户 2026-09-01 验收要求），切换指标重建 pane 后回到默认比例。
 */
export function applyPaneLayout(
  chart: IChartApi,
  subIds: readonly string[],
): void {
  const panes = chart.panes()
  const main = panes[0]
  if (!main) return
  chart.applyOptions({
    layout: {
      panes: {
        enableResize: true,
        separatorColor: "#3a3a40",
        separatorHoverColor: "rgba(178, 181, 189, 0.2)",
      },
    },
  })
  const total = subIds.length
  const hasStrength = subIds.some((id) => id === "strength" || id === "strengthV2")
  const normalRatio =
    total > 0 ? subPaneRatio(total) * (hasStrength ? 0.8 : 1) : 0
  const strengthRatio = hasStrength ? strengthPaneRatio(total) : 0
  const subTotal = normalRatio * (total - (hasStrength ? 1 : 0)) + strengthRatio
  main.setStretchFactor(Math.max(1 - subTotal, 0.4))
  for (let i = 1; i < panes.length; i++) {
    const id = subIds[i - 1]
    const isStrength = id === "strength" || id === "strengthV2"
    panes[i].setStretchFactor(isStrength ? strengthRatio : normalRatio)
  }
}
