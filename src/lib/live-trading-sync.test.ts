import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { subscribeLiveTradingSync, hasFreshLiveSync } from './live-trading-sync'
import { usePaperTradingStore } from '@/stores/paper-trading'
import { useAITradingStore } from '@/stores/ai-trading'
import { useAuthStore } from '@/stores/auth'
import type { User } from '@/types'
import type { MessageHandler, OpenHandler, StateHandler } from './websocket'

beforeEach(()=>{
 vi.useFakeTimers();useAuthStore.setState({user:{id:'a',trading_mode:'live'} as User})
 usePaperTradingStore.setState({liveSyncConnected:false,liveSyncAt:0})
 vi.spyOn(usePaperTradingStore.getState(),'refresh').mockResolvedValue()
 vi.spyOn(useAITradingStore.getState(),'loadTasks').mockResolvedValue()
 vi.spyOn(useAITradingStore.getState(),'loadProfitBars').mockResolvedValue()
})
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers()})
function socket(){
 let message!:MessageHandler,open!:OpenHandler,state!:StateHandler
 const off=vi.fn()
 return {ws:{onMessage:(f:MessageHandler)=>{message=f;return off},onOpen:(f:OpenHandler)=>{open=f;return off},onStateChange:(f:StateHandler)=>{state=f;return off}},message:(data:unknown)=>message({type:'live_account_tick',data}),open:()=>open({isReconnect:true}),state:(value:Parameters<StateHandler>[0])=>state(value),off}
}
const tick={venue:'okx',trading_mode:'live',connected:true,business_connected:true,channels:['positions']}
it('debounces a burst of exchange events; heartbeats do not fetch data',async()=>{
 const s=socket(),stop=subscribeLiveTradingSync(s.ws,()=>true)
 for(let n=0;n<20;n++)s.message(tick)
 expect(hasFreshLiveSync()).toBe(true)
 await vi.advanceTimersByTimeAsync(250)
 expect(usePaperTradingStore.getState().refresh).toHaveBeenCalledTimes(1)
 expect(useAITradingStore.getState().loadTasks).toHaveBeenCalledTimes(1)
 s.message({...tick,channels:[]});await vi.advanceTimersByTimeAsync(250)
 expect(usePaperTradingStore.getState().refresh).toHaveBeenCalledTimes(1)
 await vi.advanceTimersByTimeAsync(35_001);expect(hasFreshLiveSync()).toBe(false)
 stop();expect(s.off).toHaveBeenCalledTimes(3)
})
it('ignores other venues, modes and an obsolete account; reconnect clears push readiness',async()=>{
 const s=socket();let current=true;const stop=subscribeLiveTradingSync(s.ws,()=>current)
 s.message({...tick,venue:'gate'});s.message({...tick,trading_mode:'virtual'})
 await vi.advanceTimersByTimeAsync(250);expect(usePaperTradingStore.getState().refresh).not.toHaveBeenCalled()
 s.message(tick);s.state('disconnected');expect(hasFreshLiveSync()).toBe(false)
 current=false;await vi.advanceTimersByTimeAsync(250);expect(usePaperTradingStore.getState().refresh).not.toHaveBeenCalled()
 current=true;s.open();await vi.advanceTimersByTimeAsync(250)
 expect(usePaperTradingStore.getState().refresh).toHaveBeenCalledTimes(1)
 expect(hasFreshLiveSync()).toBe(false)
 stop()
})
