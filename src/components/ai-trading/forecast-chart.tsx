"use client"
import {useEffect,useRef,useState} from 'react'
import {CandlestickSeries,createChart,type ISeriesApi} from 'lightweight-charts'
import {drawForecastLines} from '@/components/market/kline/lines/use-forecast-lines'
import {Dialog,DialogContent,DialogTitle} from '@/components/ui/dialog'
import {getAITradingTask,type AITradingTask} from '@/lib/ai-trading-api'
import {getForecastKlineApi} from '@/lib/api'
import {readDisplayCandles,watchDisplayCandles} from '@/lib/display-kline'
import {forecastConfig,forecastState,forecastLines,FORECAST_STAGES} from '@/lib/ai-forecast'
import {dedupeBarsByChartTime,formatChartTime,makeChartOpts,sanitizeBars} from '@/components/market/kline/utils'
import {useDisplayStore} from '@/stores/display'
import type {KlineBar,KlinePeriod} from '@/types'

/** Reuses anchor candle/time conventions; updates candles and lines without recreating the chart. */
export function ForecastKline({task}:{task:AITradingTask}):React.JSX.Element {
 const root=useRef<HTMLDivElement>(null),series=useRef<ISeriesApi<'Candlestick'>|null>(null)
 const [ready,setReady]=useState(0),[error,setError]=useState('')
 const up=useDisplayStore(s=>s.candleUp),down=useDisplayStore(s=>s.candleDown)
 const count=forecastConfig(task).bar_count
 useEffect(()=>{
  if(!root.current)return
  const chart=createChart(root.current,{...makeChartOpts(),width:root.current.clientWidth,height:root.current.clientHeight})
  const candles=chart.addSeries(CandlestickSeries,{upColor:up,downColor:down,borderUpColor:up,borderDownColor:down,wickUpColor:up,wickDownColor:down})
  series.current=candles;setReady(v=>v+1)
  const ro=new ResizeObserver(([e])=>chart.applyOptions({width:e.contentRect.width,height:e.contentRect.height}));ro.observe(root.current)
  let alive=true,busy=false,first=true
  let currentBars:KlineBar[]=[]
  const refresh=async():Promise<void>=>{
   if(busy)return;busy=true
   try {
    const displayBars=await readDisplayCandles(task.symbol,task.timeframe as KlinePeriod,currentBars,async()=>{
     const response=await getForecastKlineApi(task.id)
     return response.bars as unknown as KlineBar[]
    })
    if(!alive)return
    const bars=dedupeBarsByChartTime(sanitizeBars(displayBars),task.timeframe as KlinePeriod)
    if(!bars.length)throw new Error('暂无可用 K 线')
    currentBars=bars
    const px=bars[bars.length-1].close
    const precision=px>=100?2:px>=1?4:px>=0.01?6:9
    candles.applyOptions({priceFormat:{type:'price',precision,minMove:10**-precision}})
    candles.setData(bars.map(k=>({time:formatChartTime(task.timeframe as KlinePeriod,k.time),open:k.open,high:k.high,low:k.low,close:k.close})))
    if(first){chart.timeScale().fitContent();first=false}
    setError('')
   }catch(e){if(alive)setError(e instanceof Error?e.message:'K线加载失败')}finally{busy=false}
  }
  const stopUpdates=watchDisplayCandles(task.symbol,task.timeframe as KlinePeriod,refresh)
  return()=>{alive=false;stopUpdates();ro.disconnect();series.current=null;chart.remove()}
 },[task.id,task.symbol,task.timeframe,count,up,down])
 const lines=JSON.stringify(forecastLines(task))
 useEffect(()=>{
  const current=series.current;if(!current)return
  return drawForecastLines(current,JSON.parse(lines) as ReturnType<typeof forecastLines>)
 },[ready,lines])
 return <div className="relative h-full w-full"><div ref={root} className="absolute inset-0"/>{error&&<p className="absolute left-2 top-2 text-xs text-amber-400">{error} · 自动重试</p>}</div>
}

export function ForecastChartDialog({task,onClose}:{task:AITradingTask|null;onClose:()=>void}):React.JSX.Element {
 const [current,setCurrent]=useState<AITradingTask|null>(task),[error,setError]=useState('')
 useEffect(()=>{setCurrent(task)},[task])
 useEffect(()=>{
  if(!task)return;let alive=true,busy=false
  const refresh=async():Promise<void>=>{if(busy)return;busy=true;try{const value=await getAITradingTask(task.id);if(alive){setCurrent(value);setError('')}}catch(e){if(alive)setError(e instanceof Error?e.message:'任务状态刷新失败')}finally{busy=false}}
  void refresh();const timer=setInterval(()=>void refresh(),3000)
  return()=>{alive=false;clearInterval(timer)}
 },[task?.id])
 const state=current?forecastState(current):{}
 return <Dialog open={Boolean(task)} onOpenChange={v=>{if(!v)onClose()}}><DialogContent className="max-w-3xl w-[92vw] h-[64vh] flex flex-col p-3">
  <DialogTitle className="text-sm pr-8">预测交易 · {current?.name} · {FORECAST_STAGES[state.stage??'watching']??state.stage}</DialogTitle>
  <p className="text-[11px] text-[var(--text-muted)]">动态 K 线 · 挂单／持仓：橙色 · 止盈：绿色 · 止损：红色</p>
  {(error||state.error)&&<p className="text-xs text-amber-400">{error||state.error}</p>}
  {!state.plan&&<p className="text-xs text-[var(--text-muted)]">等待 AI 给出有效预测，尚未生成交易线。</p>}
  {current&&<div className="flex flex-wrap gap-3 text-xs">{forecastLines(current).map(line=><span key={line.title} style={{color:line.color}}>{line.title} · {line.price}</span>)}</div>}
  <div className="min-h-0 flex-1">{current&&task&&<ForecastKline task={current}/>}</div>
  {state.commentary&&<p className="text-xs text-[var(--text-secondary)] max-h-20 overflow-auto">{state.commentary}</p>}
 </DialogContent></Dialog>
}
