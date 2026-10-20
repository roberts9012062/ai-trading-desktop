import {beforeEach,expect,it,vi} from 'vitest'
const fixture=vi.hoisted(()=>({invoke:vi.fn(),scope:'https://business:user-a',generation:0,account:0,configured:true,user:{id:'user-a',trading_mode:'live'} as {id:string;trading_mode:string}|null,loaded:true}))
vi.mock('@tauri-apps/api/core',()=>({invoke:fixture.invoke,isTauri:()=>true}))
vi.mock('./collection-config',()=>({collectionMode:()=>true,collectionScope:()=>fixture.scope,collectionGeneration:()=>fixture.generation,collectionStatus:()=>({configured:fixture.configured}),onCollectionChange:()=>()=>{}}))
vi.mock('./local-desktop',()=>({localExchangeGeneration:()=>fixture.account}))
vi.mock('@/stores/auth',()=>({useAuthStore:{getState:()=>({user:fixture.user,loaded:fixture.loaded}),subscribe:()=>()=>{}}}))
import {syncExecutionContext,executionAction,executionStatus,readExecutionSnapshot} from './execution-runtime'
beforeEach(()=>{
  fixture.generation++;fixture.account++;fixture.scope='https://business:user-a';fixture.configured=true;fixture.user={id:'user-a',trading_mode:'live'};fixture.loaded=true
  vi.stubGlobal('localStorage',{getItem:(key:string)=>key==='access_token'?'server-jwt':null})
  vi.stubGlobal('window',{__QH_API_BASE__:'https://business'})
  fixture.invoke.mockReset().mockImplementation(async(command:string)=>command==='desktop_executor_context'?fixture.generation:command==='desktop_executor_status'?{prepared:true,runtime_installed:true,enabled:true,worker:{state:'waiting_executor'}}:{prepared:true})
})
it('restores only existing signed preparation through native IPC without business HTTP',async()=>{
  vi.stubGlobal('fetch',vi.fn())
  await syncExecutionContext(true)
  expect(fixture.invoke).toHaveBeenCalledWith('desktop_executor_start',expect.objectContaining({scope:fixture.scope}))
  expect(fixture.invoke).not.toHaveBeenCalledWith('desktop_executor_prepare',expect.anything())
  expect(fetch).not.toHaveBeenCalled()
  expect(executionStatus().worker.state).toBe('waiting_executor')
})
it('never starts an unprepared or missing compiled runtime',async()=>{
  fixture.invoke.mockImplementation(async(command:string)=>command==='desktop_executor_context'?fixture.generation:{prepared:false,runtime_installed:false,worker:{state:'not_prepared'}})
  await syncExecutionContext(true)
  expect(fixture.invoke.mock.calls.some(([command])=>command==='desktop_executor_start')).toBe(false)
})
it('does not undo a manual stop or infer auto-start permission from a saved bundle',async()=>{
  fixture.invoke.mockImplementation(async(command:string)=>command==='desktop_executor_context'?fixture.generation:{prepared:true,runtime_installed:true,enabled:false,worker:{state:'stopped'}})
  await syncExecutionContext(true)
  expect(fixture.invoke.mock.calls.some(([command])=>command==='desktop_executor_start')).toBe(false)
})
it('retires the native owner on logout and virtual-mode switches',async()=>{
  fixture.user=null
  await syncExecutionContext(true)
  expect(fixture.invoke).toHaveBeenLastCalledWith('desktop_executor_context',{scope:null})
  fixture.user={id:'user-a',trading_mode:'virtual'}
  await syncExecutionContext(true)
  expect(fixture.invoke.mock.calls.some(([command])=>command==='desktop_executor_start')).toBe(false)
})
it('discards an old context result after switching accounts',async()=>{
  fixture.invoke.mockImplementation(async(command:string)=>{if(command==='desktop_executor_context'){fixture.scope='https://business:user-b';return fixture.generation}return {prepared:true,runtime_installed:true,worker:{state:'running'}}})
  await expect(syncExecutionContext(true)).rejects.toThrow('账号')
  expect(fixture.invoke.mock.calls.some(([command])=>command==='desktop_executor_start')).toBe(false)
})
it('requires a current server token for preparation and never treats cache as task authorization',async()=>{
  vi.stubGlobal('localStorage',{getItem:()=>null})
  await expect(executionAction('prepare')).rejects.toThrow('服务器登录')
  expect(fixture.invoke.mock.calls.some(([command])=>command==='desktop_executor_prepare')).toBe(false)
})
it('a late logout completion cannot clear the newly selected account status',async()=>{
  let release:((value:number)=>void)|undefined
  fixture.user=null
  fixture.invoke.mockImplementation(async(command:string,args:{scope:string|null})=>command==='desktop_executor_context'?(args.scope===null?new Promise<number>(resolve=>{release=resolve}):fixture.generation):{prepared:true,runtime_installed:true,enabled:false,worker:{state:'running'}})
  const old=syncExecutionContext().catch(error=>error)
  await vi.waitFor(()=>expect(release).toBeDefined())
  fixture.user={id:'user-b',trading_mode:'live'};fixture.scope='https://business:user-b';fixture.generation++
  const newest=syncExecutionContext()
  // Context dispatch is serialized: old logout cannot arrive at native after
  // the new login and clear its newly started worker.
  expect(fixture.invoke.mock.calls.some(([command,args])=>command==='desktop_executor_context'&&args.scope===fixture.scope)).toBe(false)
  release!(1)
  await newest
  expect((await old).message).toContain('账号')
  expect(executionStatus().worker.state).toBe('running')
})
it('rechecks the native generation after a failed update without requiring a renderer reload',async()=>{
  let nativeGeneration=10
  fixture.invoke.mockImplementation(async(command:string)=>command==='desktop_executor_context'?nativeGeneration:{prepared:true,runtime_installed:true,enabled:false,worker:{state:'stopped'}})
  await syncExecutionContext()
  nativeGeneration=11
  await executionAction('start')
  expect(fixture.invoke).toHaveBeenCalledWith('desktop_executor_start',expect.objectContaining({generation:11,restore:false}))
})
it('reads committed task snapshots through native IPC without server HTTP or starting a worker',async()=>{
  const snapshot={available:true,checkpoint_seq:7,pending_checkpoint:false,truncated:false,tasks:[]}
  const original=fixture.invoke.getMockImplementation()!
  fixture.invoke.mockImplementation(async(command:string,...args:unknown[])=>command==='desktop_executor_snapshot'?snapshot:original(command,...args))
  vi.stubGlobal('fetch',vi.fn())
  expect(await readExecutionSnapshot()).toEqual(snapshot)
  expect(fixture.invoke).toHaveBeenCalledWith('desktop_executor_snapshot',expect.objectContaining({scope:fixture.scope}))
  expect(fixture.invoke.mock.calls.some(([command])=>['desktop_executor_start','desktop_executor_prepare'].includes(command))).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})
