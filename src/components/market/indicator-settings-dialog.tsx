"use client"

/**
 * 指标参数设置弹窗 —— 左参数 / 右示意图双栏（2026-08-31 示意图功能）
 *
 * 右栏为固定合成序列的迷你图：当前 tab 的指标按实时配置重算重绘；
 * 左侧字段聚焦时通过 onHighlight 令示意图中受影响图形呼吸闪烁。
 * 窄屏（<md）上下堆叠。内联的 ma/boll/macd/rsi 参数区已拆为独立 tab
 * 组件（与 jdk/pivot/strength 同构）。
 */

import { useCallback, useState } from "react"
import { useIndicatorStore } from "@/stores/indicator"
import type { IndicatorStoreHook } from "@/types/indicator"
import type { KlineBar, KlinePeriod } from "@/types"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { IndicatorBollTab } from "./indicator-boll-tab"
import { IndicatorJdkTab } from "./indicator-jdk-tab"
import { IndicatorMaTab } from "./indicator-ma-tab"
import { IndicatorMacdTab } from "./indicator-macd-tab"
import { IndicatorPivotTab } from "./indicator-pivot-tab"
import { IndicatorRsiTab } from "./indicator-rsi-tab"
import { IndicatorStrengthTab } from "./indicator-strength-tab"
import { IndicatorPreviewChart } from "./indicator-preview/preview-chart"

interface IndicatorSettingsDialogProps {
  open: boolean
  onClose: () => void
  /** 可选：指定 store hook；默认行情页全局，回测/AI 看盘页传入专用 store 隔离配置 */
  useStore?: IndicatorStoreHook
  /** 可选：真实 K 线（示意图优先用它渲染；缺省回落固定合成序列） */
  bars?: KlineBar[] | null
  /** 真实数据周期（时间轴归一口径） */
  period?: KlinePeriod
}

export function IndicatorSettingsDialog({
  open,
  onClose,
  useStore = useIndicatorStore as IndicatorStoreHook,
  bars,
  period,
}: IndicatorSettingsDialogProps): React.JSX.Element {
  const store = (useStore as typeof useIndicatorStore)()
  const [activeTab, setActiveTab] = useState("ma")
  const [highlight, setHighlight] = useState<{ key: string; seq: number } | null>(null)

  /** 字段聚焦 → 触发/重触发对应图形的闪烁（同键重复聚焦也会重闪） */
  const onHighlight = useCallback((key: string | null) => {
    setHighlight((prev) =>
      key ? { key, seq: (prev?.seq ?? 0) + 1 } : prev,
    )
  }, [])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>指标设置</DialogTitle>
          <DialogDescription>
            均线 / 布林带 / MACD / RSI / JDK / 强弱 / 波段：参数、颜色可自定义，修改即时生效；
            右侧示意图实时反映参数效果
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5 max-lg:grid-cols-1">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="min-w-0">
            <TabsList className="w-full flex-wrap h-auto gap-1">
              <TabsTrigger value="ma" className="flex-1">均线</TabsTrigger>
              <TabsTrigger value="boll" className="flex-1">布林带</TabsTrigger>
              <TabsTrigger value="macd" className="flex-1">MACD</TabsTrigger>
              <TabsTrigger value="rsi" className="flex-1">RSI</TabsTrigger>
              <TabsTrigger value="jdk" className="flex-1">JDK</TabsTrigger>
              <TabsTrigger value="strength" className="flex-1">强弱</TabsTrigger>
              <TabsTrigger value="pivot" className="flex-1">波段</TabsTrigger>
            </TabsList>

            <TabsContent value="ma">
              <IndicatorMaTab useStore={useStore} onHighlight={onHighlight} />
            </TabsContent>
            <TabsContent value="boll">
              <IndicatorBollTab useStore={useStore} onHighlight={onHighlight} />
            </TabsContent>
            <TabsContent value="macd">
              <IndicatorMacdTab useStore={useStore} onHighlight={onHighlight} />
            </TabsContent>
            <TabsContent value="rsi">
              <IndicatorRsiTab useStore={useStore} onHighlight={onHighlight} />
            </TabsContent>
            <TabsContent value="jdk">
              <IndicatorJdkTab useStore={useStore} onHighlight={onHighlight} />
            </TabsContent>
            <TabsContent value="strength">
              <IndicatorStrengthTab useStore={useStore} onHighlight={onHighlight} />
            </TabsContent>
            <TabsContent value="pivot">
              <IndicatorPivotTab useStore={useStore} onHighlight={onHighlight} />
            </TabsContent>
          </Tabs>

          <aside className="max-lg:hidden">
            <div className="sticky top-0">
              <IndicatorPreviewChart
                config={store.config}
                tab={activeTab}
                highlight={highlight}
                bars={bars}
                period={period}
              />
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
