"use client"

/**
 * K 线工作区：分屏切换（1/2/3/4）+ 全屏 + 右栏收起联动
 *
 * - 分屏 1/2/3/4：布局见 SPLIT_PANE_CLASS；每个分屏独立周期（KlineChart
 *   内部 state 天然按实例隔离）+ 独立指标 store（分屏 1 用全局 store，
 *   分屏 2-4 用 market-pane-indicator 的隔离 store，设置互不干扰）。
 * - 全屏由父页面控制：本组件只渲染工具条与分屏网格，全屏时父容器
 *   以 fixed inset-0 覆盖整页（ESC 退出逻辑也在父页面）。
 */

import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { KlineChart } from "./kline/kline-chart"
import { useIndicatorStore } from "@/stores/indicator"
import {
  useMarketPane2IndicatorStore,
  useMarketPane3IndicatorStore,
  useMarketPane4IndicatorStore,
} from "@/stores/market-pane-indicator"

/** 分屏数量 */
export type KlineSplitMode = 1 | 2 | 3 | 4

/** 分屏 n → 指标 store：分屏 1 用全局 store（服务端同步），2-4 隔离 */
const PANE_INDICATOR_STORES = [
  useIndicatorStore,
  useMarketPane2IndicatorStore,
  useMarketPane3IndicatorStore,
  useMarketPane4IndicatorStore,
] as const

/** 分屏布局网格类（3 分屏 = 左侧大图跨两行 + 右侧上下两个） */
const SPLIT_GRID_CLASS: Record<KlineSplitMode, string> = {
  1: "grid-cols-1 grid-rows-1",
  2: "grid-cols-2 grid-rows-1",
  3: "grid-cols-2 grid-rows-2",
  4: "grid-cols-2 grid-rows-2",
}

/** 每个分屏的定位/分隔线类（按索引；分隔线用 border 避免双线） */
const SPLIT_PANE_CLASS: Record<KlineSplitMode, string[]> = {
  1: [""],
  2: ["", "border-l border-[var(--border)]"],
  3: [
    "row-span-2",
    "border-l border-[var(--border)]",
    "border-l border-t border-[var(--border)]",
  ],
  4: [
    "",
    "border-l border-[var(--border)]",
    "border-t border-[var(--border)]",
    "border-l border-t border-[var(--border)]",
  ],
}

export interface KlineWorkspaceProps {
  splitMode: KlineSplitMode
  onSplitModeChange: (mode: KlineSplitMode) => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  /** 右栏（盘口/成交）收起状态与切换；全屏时不显示该按钮 */
  rightPanelCollapsed?: boolean
  onToggleRightPanel?: () => void
}

/** 分屏网格 + 工具条（分屏切换 / 右栏收起 / 全屏） */
export function KlineWorkspace({
  splitMode,
  onSplitModeChange,
  fullscreen,
  onToggleFullscreen,
  rightPanelCollapsed,
  onToggleRightPanel,
}: KlineWorkspaceProps): React.JSX.Element {
  const splitOptions: KlineSplitMode[] = [1, 2, 3, 4]

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs text-[var(--text-muted)]">分屏</span>
          {splitOptions.map((n) => (
            <button
              key={n}
              onClick={() => onSplitModeChange(n)}
              title={`${n} 分屏`}
              className={cn(
                "h-6 w-6 rounded text-xs font-medium transition-colors cursor-pointer",
                splitMode === n
                  ? "bg-[var(--primary)] text-white"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]",
              )}
            >
              {n}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          {!fullscreen && onToggleRightPanel && (
            <button
              onClick={onToggleRightPanel}
              title={rightPanelCollapsed ? "展开右栏" : "收起右栏"}
              className="hidden h-6 w-6 items-center justify-center rounded text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] cursor-pointer xl:flex"
            >
              {rightPanelCollapsed ? (
                <PanelRightOpen className="h-3.5 w-3.5" />
              ) : (
                <PanelRightClose className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            onClick={onToggleFullscreen}
            title={fullscreen ? "退出全屏（ESC）" : "K 线全屏"}
            className={cn(
              "flex h-6 items-center gap-1 rounded px-2 text-xs transition-colors cursor-pointer",
              fullscreen
                ? "bg-[var(--primary)] text-white"
                : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]",
            )}
          >
            {fullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
            {fullscreen ? "退出全屏" : "全屏"}
          </button>
        </div>
      </div>

      <div className={cn("grid min-h-0 flex-1", SPLIT_GRID_CLASS[splitMode])}>
        {Array.from({ length: splitMode }, (_, i) => (
          <div
            key={i}
            className={cn("min-h-0 min-w-0", SPLIT_PANE_CLASS[splitMode][i])}
          >
            <KlineChart
              indicatorStore={PANE_INDICATOR_STORES[i]}
              syncGlobalPeriod={i === 0}
              compact={splitMode > 1}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
