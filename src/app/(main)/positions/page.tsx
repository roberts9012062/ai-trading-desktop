"use client"

import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { useMarketStore } from "@/stores/market"
import { usePaperTradingStore } from "@/stores/paper-trading"
import { useAITradingStore } from "@/stores/ai-trading"
import { showAlert } from "@/stores/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { Search, Loader2 } from "lucide-react"
import type { PaperPositionItem } from "@/lib/paper-api"

type Source = "manual" | "ai" | "quant"

const SOURCE_CFG: Record<string, { label: string; cls: string }> = {
  manual: { label: "手动", cls: "bg-white/5 text-[var(--text-muted)]" },
  ai: { label: "AI", cls: "bg-sky-500/15 text-sky-300" },
  quant: { label: "量化", cls: "bg-amber-500/15 text-amber-300" },
}

function calcPnl(pos: PaperPositionItem, current: number) {
  if (current <= 0 || pos.avg_price <= 0) return { pnl: 0, pct: 0 }
  const mult = pos.multiplier || 10
  const pnl =
    pos.direction === "long"
      ? (current - pos.avg_price) * pos.quantity * mult
      : (pos.avg_price - current) * pos.quantity * mult
  const cost = pos.avg_price * pos.quantity * mult
  return { pnl, pct: cost > 0 ? (pnl / cost) * 100 : 0 }
}

/** 平仓 ai/quant 仓后，反查 running 任务并停止 */
function findRunningTask(
  tasks: { id: string; symbol: string; status: string; strategy_type?: string }[],
  symbol: string,
  source: string,
) {
  const sym = symbol.toLowerCase()
  return tasks.find(
    (t) =>
      (t.symbol || "").toLowerCase() === sym &&
      t.status === "running" &&
      (source === "ai"
        ? (t.strategy_type || "ai") === "ai"
        : (t.strategy_type || "ai") !== "ai"),
  )
}

