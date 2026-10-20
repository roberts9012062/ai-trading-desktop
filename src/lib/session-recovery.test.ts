import {describe,it,expect} from 'vitest'
import {keepLocalSession} from './session-recovery'
describe('established local desktop sessions',()=>{
  it('survives transport failures, timeouts and server outages',()=>{
    for(const error of [new TypeError('offline'),new DOMException('timeout','TimeoutError'),{status:503},{status:429}]) {
      expect(keepLocalSession(error,true,true)).toBe(true)
    }
  })
  it('requires a previously known identity and still honors authentication rejection',()=>{
    expect(keepLocalSession({status:401},true,true)).toBe(false)
    expect(keepLocalSession({status:403},true,true)).toBe(false)
    expect(keepLocalSession({status:503},false,true)).toBe(false)
    expect(keepLocalSession({status:503},true,false)).toBe(false)
  })
})
