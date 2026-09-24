"use client"

import { TaskIcon } from "@/components/ai-trading/task-icon"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { resolveSeriesColor } from "@/lib/provider-avatar"
import { cn } from "@/lib/utils"

export interface EndBadgeLayout {
  taskId: string
  left: number
  top: number
  value: number
  color: string
}

interface EquityEndBadgesProps {
  tasks: AITradingTask[]
  layouts: EndBadgeLayout[]
  chartHeight: number
  chartWidth: number
  highlightTaskId: string | null
}

function formatMoney(v: number): string {
  const abs = Math.abs(v)
  const sign = v >= 0 ? "+" : "-"
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(2)}万`
  if (abs >= 1000) {
    return `${sign}${abs.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`
  }
  return `${sign}${abs.toFixed(2)}`
}

/** 收益文字宽度（略放宽，避免挤出头像） */
function moneyWidth(text: string): number {
  return Math.max(40, Math.ceil(text.length * 7.8))
}

const AVATAR = 18
const BADGE_H = 26
/** 左右内边距：与圆角匹配，头像完整落在胶囊内 */
const PAD_X = Math.max(5, Math.round((BADGE_H - AVATAR) / 2))
const GAP = 4
/** 右侧价格轴预留，防止徽章压住刻度/出界 */
const RIGHT_AXIS_PAD = 58
const EDGE = 6
/** 相对曲线端点略上移，避免视觉上偏下挡线 */
const Y_NUDGE = 2

/**
 * 曲线末端徽章：
 *   [ +8,000 ][ DV ]
 *   收益在左 · 头像在右（贴曲线端点）
 *
 * 整块徽章落在端点左侧，不向右越界。
 */
export function EquityEndBadges({
  tasks,
  layouts,
  chartHeight,
  chartWidth,
  highlightTaskId,
}: EquityEndBadgesProps): React.JSX.Element {
  const taskMap = new Map(tasks.map((t) => [t.id, t]))

  let leaderId: string | null = null
  let leaderVal = -Infinity
  for (const lay of layouts) {
    if (lay.value > leaderVal) {
      leaderVal = lay.value
      leaderId = lay.taskId
    }
  }

  // 可放置区域右边界（避开价格轴）
  const plotRight = Math.max(
    120,
    chartWidth - RIGHT_AXIS_PAD - EDGE,
  )

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ height: chartHeight }}
    >
      {layouts.map((lay, index) => {
        const task = taskMap.get(lay.taskId)
        if (!task) return null
        const color =
          lay.color ||
          resolveSeriesColor(
            task.model_id,
            task.provider_name,
            task.model_display_name,
            0,
          )
        const isLeader = lay.taskId === leaderId
        const isHighlight =
          highlightTaskId != null && lay.taskId === highlightTaskId
        const isDimmed =
          highlightTaskId != null && lay.taskId !== highlightTaskId

        const money = formatMoney(lay.value)
        const textW = moneyWidth(money)
        const badgeW = PAD_X + textW + GAP + AVATAR + PAD_X

        // 端点 X：徽章右缘对齐端点（略左偏 2px），整体向左展开
        const tipX = lay.left
        let left = tipX - badgeW + 2
        // 夹在图表内容区内
        left = Math.min(left, plotRight - badgeW)
        left = Math.max(EDGE, left)

        // 垂直：徽章中心对齐曲线端点，再整体上移 Y_NUDGE，避免头像视觉偏下挡线
        const top = Math.max(
          EDGE,
          Math.min(
            chartHeight - BADGE_H - EDGE,
            lay.top - BADGE_H / 2 - Y_NUDGE,
          ),
        )

        return (
          <div
            key={lay.taskId}
            className={cn(
              "absolute transition-[left,top,opacity,transform] duration-300 ease-out",
              isDimmed && "opacity-30",
              isHighlight && "scale-[1.04]",
            )}
            style={{
              left,
              top,
              width: badgeW,
              height: BADGE_H,
              zIndex: isHighlight ? 40 : isLeader ? 30 : 10 + index,
            }}
            title={`${task.model_display_name || task.name}: ${money}`}
          >
            <div
              className={cn(
                "h-full w-full rounded-full border shadow-md",
                "box-border bg-[var(--bg-secondary)]",
                "overflow-hidden",
              )}
              style={{
                display: "flex",
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "flex-start",
                paddingLeft: PAD_X,
                paddingRight: PAD_X,
                gap: GAP,
                borderColor: isHighlight || isLeader ? color : `${color}66`,
                boxShadow:
                  isHighlight || isLeader
                    ? `0 0 14px ${color}45, 0 2px 8px rgba(0,0,0,0.35)`
                    : `0 2px 6px rgba(0,0,0,0.4)`,
              }}
            >
              {/* 左：收益（leading-none 避免基线把头像顶偏） */}
              <span
                className="font-num text-[11px] font-bold tabular-nums tracking-tight whitespace-nowrap"
                style={{
                  color,
                  minWidth: textW,
                  lineHeight: 1,
                  display: "flex",
                  alignItems: "center",
                  height: AVATAR,
                }}
              >
                {money}
              </span>
              {/* 右：头像垂直居中，不溢出胶囊 */}
              <span
                className="shrink-0 rounded-full overflow-hidden"
                style={{
                  width: AVATAR,
                  height: AVATAR,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 0,
                }}
              >
                <TaskIcon
                  icon={task.icon}
                  strategyType={task.strategy_type}
                  modelId={task.model_id}
                  providerName={task.provider_name}
                  displayName={task.model_display_name}
                  size={AVATAR}
                />
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
