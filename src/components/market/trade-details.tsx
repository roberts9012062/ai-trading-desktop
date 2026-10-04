"use client"

import { withNumericReset } from "@/lib/numeric-input"
import { NumericInput } from "@/components/ui/numeric-input"
import { useState } from "react"
import { Filter, Settings } from "lucide-react"
import { cn } from "@/lib/utils"
import { marketTickDirectionLabel } from "@/lib/trade-labels"
import { useAppStore } from "@/stores/app"
import { useAuthStore } from "@/stores/auth"
import { useMarketStore } from "@/stores/market"
import {
  useBigOrderStore,
  isBigOrderHit,
  bigOrderColor,
  passesFilter,
  type BigOrderDirection,
} from "@/stores/big-order"
import { BigOrderSettingsDialog } from "./big-order-settings"

/**
 * 成交明细组件
 *
 * 复用于行情页盘口下方、交易页右栏与移动端盘口弹窗。
 * 顶部工具条含筛选按钮（方向/最小手数）与大单设置入口；
 * 命中用户阈值的大单行加粗并使用用户自选色高亮。
 */
export interface TradeDetailsProps {
  /** 列表容器的额外 className */
  listClassName?: string
}

export function TradeDetails({ listClassName }: TradeDetailsProps): React.JSX.Element {
  const { activeContract } = useAppStore()
  const tradingMode = useAuthStore((s) => s.user?.trading_mode ?? "live")
  const isVirtual = tradingMode === "virtual"
  const currentTrades = useMarketStore((s) =>
    activeContract ? s.trades[activeContract] : undefined,
  )
  // 兼容大小写 symbol 键
  const tradesAlt = useMarketStore((s) => {
    if (!activeContract) return undefined
    const lower = activeContract.toLowerCase()
    const upper = activeContract.toUpperCase()
    return s.trades[activeContract] ?? s.trades[lower] ?? s.trades[upper]
  })
  const rawList = currentTrades?.length ? currentTrades : tradesAlt
  const decimalPlaces = useMarketStore((s) =>
    activeContract ? (s.quotes[activeContract]?.decimal_places ?? 0) : 0,
  )

  const settings = useBigOrderStore((s) => s.settings)
  const filter = useBigOrderStore((s) => s.filter)
  const setFilter = useBigOrderStore((s) => s.setFilter)

  const [filterOpen, setFilterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // 筛选生效（含大单高亮判定）
  const list = rawList
    ? rawList.filter((t) =>
        passesFilter(
          t.direction as BigOrderDirection,
          t.volume,
          filter,
        ),
      )
    : rawList

  // 当前筛选是否激活（非默认值）
  const filterActive =
    filter.direction !== "all" || filter.minVolume > 0

  return (
    <div className="text-xs flex flex-col min-h-0">
      {/* 工具条：标题 + 筛选 + 设置 */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)] shrink-0">
        <span className="text-[var(--text-muted)]">
          成交{filterActive ? "（已筛选）" : ""}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            className={cn(
              "p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer",
              filterActive
                ? "text-[var(--primary)]"
                : "text-[var(--text-muted)]",
            )}
            aria-label="筛选成交"
            title="筛选"
          >
            <Filter className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] transition-colors cursor-pointer"
            aria-label="大单预警设置"
            title="大单预警设置"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 筛选面板（折叠） */}
      {filterOpen && (
        <div className="px-2 py-2 border-b border-[var(--border)] shrink-0 space-y-2 bg-[var(--bg-tertiary)]">
          <div className="flex items-center gap-1">
            <span className="text-[var(--text-muted)] mr-1">方向</span>
            {(
              [
                { v: "all", label: "全部" },
                { v: "buy", label: "多单" },
                { v: "sell", label: "空单" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setFilter({ direction: opt.v })}
                className={cn(
                  "px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer",
                  filter.direction === opt.v
                    ? "bg-[var(--primary)] text-white"
                    : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)]",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-muted)]">最小手数 ≥</span>
            <NumericInput
              type="number"
              min={0}
              value={filter.minVolume || ""}
              onChange={(e) => {
                const v = Number(e.target.value)
                setFilter({ minVolume: Number.isFinite(v) && v > 0 ? Math.floor(v) : 0 })
              }}
              placeholder="不限"
              className="h-6 w-16 px-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-xs"
            />
            {(filter.direction !== "all" || filter.minVolume > 0) && (
              <button
                type="button"
                onClick={withNumericReset(() => setFilter({ direction: "all", minVolume: 0 }))}
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                重置
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 px-2 py-1 text-[var(--text-muted)] border-b border-[var(--border)] shrink-0">
        <span>时间</span>
        <span className="text-right">价格</span>
        <span className="text-right">手数</span>
        <span className="text-right">方向</span>
      </div>

      {!list || list.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 min-h-[120px] text-[var(--text-muted)] text-xs gap-1 px-3 text-center">
          <span>{filterActive ? "无符合筛选条件的成交" : "暂无成交数据"}</span>
          <span className="text-[10px]">
            {!activeContract
              ? "请选择合约"
              : isVirtual
                ? "虚拟盘 7×24：等待最新价变动或成交量推送"
                : "等待成交量增量推送（开盘后有成交即显示）"}
          </span>
        </div>
      ) : (
        <div className={cn("overflow-auto", listClassName)}>
          {[...list].reverse().map((trade, i) => {
            const hit = isBigOrderHit(
              trade.direction as BigOrderDirection,
              trade.volume,
              settings,
            )
            const color = hit
              ? bigOrderColor(trade.direction as BigOrderDirection, settings)
              : undefined
            return (
              <div
                key={`${trade.time}-${trade.price}-${trade.volume}-${i}`}
                className={cn(
                  "grid grid-cols-4 px-2 py-1 hover:bg-[var(--bg-tertiary)]",
                  i === 0 && "animate-[fadeIn_0.3s_ease-in]",
                  hit && "font-bold",
                )}
                style={hit ? { color } : undefined}
              >
                <span
                  className={cn(
                    "font-num",
                    hit ? "" : "text-[var(--text-secondary)]",
                  )}
                >
                  {trade.time}
                </span>
                <span className="text-right font-num">
                  {Number(trade.price).toFixed(decimalPlaces)}
                </span>
                <span className="text-right font-num">
                  {trade.volume}
                </span>
                <span className="text-right">
                  {marketTickDirectionLabel(trade.direction)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <BigOrderSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
