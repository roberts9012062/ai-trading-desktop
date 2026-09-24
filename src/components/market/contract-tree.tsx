"use client"

import { useState, useMemo, memo } from "react"
import { cn, formatPrice } from "@/lib/utils"
import { useMarketStore } from "@/stores/market"
import type { CodeTreeMap, CodeTree, ContractItem } from "@/types"
import type { QuoteData } from "@/lib/websocket"

/** 闪烁动画标记条目(seq 变化触发 CSS 动画重播) */
type FlashEntry = { seq: number; direction: "up" | "down" }

/** 主力徽章:红色背景 "主" */
function MasterBadge(): React.JSX.Element {
  return (
    <span className="inline-flex items-center justify-center w-4 h-4 rounded text-[10px] font-bold bg-red-500 text-white">
      主
    </span>
  )
}

/** 次主力徽章:橙色背景 "次" */
function SecondaryBadge(): React.JSX.Element {
  return (
    <span className="inline-flex items-center justify-center w-4 h-4 rounded text-[10px] font-bold bg-orange-500 text-white">
      次
    </span>
  )
}

/** 价格区域:两行 last_price + change_pct,涨红跌绿(与扁平视图视觉一致) */
const QuoteDisplay = memo(function QuoteDisplay({
  quote,
}: {
  quote: QuoteData | undefined
}): React.JSX.Element | null {
  // 无 quote 数据时隐藏价格区域(冷门月份合约常见)
  if (!quote) return null
  const isUp = quote.change >= 0
  return (
    <div className="text-right">
      <div className={cn("font-num text-xs font-medium", isUp ? "text-up" : "text-down")}>
        {formatPrice(quote.last_price, quote.decimal_places)}
      </div>
      <div className={cn("font-num text-[10px]", isUp ? "text-up" : "text-down")}>
        {isUp ? "+" : ""}
        {quote.change_pct.toFixed(2)}%
      </div>
    </div>
  )
})

/** 闪烁动画遮罩:绝对定位铺满父级(父级需加 relative) */
function FlashOverlay({ flash }: { flash: FlashEntry | undefined }): React.JSX.Element | null {
  if (!flash) return null
  return (
    <span
      key={flash.seq}
      className={cn(
        "absolute inset-0 pointer-events-none",
        flash.direction === "up" ? "flash-up" : "flash-down",
      )}
    />
  )
}

/** 计算交割月份标签:当年显示"X月交割",次年显示"次年X月交割" */
function formatMonthLabel(year: number, month: number, now: Date): string {
  const curYear = now.getFullYear()
  if (year === curYear) {
    return `${month}月交割`
  }
  return `次年${month}月交割`
}

/** 格式化成交量(简化为 K/W 单位) */
function formatVolume(vol: number): string {
  if (vol >= 10000) return `${(vol / 10000).toFixed(1)}万`
  if (vol >= 1000) return `${(vol / 1000).toFixed(1)}K`
  return String(vol)
}

/** 三级菜单单个合约项(memo 优化:仅自身 quote/flash 变化时重渲染) */
const ContractItemRow = memo(function ContractItemRow({
  item,
  active,
  now,
  onSelect,
}: {
  item: ContractItem
  active: boolean
  now: Date
  onSelect: (symbol: string) => void
}): React.JSX.Element {
  // 直接订阅该 symbol 的 quote/flash 切片,zustand 浅比较确保只在该项数据变化时重渲染
  const quote = useMarketStore((s) => s.quotes[item.symbol])
  const flash = useMarketStore((s) => s.flashMap[item.symbol])

  return (
    <button
      onClick={() => onSelect(item.symbol)}
      className={cn(
        "w-full flex items-center gap-2 px-8 py-1 text-left hover:bg-[var(--bg-tertiary)] relative",
        active && "bg-[var(--primary)]/10",
      )}
    >
      <FlashOverlay flash={flash} />
      <span
        className={cn(
          "text-xs",
          active ? "text-[var(--primary)] font-bold" : "text-[var(--text)]",
        )}
      >
        {item.symbol}
      </span>
      {item.month > 0 && (
        <span className="text-[10px] text-[var(--text-muted)]">
          {formatMonthLabel(item.year, item.month, now)}
        </span>
      )}
      <span className="text-[10px] text-[var(--text-muted)]">
        {formatVolume(item.volume)}
      </span>
      {/* 价格区域 + 主力/次主力徽章统一靠右 */}
      <div className="ml-auto flex items-center gap-1">
        <QuoteDisplay quote={quote} />
        {item.is_master && <MasterBadge />}
        {item.is_secondary && <SecondaryBadge />}
      </div>
    </button>
  )
})

