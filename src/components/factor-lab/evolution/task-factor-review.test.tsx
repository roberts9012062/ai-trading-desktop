import {describe,it,expect} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {TaskFactorEvidence} from './task-factor-review'
import type {FactorTaskHealth,FactorTaskReview,TaskReplayVariant} from '@/lib/factor-task-review'

const snapshot:FactorTaskHealth={task_id:'t',task_name:'ADA',symbol:'adausdt',timeframe:'15m',source_fingerprint:'hash',
  health:{status:'stale',trailing_ic:.9,reason:'数据已过期'},actual:{rounds:32,resolved:32,unresolved:0,win_rate:.4,
  net_profit:-45.5,recent_rounds:20,recent_net_profit:-40,funding_included:false,interpretation:'不含资金费率'}}
const variant:TaskReplayVariant={rounds:12,win_rate:.5,realized_net:-6,total_net:-8,closed_fees:2,closed_funding:-1,
  max_drawdown:10,blocked_entries:4,funding_complete:false,execution_seconds:900,start:'2026-10-01',end:'2026-10-17'}

describe('task factor evidence',()=>{
  it('does not show stale correlation as fresh healthy evidence',()=>{
    const html=renderToStaticMarkup(<TaskFactorEvidence snapshot={snapshot}/>)
    expect(html).toContain('数据已过期')
    expect(html).not.toContain('0.9000')
    expect(html).toContain('-45.50')
    expect(html).toContain('不含资金费率')
  })
  it('separates synthetic rule scenarios from actual profit and discloses unknown funding',()=>{
    const report:FactorTaskReview={task_name:'ADA',source_fingerprint:'hash',policy:{leverage:10},bars_sha256:'bars',
      recipe_sha256:'formula',execution_bars_sha256:null,promotion_eligible:false,path_sensitive:true,
      limitations:['资金费率结算事件覆盖不足'],note:'历史回看不能直接替换实盘',variants:{signal_only:variant,full_rules:variant,full_rules_2x:variant},
      alternate_path:variant,signal_health:{status:'ok',trailing_ic:-.1},checked_at:'2026-10-18',observed_history:true}
    const html=renderToStaticMarkup(<TaskFactorEvidence snapshot={snapshot} report={report}/>)
    for(const text of ['仅因子信号','全部任务规则','双倍交易成本','资金费率结算事件覆盖不足','路径','不能直接替换实盘'])expect(html).toContain(text)
    expect(html).not.toContain('实盘验收通过')
  })
})
