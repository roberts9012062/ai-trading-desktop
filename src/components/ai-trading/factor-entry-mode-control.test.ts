import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { FactorEntryModeControl, FactorEntryModeSelect } from './factor-entry-mode-control'
import type { AITradingTask } from '@/lib/ai-trading-api'
it('shows the active mode separately from a deferred selection',()=>{
  const html=renderToStaticMarkup(createElement(FactorEntryModeControl,{task:{id:'1',strategy_type:'factor',factor_entry:{mode:'aggressive',pending_mode:'steady'}} as AITradingTask}))
  expect(html).toContain('当前：激进模式')
  expect(html).toContain('平仓确认后切换为稳健模式')
})
it('only factor tasks have mode controls and creation explains the cap',()=>{
  expect(renderToStaticMarkup(createElement(FactorEntryModeControl,{task:{strategy_type:'ai'} as AITradingTask}))).toBe('')
  const html=renderToStaticMarkup(createElement(FactorEntryModeSelect,{value:'steady',onChange:()=>{}}))
  expect(html).toContain('稳健模式')
  expect(html).toContain('0.7')
})