/** 持仓管理 —— 按 手动/AI/量化 三类展示；平仓 AI/量化仓即停任务 */
export default function PositionsPage(): React.JSX.Element {
  const positions = usePaperTradingStore((s) => s.positions)
  const loading = usePaperTradingStore((s) => s.loading)
  const submitting = usePaperTradingStore((s) => s.submitting)
  const refresh = usePaperTradingStore((s) => s.refresh)
  const closePosition = usePaperTradingStore((s) => s.closePosition)
  const quotes = useMarketStore((s) => s.quotes)
  const tasks = useAITradingStore((s) => s.tasks)
  const loadTasks = useAITradingStore((s) => s.loadTasks)
  const stopTask = useAITradingStore((s) => s.stopTask)

  const [filter, setFilter] = useState<"all" | Source>("all")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
    void loadTasks({ silent: true })
    // 定期刷新持仓（手数/保证金随成交变化）；现价与浮亏由全局行情 WS 每秒推送的 quote 驱动更新
    const timer = setInterval(() => {
      void refresh()
    }, 10000)
    return () => clearInterval(timer)
  }, [refresh, loadTasks])

  const filtered = useMemo(() => {
    return positions.filter((p) => {
      const src = (p.source as string) || "manual"
      const matchSrc = filter === "all" || src === filter
      const matchSearch =
        !search ||
        p.symbol.toLowerCase().includes(search.toLowerCase()) ||
        p.symbol_name.includes(search)
      return matchSrc && matchSearch
    })
  }, [positions, filter, search])

  async function handleClose(
    p: PaperPositionItem,
    current: number,
  ): Promise<void> {
    const price = current > 0 ? current : p.avg_price
    const src = (p.source as string) || "manual"
    setBusy(p.id)
    // 清掉上次的下单错误，便于本次检测（place 把错误存 store.error 而非抛出）
    usePaperTradingStore.setState({ error: null })
    try {
      await closePosition(p, price, "market", p.available_quantity)
      // closePosition→place 失败时把错误存入 store.error 但不抛出，
      // 这里主动检查，给用户明确反馈（否则点击毫无反应）
      const placeErr = usePaperTradingStore.getState().error
      if (placeErr) {
        await showAlert({ title: "平仓失败", description: placeErr })
        return
      }
      // 平仓成功，ai/quant 仓继续停止对应 running 任务
      if (src !== "manual") {
        const match = findRunningTask(tasks, p.symbol, src)
        if (match) {
          try {
            await stopTask(match.id, true)
          } catch (taskErr) {
            // 平仓已成功，任务停止失败单独提示，不影响平仓结果
            await showAlert({
              title: "任务停止失败",
              description: `持仓已平仓，但停止任务失败：${taskErr instanceof Error ? taskErr.message : "未知错误"}`,
            })
          }
        }
        await loadTasks({ silent: true })
      }
    } catch (err) {
      await showAlert({
        title: "平仓失败",
        description: err instanceof Error ? err.message : "平仓失败",
      })
    } finally {
      setBusy(null)
    }
  }

  const totalPnl = filtered.reduce((sum, p) => {
    const q = quotes[p.symbol] ?? quotes[p.symbol.toLowerCase()]
    return sum + calcPnl(p, q?.last_price ?? 0).pnl
  }, 0)
  const totalMargin = filtered.reduce((sum, r) => sum + r.margin, 0)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] flex-wrap">
        <div className="flex gap-1">
          {(["all", "manual", "ai", "quant"] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "全部" : SOURCE_CFG[f]?.label || f}
            </Button>
          ))}
        </div>
        <div className="relative w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
          <Input
            placeholder="搜索合约"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto gap-1"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading && <Loader2 className="w-3 h-3 animate-spin" />}
          刷新
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)]">
            <p className="text-lg mb-2">暂无持仓</p>
            <p className="text-sm">在交易页下单或运行 AI/量化任务后，持仓按来源分类显示</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>合约</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>方向</TableHead>
                <TableHead>杠杆</TableHead>
                <TableHead>数量</TableHead>
                <TableHead>均价</TableHead>
                <TableHead>现价</TableHead>
                <TableHead>本金(U)</TableHead>
                <TableHead>杠杆后(U)</TableHead>
                <TableHead>浮动盈亏</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p) => {
                const quote = quotes[p.symbol] ?? quotes[p.symbol.toLowerCase()]
                const current = quote?.last_price ?? 0
                const { pnl, pct } = calcPnl(p, current)
                const isUp = pnl >= 0
                const src = (p.source as string) || "manual"
                const cfg = SOURCE_CFG[src] || SOURCE_CFG.manual
                const lev = Number(p.leverage ?? 0)
                const notional = Number(p.avg_price || 0) * Number(p.quantity || 0)
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <span className="text-sm font-medium">{p.symbol}</span>
                      <p className="text-[10px] text-[var(--text-muted)]">
                        {p.symbol_name}
                      </p>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn("text-[10px] px-1.5 py-0.5 rounded", cfg.cls)}
                        title={p.task_name ? `任务：${p.task_name}` : undefined}
                      >
                        {cfg.label}
                        {p.task_name ? `·${p.task_name}` : ""}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.direction === "long" ? "up" : "down"}>
                        {p.direction === "long" ? "多" : "空"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-num">
                      {lev > 0 ? `${lev}x` : "—"}
                    </TableCell>
                    <TableCell className="font-num">
                      {Number(p.quantity).toLocaleString("zh-CN", {
                        maximumFractionDigits: 4,
                      })}
                    </TableCell>
                    <TableCell className="font-num">{p.avg_price}</TableCell>
                    <TableCell className="font-num">{current > 0 ? current : "--"}</TableCell>
                    <TableCell className="font-num">
                      {p.margin > 0 ? p.margin.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—"}
                    </TableCell>
                    <TableCell className="font-num">
                      {notional > 0
                        ? notional.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
                        : "—"}
                      {lev > 0 && notional > 0 && (
                        <span className="text-[10px] text-[var(--text-muted)] ml-1">
                          ({lev}x)
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className={cn("font-num font-medium", isUp ? "text-up" : "text-down")}
                    >
                      {current > 0 ? (
                        <>
                          {isUp ? "+" : ""}
                          {pnl.toFixed(2)}
                          <span className="text-xs ml-1 opacity-70">
                            ({isUp ? "+" : ""}
                            {pct.toFixed(2)}%)
                          </span>
                        </>
                      ) : (
                        "--"
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7"
                        disabled={submitting || busy === p.id || p.available_quantity <= 0}
                        onClick={() => void handleClose(p, current)}
                      >
                        {src !== "manual" ? "平仓并停任务" : "市价平仓"}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="flex items-center gap-6 px-4 py-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] text-sm flex-wrap">
          <span className="text-[var(--text-muted)]">持仓 {filtered.length} 笔</span>
          <span className="text-[var(--text-muted)]">
            本金合计{" "}
            <span className="font-num text-[var(--text-primary)]">{totalMargin.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} USDT</span>
          </span>
          <span className="text-[var(--text-muted)]">
            浮动盈亏{" "}
            <span className={cn("font-num font-medium", totalPnl >= 0 ? "text-up" : "text-down")}>
              {totalPnl >= 0 ? "+" : ""}
              {totalPnl.toFixed(2)}
            </span>
          </span>
        </div>
      )}
    </div>
  )
}