/** 单个品种节点(一级 + 二级 + 三级) */
function CodeTreeNode({
  code,
  tree,
  activeContract,
  onSelect,
}: {
  code: string
  tree: CodeTree
  activeContract: string
  onSelect: (symbol: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // now 仅在挂载时取一次,避免每次渲染生成新引用导致 ContractItemRow 全部重渲染
  const now = useMemo(() => new Date(), [])

  // 二级显示的主力合约(取 tree.master,若无则取 contracts[0])
  const masterSymbol = tree.master ?? tree.contracts[0]?.symbol
  const masterContract = tree.contracts.find((c) => c.symbol === masterSymbol)
  const isActive = activeContract === masterSymbol
  // 主力合约行情订阅(仅该 symbol 切片)
  const masterQuote = useMarketStore((s) =>
    masterSymbol ? s.quotes[masterSymbol] : undefined,
  )
  const masterFlash = useMarketStore((s) =>
    masterSymbol ? s.flashMap[masterSymbol] : undefined,
  )

  return (
    <div className="border-b border-[var(--border)]">
      {/* 一级:品种类型 */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)]"
      >
        <span className={cn("transition-transform", expanded ? "rotate-90" : "")}>▶</span>
        <span className="text-xs font-bold text-[var(--text)]">{code}</span>
        <span className="text-xs text-[var(--text-muted)]">{tree.name}</span>
        <span className="ml-auto text-[10px] text-[var(--text-muted)]">{tree.exchange}</span>
      </button>

      {expanded && (
        <div className="bg-[var(--bg-secondary)]">
          {/* 二级:主力合约(默认高亮,▲ 折叠三级) */}
          {masterContract && (
            <div className="flex items-center">
              <button
                onClick={() => onSelect(masterContract.symbol)}
                className={cn(
                  "flex-1 flex items-center gap-1 px-6 py-1.5 text-left hover:bg-[var(--bg-tertiary)] relative",
                  isActive && "bg-[var(--primary)]/10",
                )}
              >
                <FlashOverlay flash={masterFlash} />
                <span
                  className={cn(
                    "text-xs",
                    isActive ? "text-[var(--primary)] font-bold" : "text-[var(--text)]",
                  )}
                >
                  {masterContract.symbol}
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">主力</span>
                <div className="ml-auto flex items-center gap-1">
                  <QuoteDisplay quote={masterQuote} />
                  <MasterBadge />
                </div>
              </button>
              <button
                onClick={() => setExpanded(false)}
                className="px-3 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--primary)]"
                title="折叠三级"
              >
                ▲
              </button>
            </div>
          )}

          {/* 三级:全部交割月份合约 */}
          <div className="max-h-60 overflow-y-auto">
            {tree.contracts.map((c) => (
              <ContractItemRow
                key={c.symbol}
                item={c}
                active={activeContract === c.symbol}
                now={now}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 三级品种浏览器主组件 */
export function ContractTree({
  data,
  activeContract,
  onSelect,
}: {
  data: CodeTreeMap
  activeContract: string
  onSelect: (symbol: string) => void
}): React.JSX.Element {
  const codes = useMemo(() => Object.keys(data).sort(), [data])

  if (codes.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-[var(--text-muted)]">
        加载中...
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      {codes.map((code) => (
        <CodeTreeNode
          key={code}
          code={code}
          tree={data[code]}
          activeContract={activeContract}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
