import {beforeEach,expect,it,vi} from 'vitest'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
const fake=vi.hoisted(()=>({state:undefined as unknown}))
vi.mock('@/stores/realtime-factor',()=>({useRealtimeFactorStore:(selector:(s:unknown)=>unknown)=>selector({tasks:{task:fake.state}})}))
vi.mock('@/lib/realtime-factor/runtime',()=>({startRealtime:vi.fn(),stopRealtime:vi.fn()}))
import {RealtimeModeControl} from './realtime-mode-control'
import type {AITradingTask} from '@/lib/ai-trading-api'
const task={id:'task',strategy_type:'factor',status:'running',timeframe:'240m'} as AITradingTask
beforeEach(()=>{fake.state=undefined})
it('shows an enabled preparing switch while a newly created task waits for handoff',()=>{
  fake.state={state:'preparing',interval:3,message:'等待交接',rows:[]}
  const html=renderToStaticMarkup(createElement(RealtimeModeControl,{task}))
  expect(html).toContain('aria-checked="true"')
  expect(html).toContain('准备中')
  expect(html).toContain('等待交接')
})
it('keeps a failed startup reason visible and marks the switch disabled by mode',()=>{
  fake.state={state:'fallback',interval:3,message:'交接等待超时',rows:[]}
  const html=renderToStaticMarkup(createElement(RealtimeModeControl,{task}))
  expect(html).toContain('aria-checked="false"')
  expect(html).toContain('交接等待超时')
})
