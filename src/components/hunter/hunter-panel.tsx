import { useEffect, useState } from "react"
import { Crosshair } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useHunterStore } from "@/stores/hunter"
import { CYCLES } from "@/lib/hunter/rules"
import { hunterAccountLabel } from "@/lib/hunter/api"

const money = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const labels = { running: "搜索中", paused: "搜索暂停", stopping: "正在退出持仓", stopped: "搜索已停止" }
export function HunterPanel() {
  const groups = useHunterStore(s => s.groups)
  const visible = groups.filter(g => g.status !== "stopped")
  const progress = useHunterStore(s => s.progress)
  const control = useHunterStore(s => s.control)
  const connectionError = useHunterStore(s => s.error)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void useHunterStore.getState().refresh(abort.signal).catch(() => {})
    return () => abort.abort()
  }, [])
  if (!visible.length) return null
  const action = async (id: string, cmd: Parameters<typeof control>[1]) => {
    setBusy(id); setError(null)
    try { await control(id, cmd) } catch (e) { setError(e instanceof Error ? e.message : "操作失败") } finally { setBusy(null) }
  }
  return <section aria-label="多周期猎手" className="space-y-3">
    <div className="flex gap-2 items-center text-sm font-medium"><Crosshair className="w-4 h-4" />多周期猎手</div>
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {connectionError && <p role="alert" className="text-xs text-red-400">{connectionError}</p>}
    {visible.map(g => <article key={g.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex justify-between gap-3 flex-wrap">
        <div><strong className="text-sm">{g.name}</strong><span className="ml-2 text-xs text-[var(--text-muted)]">{labels[g.status]} · {hunterAccountLabel(g.runtime.execution_account?.execution_mode ?? (g.trading_mode === "virtual" ? "virtual" : undefined))} · {g.config.venue.toUpperCase()} · {g.config.leverage ?? 1} 倍{g.config.margin_mode === "cross" ? "全仓" : "逐仓"} · {g.config.brain === "rules" ? "规则" : g.config.brain === "jev" ? "Jev" : "AI 大模型"}</span>
          <p className="text-xs text-[var(--text-muted)] mt-1 whitespace-pre-line">{progress[g.id] ?? "等待桌面扫描；已挂载持仓由服务器管理"}</p></div>
        <div className="flex gap-2 flex-wrap">
          {(g.status === "running" || g.status === "paused") && <Button size="sm" variant="outline" disabled={busy === g.id} onClick={() => void action(g.id, g.status === "running" ? "pause" : "resume")}>{g.status === "running" ? "暂停搜索" : "恢复搜索"}</Button>}
          {g.status !== "stopped" && g.status !== "stopping" && <Button size="sm" variant="outline" disabled={busy === g.id} onClick={() => void action(g.id, "stop")}>停止搜索</Button>}
          {g.opportunities.some(o => !o.finished_at) && <Button size="sm" variant="outline" disabled={busy === g.id || g.status === "stopping"} onClick={() => void action(g.id, "stop_close")}>停止并平仓</Button>}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
        <div>策略净值<span className="block text-base mt-1">{money(g.equity)} USDT</span></div>
        <div>已实现净收益<span className="block text-base mt-1">{money(g.runtime.realized ?? 0)}</span></div>
        <div>完整交易<span className="block text-base mt-1">{g.stats.trades} 笔</span></div>
        <div>实际平均盈亏比<span className="block text-base mt-1">{g.stats.payoff === null ? (g.stats.trades === 0 ? "尚无完整交易" : "需盈利和亏损交易") : g.stats.payoff.toFixed(2)}</span></div>
        <div>净盈利因子 PF<span className="block text-base mt-1">{g.stats.profit_factor === null ? (g.stats.trades === 0 ? "尚无完整交易" : "尚无亏损交易") : g.stats.profit_factor.toFixed(2)}</span></div>
        <div>完整交易胜率<span className="block text-base mt-1">{g.stats.win_rate === null ? "尚无完整交易" : (g.stats.win_rate*100).toFixed(1) + "%"}</span></div>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">统计样本来自这个猎手实际成交并完成平仓、核对收益后的交易；未开仓结束的任务不计入。没有交易样本不会阻止搜索或首笔开仓。行情来自服务器转接的 OKX K 线。</p>
      {g.blocks.length > 0 && <p className="text-xs text-amber-400">{g.blocks.join("；")}</p>}
      <details>
        <summary className="text-xs cursor-pointer">查看交易任务（{g.opportunities.length}）与止损</summary>
        <div className="overflow-x-auto mt-2"><table className="w-full text-xs text-left">
          <thead><tr className="text-[var(--text-muted)]"><th className="p-2">币种 / 周期</th><th>状态</th><th>入场 / 止损</th><th>净收益</th></tr></thead>
          <tbody>{g.opportunities.map(o => <tr key={o.id} className="border-t border-[var(--border)]">
            <td className="p-2">{o.symbol.toUpperCase()} · {CYCLES[o.cycle].label} · {o.plan.direction === "long" ? "多" : "空"} · {o.plan.leverage ?? 1} 倍{o.plan.margin_mode === "cross" ? "全仓" : "逐仓"}</td>
            <td>{({ mounted: "已挂载", opening: "开仓中", holding: "持仓管理", reconciling: "成交核对", closed: "已结束", cancelled: "未开仓结束" } as Record<string, string>)[o.status] ?? o.status}</td>
            <td>{o.plan.entry.toPrecision(7)} / {(o.runtime.stop ?? o.plan.stop).toPrecision(7)}</td>
            <td>{money(o.net_profit)}<span className="block text-[var(--text-muted)]">{o.runtime.note ?? o.runtime.reason ?? ""}</span></td>
          </tr>)}</tbody>
        </table></div>
      </details>
      <p className="text-[11px] text-[var(--text-muted)]">{g.trading_mode === "live" ? "OKX API 执行 · 成交费用及已对账资金费计入收益，模型调用费另计" : "站内模拟研究 · 成交手续费已计入，资金费和模型费尚未模拟结算"}；尚未取得独立盈利验证。停止搜索不会关闭已有持仓保护。</p>
    </article>)}
  </section>
}
