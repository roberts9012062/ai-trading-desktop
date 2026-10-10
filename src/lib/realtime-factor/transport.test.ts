import {beforeEach,afterEach,it,expect,vi} from 'vitest'
const fake=vi.hoisted(()=>({native:true,invoke:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>fake.native,invoke:fake.invoke}))
vi.mock('../desktop-exchange',()=>({tryDesktopLiveRequest:async()=>null}))
import {request} from '../ai-trading-api'
const path='/api/ai-trading/tasks/4dc5f123-cf27-445d-a980-ad7e3c543c65/realtime/heartbeat'
beforeEach(()=>{fake.native=true;vi.clearAllMocks();fake.invoke.mockResolvedValue({status:200,body:'{"expires_at":123}',headers:[]});vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{"expires_at":123}')))})
afterEach(()=>vi.unstubAllGlobals())
it('uses the persistent native connection for seconds heartbeats',async()=>{
  expect(await request(path,{method:'POST',body:'{"token":"synthetic"}'})).toEqual({expires_at:123})
  expect(fake.invoke).toHaveBeenCalledWith('realtime_http_request',expect.objectContaining({path,method:'POST',body:'{"token":"synthetic"}'}))
  expect(fetch).not.toHaveBeenCalled()
})
it('never replays a native request through another transport after an uncertain failure',async()=>{
  fake.invoke.mockRejectedValue(new Error('connection lost'))
  await expect(request(path,{method:'POST',body:'{}'})).rejects.toThrow('connection lost')
  expect(fetch).not.toHaveBeenCalled()
})
it('keeps browser requests on the existing fetch transport',async()=>{
  fake.native=false
  await request(path,{method:'POST',body:'{}'})
  expect(fake.invoke).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1)
})
it('preserves the server conflict status and busy handoff code on native responses',async()=>{
  fake.invoke.mockResolvedValue({status:409,body:'{"detail":"等待交接","code":"execution_busy"}',headers:[]})
  await expect(request(path,{method:'POST',body:'{}'})).rejects.toMatchObject({status:409,code:'execution_busy',message:'等待交接'})
})
it('turns a native timeout string into a visible error without replaying the request',async()=>{
  fake.invoke.mockRejectedValue('秒级服务器请求超时，停止续期')
  await expect(request(path,{method:'POST',body:'{}'})).rejects.toBeInstanceOf(Error)
  await expect(request(path,{method:'POST',body:'{}'})).rejects.toThrow('秒级服务器请求超时，停止续期')
  expect(fetch).not.toHaveBeenCalled()
})
