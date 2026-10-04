import {describe,it,expect} from 'vitest'
import {forecastLines,isForecast} from './ai-forecast'
import type {AITradingTask} from './ai-trading-api'
const task={id:'f',strategy_type:'ai',status:'running',strategy_params:{mode:'forecast',forecast_state:{stage:'pending',plan:{direction:'short',entry:100,take_profit:91,stop_loss:103}}}} as unknown as AITradingTask
describe('forecast chart truth',()=>{
 it('shows pending lines and replaces entry with actual average and pnl only after a fill',()=>{
  expect(forecastLines(task)[0]).toMatchObject({price:100,title:'挂单做空'})
  expect(forecastLines({...task,position_qty:2,position_avg_price:99.8,position_unrealized:3})[0]).toMatchObject({price:99.8,title:'持仓空 · +3.00 U'})
 })
 it('clears stopped lines and does not invent levels before a valid prediction',()=>{
  expect(forecastLines({...task,status:'stopped'})).toEqual([])
  expect(forecastLines({...task,strategy_params:{mode:'forecast'}})).toEqual([])
  expect(isForecast({...task,strategy_params:{}})).toBe(false)
 })
})
