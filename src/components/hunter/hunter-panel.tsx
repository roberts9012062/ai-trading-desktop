import { useEffect, useState } from "react"
import { Crosshair } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useHunterStore } from "@/stores/hunter"
import { LiveProfitLockControl } from "@/components/ai-trading/form/live-profit-lock-control"
import { TaskProfitLockStatus } from "@/components/ai-trading/profit-lock-status"
import { useAITradingStore } from "@/stores/ai-trading"
import { CYCLES } from "@/lib/hunter/rules"
import { hunterAccountLabel } from "@/lib/hunter/api"
import { HunterProfitSummary } from "./hunter-profit-summary"

const money = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const labels = { running: "搜索中", paused: "搜索暂停", stopping: "正在退出持仓", stopped: "搜索已停止" }
export function HunterPanel() {
  const groups = useHunterStore(s => s.groups)
  const tasks = useAITradingStore(s => s.tasks)
  const visible = groups.filter(g => g.status !== "stopped")
  const progress = useHunterStore(s => s.progress)
  const watches = useHunterStore(s => s.watches)
  const control = useHunterStore(s => s.control)
  const setProfitLock = useHunterStore(s => s.setProfitLock)
  const connectionError = useHunterStore(s => s.error)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void useHunterStore.getState().refresh(abort.signal).catch(() => {})
    return () => abort.abort()
  }, [])
  if (!visible.length) return null
  const action = async (id: string, cmd: Parameters<typeof control>[1], poolSize?: number) => {
    setBusy(id); setError(null)
    try { await control(id, cmd, poolSize) } catch (e) { setError(e instanceof Error ? e.message : "操作失败") } finally { setBusy(null) }
  }
  return <section aria-label="多周期猎手" className="space-y-3">
    <div className="flex gap-2 items-center text-sm font-medium"><Crosshair className="w-4 h-4" />多周期猎手</div>
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {connectionError && <p role="alert" className="text-xs text-red-400">{connectionError}</p>}
    {visible.map(g => <article key={g.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex justify-between gap-3 flex-wrap">
        <div><strong className="text-sm">{g.name}</strong><span className="ml-2 text-xs text-[var(--text-muted)]">{labels[g.status]} · {hunterAccountLabel(g.runtime.execution_account?.execution_mode ?? (g.trading_mode === "virtual" ? "virtual" : undefined))} · {g.config.venue.toUpperCase()} · {g.config.leverage ?? 1} 倍{g.config.margin_mode === "cross" ? "全仓" : "逐仓"} · {g.config.brain === "rules" ? "规则" : g.config.brain === "jev" ? "Jev" : "AI 大模型"}</span>
          <p className="text-xs text-[var(--text-muted)] mt-1">{g.config.strategy_version === "hunter-v4" ? "波段持有版 · 计划净3:1 / 多周期延续 / 确认反转退出" : g.config.strategy_version === "hunter-v3" ? "机会增强版 · 突破回踩 / 趋势回调 / 短线延续 · 小时覆盖检查" : g.config.strategy_version === "hunter-v2" ? "均衡版 · 突破回踩 / 趋势回调 · 周期独立扫描" : "原版 · 突破回踩"}</p>
          <p className="text-xs text-[var(--text-muted)] mt-1 whitespace-pre-line line-clamp-1" title={progress[g.id]}>{progress[g.id] ?? "等待桌面扫描；已挂载持仓由服务器管理"}</p></div>
        <div className="flex gap-2 flex-wrap">
          <LiveProfitLockControl targetId={g.id} name={g.name} hunter config={g.config.profit_lock} disabled={busy === g.id} onSave={config => setProfitLock(g.id, config)} />
          {(g.status === "running" || g.status === "paused") && (g.config.strategy_version ?? "hunter-v1") === "hunter-v1" && <Button size="sm" variant="outline" disabled={busy === g.id} onClick={() => void action(g.id, "upgrade")}>启用均衡版</Button>}
          {(g.status === "running" || g.status === "paused") && g.config.strategy_version !== "hunter-v4" && (g.config.strategy_version !== "hunter-v3" || g.config.pool_size < 50) && <Button size="sm" variant="outline" disabled={busy === g.id} onClick={() => void action(g.id, "upgrade_adaptive", 50)}>{g.config.strategy_version === "hunter-v3" ? "扩大币池至50" : "启用机会增强版 · 50币"}</Button>}
          {(g.status === "running" || g.status === "paused") && (g.config.strategy_version !== "hunter-v4" || g.config.pool_size < 50) && <Button size="sm" variant="outline" disabled={busy === g.id} onClick={() => void action(g.id, "upgrade_swing", 50)}>{g.config.strategy_version === "hunter-v4" ? "扩大波段币池至50" : "启用波段持有版 · 计划3:1"}</Button>}
          {(g.status === "running" || g.status === "paused") && <Button size="sm" variant="outline" disabled={busy === g.id} onClick={() => void action(g.id, g.status === "running" ? "pause" : "resume")}>{g.status === "running" ? "暂停搜索" : "恢复搜索"}</Button>}
          {g.status !== "stopped" && g.status !== "stopping" && <Button size="sm" variant="outline" disabled={busy === g.id} onClick={() => void action(g.id, "stop")}>停止搜索</Button>}
          {g.opportunities.some(o => !o.finished_at) && <Button size="sm" variant="outline" disabled={busy === g.id || g.status === "stopping"} onClick={() => void action(g.id, "stop_close")}>停止并平仓</Button>}
        </div>
      </div>
      <HunterProfitSummary hunter={g} />
      <details data-testid="hunter-statistics-group" className="rounded-lg border border-[var(--border)] p-3">
      <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">展开猎手明细 · {g.opportunities.length} 个交易任务</summary>
      <div className="mt-3 space-y-3">
      {(g.config.strategy_version === "hunter-v3" || g.config.strategy_version === "hunter-v4") && <div className="rounded-md border border-[var(--border)] p-3 text-xs space-y-1" aria-label="小时扫描检查">
        {g.runtime.discovery ? <>
          <p>近1小时：规则信号 {g.runtime.discovery.hour_signals} 个（待成本和模型复核） · 服务器已挂载 {g.runtime.discovery.hour_mounted} 个</p>
          {g.status === "running" && g.runtime.discovery.stale && <p className="text-amber-400">扫描更新中断，请检查桌面搜索是否运行及行情连接。</p>}
          {g.status === "running" && g.runtime.discovery.overdue && <p className="text-amber-400">1小时挂载目标未达：{g.runtime.discovery.hour_signals ? "已发现规则信号，查看下方服务器拒绝原因。" : "尚无有效入场信号，检查候选覆盖和筛选条件。"}</p>}
          {Object.entries(g.runtime.discovery.cycles).map(([cycle, report]) => report && <p key={cycle} className="text-[var(--text-muted)]">{CYCLES[cycle as keyof typeof CYCLES].label} · {new Date(report.at*1000).toLocaleTimeString("zh-CN")} · {report.note}</p>)}
        </> : <p>等待首轮扫描结果；运行满1小时后检查发现与挂载情况。</p>}
        {!g.config.cycles.includes("short") && <p className="text-amber-400">小时发现目标需要开启短线；中长线按小时或日线收盘确认。</p>}
        {g.config.pool_size < 50 && <p className="text-[var(--text-muted)]">当前币池上限 {g.config.pool_size}。扩大至50个币可增加机会覆盖；升级保留当前设置。</p>}
      </div>}
      {g.config.profit_lock?.enabled && !g.opportunities.some(o => !o.finished_at) && <p className="text-xs text-emerald-400">锁利已开启 · 等待新持仓</p>}
      {g.opportunities.filter(o => !o.finished_at).map(o => {
        const task = tasks.find(t => t.id === o.task_id)
        return task?.close_rules?.profit_lock?.enabled || task?.profit_lock_state?.closing ? <div key={o.id} className="min-w-0">
          <p className="text-[11px] text-[var(--text-muted)]">{o.symbol.toUpperCase()} · {CYCLES[o.cycle].label}</p>
          <TaskProfitLockStatus task={task!} />
        </div> : null
      })}
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
      {g.config.strategy_version === "hunter-v4" && <p className="text-xs text-[var(--text-muted)]">计划净盈亏比≥3:1；实际平均盈亏比目标≥3:1，{g.stats.trades < 30 || g.stats.payoff === null ? "样本不足，尚未验证" : g.stats.payoff < 3 ? "当前低于目标，需继续评估" : "当前样本达到目标，仍需独立验证"}。升级只影响新挂载，已有持仓沿用冻结版本。用户锁利可先于波段退出触发。</p>}
      {(g.config.strategy_version === "hunter-v2" || g.config.strategy_version === "hunter-v3" || g.config.strategy_version === "hunter-v4") && <details>
        <summary className="text-xs cursor-pointer">候选观察池（{watches[g.id]?.length ?? 0}）</summary>
        <p className="text-[11px] text-[var(--text-muted)] mt-2">进入观察池表示排名和趋势通过；等待入场确认，仍须通过服务器复核。排名、趋势失效或已有持仓后移出。</p>
        <div className="flex flex-wrap gap-2 mt-2">{(watches[g.id] ?? []).map(w => <span key={w.cycle+":"+w.symbol+":"+w.direction} className="text-xs rounded border border-[var(--border)] px-2 py-1">{w.symbol.toUpperCase()} · {CYCLES[w.cycle].label} · {w.direction === "long" ? "多" : "空"} · {w.stage}</span>)}</div>
      </details>}
      <div>
        <p className="text-xs">交易任务（{g.opportunities.length}）与止损</p>
        <div className="overflow-x-auto mt-2"><table className="w-full text-xs text-left">
          <thead><tr className="text-[var(--text-muted)]"><th className="p-2">币种 / 周期</th><th>状态</th><th>入场 / 止损</th><th>净收益</th></tr></thead>
          <tbody>{g.opportunities.map(o => <tr key={o.id} className="border-t border-[var(--border)]">
            <td className="p-2">{o.symbol.toUpperCase()} · {CYCLES[o.cycle].label} · {o.plan.direction === "long" ? "多" : "空"} · {o.plan.leverage ?? 1} 倍{o.plan.margin_mode === "cross" ? "全仓" : "逐仓"} · {o.plan.entry_kind === "continuation" ? "趋势延续" : o.plan.entry_kind === "pullback" ? "趋势回调" : "突破回踩"}<span className="block text-[var(--text-muted)]">{o.plan.version ?? "hunter-v1"}</span></td>
            <td>{({ mounted: "已挂载", opening: "开仓中", holding: "持仓管理", reconciling: "成交核对", closed: "已结束", cancelled: "未开仓结束" } as Record<string, string>)[o.status] ?? o.status}</td>
            <td>{o.plan.entry.toPrecision(7)} / {(o.runtime.stop ?? o.plan.stop).toPrecision(7)}{o.plan.target_price && <span className="block text-[var(--text-muted)]">净目标 {o.plan.target_price.toPrecision(7)} · ≥{o.plan.min_net_rr}:1</span>}{o.plan.version === "hunter-v4" && <span className="block text-emerald-400">{o.runtime.stop !== undefined && (o.plan.direction === "long" ? o.runtime.stop > (o.runtime.entry ?? o.plan.entry) : o.runtime.stop < (o.runtime.entry ?? o.plan.entry)) ? `盈利保护在 ${o.runtime.stop.toPrecision(7)} 平仓` : "初始结构止损保护"} · {o.runtime.swing?.reason ?? "等待持仓趋势判断"}</span>}</td>
            <td>{money(o.net_profit)}<span className="block text-[var(--text-muted)]">{o.runtime.note ?? o.runtime.reason ?? ""}</span></td>
          </tr>)}</tbody>
        </table></div>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">{g.trading_mode === "live" ? "OKX API 执行 · 成交费用及已对账资金费计入收益，模型调用费另计" : "站内模拟研究 · 成交手续费已计入，资金费和模型费尚未模拟结算"}；尚未取得独立盈利验证。停止搜索不会关闭已有持仓保护。</p>
      </div></details>
    </article>)}
  </section>
}
