import {factorLabRequest} from './factor-lab-api'

export interface ObservedFactorHealth {
  version?:string; status:'ok'|'insufficient'|'unavailable'|'stale'; reason?:string|null
  trailing_ic?:number|null; decay?:boolean|null; ic_pairs?:number; label_end?:string; prediction_end?:string
  checked_at?:string; expires_at?:string; source?:string; assumed_one_way_cost?:number; cost_model?:string
  live_ann?:number; live_sortino?:number; horizons?:Record<string,{pairs:number;ic:number|null}>
  structural?:{errors:string[];warnings:string[]}; interpretation?:string
}
export interface FactorTaskHealth {
  task_id:string; task_name:string; symbol:string; timeframe:string; source_fingerprint:string; health:ObservedFactorHealth
  actual?:{rounds:number;resolved:number;unresolved:number;win_rate:number|null;net_profit:number;
    recent_rounds:number;recent_net_profit:number;funding_included:false;interpretation:string}
}
export interface TaskReplayVariant {
  rounds:number; win_rate:number|null; realized_net:number; total_net:number; closed_fees:number; closed_funding:number
  max_drawdown:number; blocked_entries:number; funding_complete:boolean; execution_seconds:number; start:string;end:string
}
export interface FactorTaskReview {
  task_name:string;source_fingerprint:string;policy:Record<string,unknown>;bars_sha256:string;recipe_sha256:string
  execution_bars_sha256:string|null;promotion_eligible:false;path_sensitive:boolean;limitations:string[];note:string
  variants:Record<string,TaskReplayVariant>;alternate_path:TaskReplayVariant;signal_health:ObservedFactorHealth
  checked_at:string;observed_history:true
}
const root='/api/factor-lab/review/tasks'
export const getFactorTaskHealth=(id:string)=>factorLabRequest<FactorTaskHealth>(`${root}/${id}/health`)
export const refreshFactorTaskHealth=(id:string)=>factorLabRequest<FactorTaskHealth>(`${root}/${id}/health`,{method:'POST'},120_000)
export const runFactorTaskReview=(id:string,body:{days:number;include_fine:boolean;source_fingerprint?:string})=>
  factorLabRequest<FactorTaskReview>(`${root}/${id}/run`,{method:'POST',body:JSON.stringify(body)},600_000)
