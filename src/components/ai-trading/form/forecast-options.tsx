"use client"
import {useEffect,useState} from 'react'
import {AnchorIndicatorPicker} from '@/components/market/ai-anchor/anchor-indicator-picker'
import {getAnchorIndicatorsApi,type AnchorParamSpec} from '@/lib/ai-anchor-api'
import type {ForecastConfig} from '@/lib/ai-forecast'
export function ForecastOptions({value,onChange}:{value:ForecastConfig;onChange:(value:ForecastConfig)=>void}):React.JSX.Element {
 const [schema,setSchema]=useState<Record<string,AnchorParamSpec[]>>({})
 const [error,setError]=useState('')
 useEffect(()=>{let alive=true;void getAnchorIndicatorsApi().then(v=>{if(alive)setSchema(v)}).catch(e=>{if(alive)setError(String(e))});return()=>{alive=false}},[])
 return <div className="space-y-2 rounded border border-[var(--border)] p-2">
  <p className="text-xs text-[var(--text-secondary)]">预测分析 · 与 AI 播报使用同样的技术线和周期设置</p>
  <div className="grid grid-cols-2 gap-2 text-xs">
   <label>分析间隔<select aria-label="预测分析间隔" value={value.interval_minutes} onChange={e=>onChange({...value,interval_minutes:Number(e.target.value)})} className="w-full h-9 bg-[var(--bg-primary)] border rounded">{[5,10,15,20,25,30].map(n=><option key={n} value={n}>{n} 分钟</option>)}</select></label>
   <label>交易风格<select aria-label="预测交易风格" value={value.horizon} onChange={e=>onChange({...value,horizon:e.target.value as ForecastConfig['horizon']})} className="w-full h-9 bg-[var(--bg-primary)] border rounded"><option value="short">短线</option><option value="mid">中线</option><option value="long">长线</option></select></label>
   <label>操盘策略<select aria-label="预测操盘策略" value={value.strategy} onChange={e=>onChange({...value,strategy:e.target.value as ForecastConfig['strategy']})} className="w-full h-9 bg-[var(--bg-primary)] border rounded"><option value="aggressive">激进</option><option value="balanced">稳健</option><option value="conservative">保守</option></select></label>
  </div>
  {error?<p className="text-xs text-red-400">技术线加载失败：{error}</p>:<AnchorIndicatorPicker schema={schema} value={value.indicators} onChange={indicators=>onChange({...value,indicators})}/>}
  <p className="text-[11px] text-[var(--text-muted)]">触线进场，周期更新止盈止损；持仓止损只收紧，平仓确认后结束本轮。</p>
 </div>
}
