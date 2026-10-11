import { expect, it } from 'vitest'
import { entryModeOf, entryObservationKey, needsEntryObservation } from './factor-entry'
import { intentForScore } from './realtime-factor/model'

const steady = { side_mode:'both', close_rules:{}, strategy_params:{entry_mode:'steady'} }
it('preserves legacy aggressive and uses explicit steady configuration',()=>{
  expect(entryModeOf({})).toBe('aggressive')
  expect(entryModeOf(steady)).toBe('steady')
  expect(intentForScore({...steady,strategy_params:{}},.9)).toBe('open_long')
})
it('steady requires a new bounded crossing in both directions',()=>{
  expect(intentForScore(steady,.9)).toBe('hold')
  expect(intentForScore(steady,.5,.9)).toBe('hold')
  expect(intentForScore(steady,.7,.3)).toBe('open_long')
  expect(intentForScore(steady,.8,.2)).toBe('hold')
  expect(intentForScore(steady,-.7,-.3)).toBe('open_short')
  expect(intentForScore(steady,-.8,-.2)).toBe('hold')
  expect(intentForScore({...steady,position_qty:.01,position_direction:'short'},.9)).toBe('close')
})
it('reports neutral/reset observations without sending every unchanged score',()=>{
  expect(needsEntryObservation(steady,.1,undefined)).toBe(true)
  expect(needsEntryObservation(steady,.2,.1)).toBe(false)
  expect(needsEntryObservation(steady,.5,.2)).toBe(true)
  expect(needsEntryObservation(steady,.6,.5)).toBe(false)
  expect(needsEntryObservation(steady,.9,.6)).toBe(true)
  expect(needsEntryObservation({},.1,undefined)).toBe(false)
  expect(entryObservationKey({...steady,position_qty:1})).not.toBe(entryObservationKey(steady))
})