it('discards a task snapshot arriving after an account switch',async()=>{
  const original=fixture.invoke.getMockImplementation()!
  fixture.invoke.mockImplementation(async(command:string,...args:unknown[])=>{
    if(command==='desktop_executor_snapshot'){fixture.scope='https://business:user-b';return {available:true,tasks:[{name:'old task'}]}}
    return original(command,...args)
  })
  await expect(readExecutionSnapshot()).rejects.toThrow('账号')
})
it('a snapshot reader mounting first cannot suppress the opted-in boot restore',async()=>{
  let release:((generation:number)=>void)|undefined
  const original=fixture.invoke.getMockImplementation()!
  fixture.invoke.mockImplementation(async(command:string,...args:unknown[])=>command==='desktop_executor_context'?new Promise<number>(resolve=>{release=resolve}):command==='desktop_executor_snapshot'?{available:false,tasks:[]}:original(command,...args))
  const reading=readExecutionSnapshot()
  await vi.waitFor(()=>expect(release).toBeDefined())
  const restoring=syncExecutionContext(true)
  release!(fixture.generation)
  await Promise.all([reading,restoring])
  expect(fixture.invoke).toHaveBeenCalledWith('desktop_executor_start',expect.objectContaining({restore:true}))
})
it('skips a superseded queued account before changing the native owner',async()=>{
  let release:((generation:number)=>void)|undefined
  const firstScope=fixture.scope,original=fixture.invoke.getMockImplementation()!
  fixture.invoke.mockImplementation(async(command:string,args:{scope:string|null})=>command==='desktop_executor_context'&&args.scope===firstScope?new Promise<number>(resolve=>{release=resolve}):original(command,args))
  const first=syncExecutionContext().catch(error=>error)
  await vi.waitFor(()=>expect(release).toBeDefined())
  fixture.user={id:'user-b',trading_mode:'live'};fixture.scope='https://business:user-b';fixture.generation++
  const superseded=syncExecutionContext().catch(error=>error)
  fixture.user={id:'user-c',trading_mode:'live'};fixture.scope='https://business:user-c';fixture.generation++
  const latest=syncExecutionContext()
  release!(1)
  await Promise.all([first,superseded,latest])
  expect(fixture.invoke.mock.calls.filter(([command])=>command==='desktop_executor_context').map(([,args])=>args.scope)).toEqual([firstScope,'https://business:user-c'])
})
it('renderer boot hydration never sends a logout or stops an existing native worker',async()=>{
  fixture.loaded=false
  await syncExecutionContext(true)
  expect(fixture.invoke).not.toHaveBeenCalled()
  fixture.loaded=true
  await syncExecutionContext(true)
  expect(fixture.invoke.mock.calls.some(([command,args])=>command==='desktop_executor_context'&&args.scope===null)).toBe(false)
  expect(fixture.invoke).toHaveBeenCalledWith('desktop_executor_start',expect.objectContaining({restore:true}))
})
