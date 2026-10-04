import type { AITradingTask } from './ai-trading-api'
import type { AnchorIndicatorItem, AnchorHorizon, AnchorStrategy } from './ai-anchor-api'
export interface ForecastConfig {
  timeframes: string[]; direction_mode: 'any'|'long'|'short'; strategy: AnchorStrategy
  horizon: AnchorHorizon; bar_count: number; interval_minutes: number; indicators: AnchorIndicatorItem[]
}
export interface ForecastPlan { direction:'long'|'short'; entry:number; take_profit:number; stop_loss:number; commentary?:string }
export interface ForecastState {
  stage?:string; plan?:ForecastPlan; position_price?:number; filled_qty?:number; error?:string
  commentary?:string; completed_at?:string
}
export const DEFAULT_FORECAST: ForecastConfig = {timeframes:['5m'],direction_mode:'any',strategy:'balanced',
  horizon:'short',bar_count:60,interval_minutes:5,indicators:[{name:'MA',params:{period:20}},{name:'MACD',params:{}}]}
export function isForecast(task:AITradingTask):boolean {return task.strategy_type==='ai' && (task.strategy_params as Record<string,unknown>|undefined)?.mode==='forecast'}
export function forecastState(task:AITradingTask):ForecastState {return (task.strategy_params as {forecast_state?:ForecastState}|undefined)?.forecast_state??{}}
export function forecastConfig(task:AITradingTask):ForecastConfig {return (task.strategy_params as {forecast?:ForecastConfig}|undefined)?.forecast??DEFAULT_FORECAST}
export const FORECAST_STAGES:Record<string,string>={watching:'等待预测',submitting:'提交条件单',pending:'等待进场',holding:'持仓保护',closing:'确认平仓',reconciling:'成交对账',completed:'闭环完成'}
export function forecastPrice(value:number):string {return Number.isFinite(value)&&value>0?Number(value.toPrecision(9)).toString():'--'}
export function forecastLines(task:AITradingTask):Array<{price:number;title:string;color:string}> {
  const state=forecastState(task),plan=state.plan
  if(!isForecast(task)||!plan||task.status==='stopped'||state.stage==='completed')return []
  const held=(task.position_qty??0)>0 || (state.filled_qty??0)>0 || state.stage==='holding'||state.stage==='closing'
  const pnl=task.position_unrealized
  const title=held?`持仓${plan.direction==='long'?'多':'空'}${pnl!=null?` · ${pnl>=0?'+':''}${pnl.toFixed(2)} U`:''}`:`挂单${plan.direction==='long'?'做多':'做空'}`
  return [{price:held?(task.position_avg_price??state.position_price??plan.entry):plan.entry,title,color:'#f59e0b'},
    {price:plan.take_profit,title:'止盈',color:'#22c55e'},{price:plan.stop_loss,title:'止损',color:'#ef4444'}]
    .filter(x=>Number.isFinite(x.price)&&x.price>0)
}
