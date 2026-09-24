"use client";

/**
 * AI 主播K线图解弹窗 —— 蜡烛图 + AI 结论虚线价位 + 买卖区域色带
 *
 * 数据为主播配置的品种/周期最新 bar_count 根快照;「AI画线测试」用
 * 真实K线合成示例结论(不调模型),完整演示止盈止损线/买卖区域/压力支撑位。
 * 画图核心在 AnchorChartRender(与 AI 对话内嵌图表共用)。
 */

import { useMemo } from "react"
import { useAiAnchorStore } from "@/stores/ai-anchor"
import type { AnchorBroadcast } from "@/lib/ai-anchor-api"
import {
  broadcastToAnnotations,
  buildTestAnnotations,
} from "./anchor-chart-annotations"
import { AnchorChartRender } from "./anchor-chart-render"
import { formatBroadcastTime } from "./anchor-broadcast-card"
import { useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

interface AnchorChartDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 图例条目 */
const LEGEND: Array<{ color: string; label: string }> = [
  { color: "#f59e0b", label: "进场" },
  { color: "#22c55e", label: "止盈" },
  { color: "#ef4444", label: "止损" },
  { color: "#fb923c", label: "压力位" },
  { color: "#60a5fa", label: "支撑位" },
]

const ZONE_LEGEND: Array<{ color: string; label: string }> = [
  { color: "rgba(245,158,11,0.35)", label: "买入区" },
  { color: "rgba(34,197,94,0.30)", label: "止盈区" },
]

export function AnchorChartDialog({
  open,
  onOpenChange,
}: AnchorChartDialogProps): React.JSX.Element {
  const task = useAiAnchorStore((s) => s.task)
  const broadcasts = useAiAnchorStore((s) => s.broadcasts)
  // 画线取"最近一条带价位"的播报:最新播报可能是观望未给价位/模型失败,
  // 此时回退画最近带价位的结论(时间标签如实标注),避免"看不到AI画线"
  const annotated = broadcasts.find(
    (item) =>
      !item.model_error &&
      (item.entry != null ||
        item.take_profit != null ||
        item.stop_loss != null ||
        (item.key_levels ?? []).length > 0),
  )
  const latest = broadcasts.length > 0 ? broadcasts[0] : undefined
  const [testMode, setTestMode] = useState(false)

  const symbol = task?.symbol ?? ""
  const timeframe = task?.timeframe ?? ""
  const barCount = task?.bar_count ?? 60

  const useDemo = testMode || !annotated
  // demo 模式(测试开关/无带价位播报)用真实K线现场合成示例结论;
  // 真实模式直接转换播报结论。useMemo 稳定引用,配合 reloadKey 避免图表重建
  const annotations = useMemo(
    () => (!useDemo && annotated ? broadcastToAnnotations(annotated) : null),
    [useDemo, annotated],
  )
  const demoBuilder = useMemo(() => (useDemo ? buildTestAnnotations : null), [useDemo])

  // 回退提示:画的是较早的带价位播报(最新一条无价位)
  const isFallback = !testMode && Boolean(annotated && latest && annotated.id !== latest.id)
  // 无真实价位播报时自动展示示例标注(打开即画,无需手点测试)
  const autoDemo = !testMode && !annotated
  const showDemo = testMode || autoDemo

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[92vw] h-[76vh] p-0 flex flex-col gap-0">
        <div className="shrink-0 px-4 py-3 border-b border-[var(--border)] space-y-1.5">
          <DialogTitle className="text-sm text-[var(--text-primary)] pr-8">
            K线图解 · {symbol.toUpperCase()} {timeframe}
            {showDemo && (
              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-[var(--primary)]/15 text-[var(--primary)]">
                {testMode ? "AI画线测试 · 示例数据" : "示例标注 · 暂无带价位播报"}
              </span>
            )}
            {!showDemo && annotated && (
              <span className="ml-2 text-[10px] font-normal text-[var(--text-muted)]">
                {formatBroadcastTime(annotated.created_at)} 播报
                {isFallback && "(最近带价位,最新一条未给价位)"}
              </span>
            )}
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {LEGEND.map((item) => (
              <span
                key={item.label}
                className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]"
              >
                <span
                  className="inline-block w-4 h-0"
                  style={{ borderTop: `1px dashed ${item.color}` }}
                />
                {item.label}
              </span>
            ))}
            {showDemo &&
              ZONE_LEGEND.map((item) => (
                <span
                  key={item.label}
                  className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]"
                >
                  <span
                    className="inline-block w-3 h-2.5 rounded-sm"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.label}
                </span>
              ))}
            {/* 测试开关放图例行末尾：避开右上角关闭按钮(X 绝对定位) */}
            <button
              type="button"
              onClick={() => setTestMode((v) => !v)}
              className={
                "ml-auto shrink-0 px-2.5 h-6 rounded text-[11px] border cursor-pointer transition-colors " +
                (testMode
                  ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              AI画线测试
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {open && (
            <AnchorChartRender
              symbol={symbol}
              period={timeframe}
              limit={barCount}
              annotations={annotations}
              buildAnnotations={demoBuilder ?? undefined}
              reloadKey={`${useDemo}-${annotated?.id ?? ""}`}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
