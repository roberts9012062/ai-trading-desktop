import { useId } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DEFAULT_PROFIT_LOCK, type ProfitLockFormState } from "@/lib/profit-lock"
import { ProfitLockTemplatePicker } from "./profit-lock-template-picker"

const selectClass = "w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs"
export function ProfitLockSettings({ value = DEFAULT_PROFIT_LOCK, onChange, required = false }: {
  value?: ProfitLockFormState; onChange: (value: ProfitLockFormState) => void; required?: boolean
}) {
  const id = useId()
  const patch = (part: Partial<ProfitLockFormState>) => onChange({ ...value, ...part, ...(required ? { enabled: true } : {}) })
  const unit = value.unit === "percent" ? "%" : "USDT"
  const activation = Number(value.activation), gap = Number(value.giveback)
  const valid = Number.isFinite(activation) && Number.isFinite(gap) && activation > gap && gap > 0
  return <fieldset data-numeric-scope className="rounded-md border border-emerald-500/30 p-3 space-y-3">
    <legend className="px-1 text-sm font-medium">锁利润</legend>
    <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={required || value.enabled} disabled={required} onChange={e => patch({ enabled: e.target.checked })} />{required ? "锁利润自动开启（此策略必需）" : "开启锁利润"}</label>
    {(required || value.enabled) && <>
      <ProfitLockTemplatePicker id={id} value={value} onChange={next => patch(next)} />
      <div className="space-y-1"><Label htmlFor={id + "-mode"}>锁利模式</Label><select id={id + "-mode"} className={selectClass} value={value.mode} onChange={e => patch({ mode: e.target.value as ProfitLockFormState["mode"] })}>
        <option value="auto">自动 · 净收益达到5%激活</option><option value="manual">手动 · 自定义激活与回撤</option>
      </select></div>
      {value.mode === "auto" ? <p className="text-xs text-[var(--text-muted)]">净收益达到保证金的5%后激活；允许回撤为峰值净利润的20%，最低为保证金的1%。例如净收益5%锁4%，10%锁8%。</p> : <>
        <div className="space-y-1"><Label htmlFor={id + "-unit"}>盈利单位</Label><select id={id + "-unit"} className={selectClass} value={value.unit} onChange={e => patch({ unit: e.target.value as ProfitLockFormState["unit"] })}>
          <option value="percent">百分比 · 实际投入保证金</option><option value="usdt">USDT · 本轮净利润</option>
        </select></div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label htmlFor={id + "-activation"}>激活盈利（{unit}）</Label><Input required id={id + "-activation"} type="number" min={value.unit === "percent" ? 3 : .01} step="any" value={value.activation} onChange={e => patch({ activation: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor={id + "-gap"}>允许回撤（{unit}）</Label><Input required id={id + "-gap"} type="number" min={value.unit === "percent" ? 1 : .01} step="any" value={value.giveback} onChange={e => patch({ giveback: e.target.value })} /></div>
        </div>
        <p className={valid ? "text-xs text-[var(--text-muted)]" : "text-xs text-amber-500"}>{valid ? `激活时锁住${Number((activation-gap).toFixed(4))}${unit}，之后按最高净利润减${gap}${unit}上移。` : "激活阈值必须大于允许回撤；百分比激活至少3%、回撤至少1%。"}例如激活3%、回撤1%：盈利10%时锁9%。</p>
      </>}
      <div className="space-y-1"><Label htmlFor={id + "-cooldown"}>锁利平仓后冷却</Label><select id={id + "-cooldown"} className={selectClass} value={value.cooldown} onChange={e => patch({ cooldown: e.target.value })}>
        <option value="0">关闭冷却</option>{[1,2,3,4,5].map(n => <option value={n} key={n}>跳过{n}次有效开仓信号</option>)}
      </select></div>
      <p className="text-xs text-[var(--text-muted)]">扣除已付与预计平仓手续费，计入已结算资金费；锁利线只上移。服务器确认锁利平仓后才启动冷却，重复扫描同一信号只算一次。原止损、止盈仍优先；实际净收益以成交为准。</p>
    </>}
  </fieldset>
}
