import {afterEach,expect,it,vi} from 'vitest'
vi.mock('./desktop-exchange',()=>({tryDesktopLiveRequest:async()=>null}))
import {AITradingRequestError,request} from './ai-trading-api'
afterEach(()=>vi.unstubAllGlobals())
it('preserves an explicit busy code without treating every conflict as retryable',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({detail:'等待交接',code:'execution_busy'}),{status:409})))
  await expect(request('/api/ai-trading/tasks/task/realtime/start')).rejects.toMatchObject({status:409,code:'execution_busy',message:'等待交接'})
})
it('retains ordinary error messages and statuses',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({detail:'已有执行客户端'}),{status:409})))
  const result=await request('/api/ai-trading/tasks/task/realtime/start').catch(e=>e)
  expect(result).toBeInstanceOf(AITradingRequestError)
  expect((result as AITradingRequestError).code).toBeUndefined()
})
