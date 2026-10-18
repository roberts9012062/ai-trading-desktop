import {afterEach,describe,it,expect,vi} from 'vitest'
import {getFactorTaskHealth,refreshFactorTaskHealth,runFactorTaskReview} from './factor-task-review'
import {canReplaceTaskEvolution,type EvolutionJob} from './factor-evolution-api'

afterEach(()=>vi.unstubAllGlobals())
describe('read-only task review API',()=>{
  it('uses separate observation endpoints and sends no task execution or replacement action',async()=>{
    const fetch=vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>({})})
    vi.stubGlobal('fetch',fetch)
    await getFactorTaskHealth('task')
    await refreshFactorTaskHealth('task')
    await runFactorTaskReview('task',{days:14,include_fine:true,source_fingerprint:'frozen'})
    expect(fetch.mock.calls.map(call=>call[0])).toEqual([
      '/api/factor-lab/review/tasks/task/health','/api/factor-lab/review/tasks/task/health','/api/factor-lab/review/tasks/task/run'])
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({days:14,include_fine:true,source_fingerprint:'frozen'})
  })
  it('blocks old task research when current policy evidence is missing',()=>{
    const job:EvolutionJob={id:'fixture',source:{kind:'task',shortline:false},symbol:'ADAUSDT',timeframe:'15m',data_channel:'okx',
      status:'passed',round:1,max_rounds:1,recipe:{groups:[[0]],weights:[1]},coverage:{},cutoff:'2026-10-18',history_note:'fixture',bars_sha256:'bars',sealed_used:true,
      settings:{train_ratio:.7,test_recent_bars:0,walk_forward_folds:3,fee_rate:.0005,slippage_bps:2,execution_model:'perp_next_open',task_policy:{leverage:10}},
      reports:[{round:1,validation:{passed:true,funding_complete:true,version:'factor-evolution-2026-10-18.1'},audit:{passed:true,task_comparison:{passed:true,model:'coarse_ohlc_prescreen',exact:false}}}]}
    expect(canReplaceTaskEvolution(job)).toBe(true)
    expect(canReplaceTaskEvolution({...job,settings:{...job.settings,task_policy:undefined}})).toBe(false)
    expect(canReplaceTaskEvolution({...job,reports:[]})).toBe(false)
    expect(canReplaceTaskEvolution({...job,reports:[{...job.reports[0],validation:{...job.reports[0].validation!,version:'old'}}]})).toBe(false)
  })
})
