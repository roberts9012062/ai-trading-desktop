"use client"
import { useId, useState } from 'react'
import type { AITradingTask, FactorEntryMode } from '@/lib/ai-trading-api'
import { ENTRY_MODE_LABEL, entryModeOf } from '@/lib/factor-entry'
import { useAITradingStore } from '@/stores/ai-trading'

export function FactorEntryModeSelect({value,onChange,disabled=false,compact=false}:{
  value:FactorEntryMode;onChange:(mode:FactorEntryMode)=>void;disabled?:boolean;compact?:boolean
}) {
  const id=useId()
  return <div className="space-y-1.5">
    <label htmlFor={id} className="text-xs text-[var(--text-muted)]">因子入场模式</label>
    <select id={id} value={value} disabled={disabled} onChange={event=>onChange(event.target.value as FactorEntryMode)}
      className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs disabled:opacity-50">
      <option value="steady">稳健模式</option><option value="aggressive">激进模式</option>
    </select>
    {!compact&&<p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
      {value==='steady'?'启动或平仓后先等信号复位，再上穿 +0.3 开多或下穿 −0.3 开空；超过 ±0.7 不追单。信号退回区间不会补追，必须重新复位、穿越。':'沿用原规则：当前信号 >+0.3 可开多，<−0.3 可开空，无 ±0.7 入场上限。'}
      两种模式均受启动K线、资金与风控限制，平仓规则保持原配置。
    </p>}
  </div>
}

export function FactorEntryModeControl({task}:{task:AITradingTask}) {
  const save=useAITradingStore(s=>s.setFactorEntryMode)
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  if(task.strategy_type!=='factor')return null
  const mode=entryModeOf(task),pending=task.factor_entry?.pending_mode
  async function change(next:FactorEntryMode) {
    setBusy(true);setError('')
    try {await save(task.id,next)} catch(error) {setError(error instanceof Error?error.message:'模式切换失败')}
    finally {setBusy(false)}
  }
  return <div className="my-2 space-y-1 rounded-md border border-[var(--border)] p-2" onClick={event=>event.stopPropagation()}>
    <FactorEntryModeSelect value={pending??mode} onChange={next=>void change(next)} disabled={busy} compact/>
    <p className="text-[11px] text-[var(--text-muted)]">当前：{ENTRY_MODE_LABEL[mode]}{busy?' · 保存中…':''}</p>
    {pending?<p role="status" className="text-[11px] text-amber-400">平仓确认后切换为{ENTRY_MODE_LABEL[pending]}；选择当前模式可取消。</p>:
      <p className="text-[10px] text-[var(--text-muted)]">有持仓或未完成订单时，切换在平仓确认后生效。{mode==='steady'?'穿越 ±0.3 入场，超过 ±0.7 不追单。':''}</p>}
    {error&&<p role="alert" className="text-[11px] text-red-400">{error}</p>}
  </div>
}
