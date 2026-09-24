"use client"

import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { marketTickDirectionLabel } from "@/lib/trade-labels"
import { useAppStore } from "@/stores/app"
import {
  getTradeTicksApi,
  type TradeTickDTO,
} from "@/lib/api"
import { useBigOrderStore } from "@/stores/big-order"
import { contractName } from "@/lib/contract-names"

/**
 * 大单历史 —— 全市场逐秒成交查询（在某品种内按方向/手数过滤）
 *
 * 数据源：后端 trade_tick 表（scheduler 每秒全量落库，每晚 20:30 清空）。
 * 必须选定品种；方向/最小手数为查询过滤条件。
 */

export function BigOrderHistory(): React.JSX.Element {
  const { activeContract } = useAppStore()
  const settings = useBigOrderStore((s) => s.settings)

  const [direction, setDirection] = useState<"all" | "buy" | "sell">("all")
  const [minVolume, setMinVolume] = useState<number>(0)
  const [ticks, setTicks] = useState<TradeTickDTO[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!activeContract) {
      setTicks([])
      return
    }
    setLoading(true)
    try {
      const data = await getTradeTicksApi({
        symbol: activeContract,
        direction: direction === "all" ? undefined : direction,
        min_volume: minVolume > 0 ? minVolume : undefined,
        limit: 1000,
      })
      setTicks(data)
    } catch {
      setTicks([])
    } finally {
      setLoading(false)
    }
  }, [activeContract, direction, minVolume])

  // 筛选/合约变化时刷新
  useEffect(() => {
    void refresh()
  }, [refresh])

  // 每 30s 刷新一次（兜底新成交与 20:30 清空）
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  const filterActive = direction !== "all" || minVolume > 0

  return (
    <div className="text-xs flex flex-col h-full">
      {/* 工具条 */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] shrink-0 flex-wrap">
        <div className="flex items-center gap-1">
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
              onClick={() => setDirection(opt.v)}
              className={cn(
                "px-1.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer",
                direction === opt.v
                  ? "bg-[var(--primary)] text-white"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)]",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[var(--text-muted)]">≥</span>
          <input
            type="number"
            min={0}
            value={minVolume || ""}
            onChange={(e) => {
              const v = Number(e.target.value)
              setMinVolume(Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
            }}
            placeholder="手"
            className="h-5 w-12 px-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[11px]"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setDirection("all")
            setMinVolume(0)
          }}
          disabled={!filterActive}
          className="px-1.5 py-0.5 rounded text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] cursor-pointer disabled:opacity-40"
        >
          筛选
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] transition-colors cursor-pointer disabled:opacity-50"
          aria-label="刷新"
          title="刷新"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
        <span className="ml-auto text-[10px] text-[var(--text-muted)]">
          {activeContract ? contractName(activeContract) : "未选品种"} ·{" "}
          {ticks.length} 笔{filterActive ? "（已筛选）" : ""}
        </span>
      </div>

      {/* 表头 */}
      <div className="grid grid-cols-4 px-2 py-1 text-[var(--text-muted)] border-b border-[var(--border)] shrink-0">
        <span>时间</span>
        <span className="text-right">方向</span>
        <span className="text-right">手数</span>
        <span className="text-right">价格</span>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {!activeContract ? (
          <div className="flex flex-col items-center justify-center h-[160px] text-[var(--text-muted)] gap-1 text-center">
            <span>请先选择品种</span>
          </div>
        ) : ticks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[160px] text-[var(--text-muted)] gap-1 text-center">
            <span>{loading ? "加载中…" : "暂无成交"}</span>
            <span className="text-[10px]">
              开盘后逐秒成交会在此展示，每晚 20:30 清空
            </span>
          </div>
        ) : (
          ticks.map((t) => {
            const isBuy = t.direction === "buy"
            const isSell = t.direction === "sell"
            // 命中用户阈值的大单用自选色加粗
            const hit =
              (isBuy && t.volume >= settings.buy_threshold) ||
              (isSell && t.volume >= settings.sell_threshold)
            const color = isBuy
              ? settings.buy_color
              : isSell
                ? settings.sell_color
                : undefined
            return (
              <div
                key={t.id}
                className={cn(
                  "grid grid-cols-4 px-2 py-1 hover:bg-[var(--bg-tertiary)]",
                  hit && "font-bold",
                )}
                style={hit && color ? { color } : undefined}
              >
                <span className="font-num text-[var(--text-secondary)]">
                  {t.occurred_at.slice(11, 19)}
                </span>
                <span
                  className="text-right"
                  style={color ? { color } : undefined}
                >
                  {t.direction ? marketTickDirectionLabel(t.direction as "buy" | "sell") : "—"}
                </span>
                <span className="text-right font-num">{t.volume}</span>
                <span className="text-right font-num text-[var(--text-secondary)]">
                  {t.price || "—"}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
