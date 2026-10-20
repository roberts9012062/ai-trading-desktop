import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import type {LocalRecord} from './local-records'
const state=vi.hoisted(()=>({native:true,values:new Map<string,string>(),records:new Map<string,LocalRecord>(),invoke:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({invoke:state.invoke}))
vi.mock('./collection-config',()=>({nativeCollection:()=>state.native,collectionScope:()=>`https://business:${JSON.parse(state.values.get('qihuo_auth_user')||'{}').id}`}))
import {tryLocalRecordRequest,syncDesktopRecords} from './local-records'
const key=(scope:string,collection:string,id:string)=>`${scope}|${collection}|${id}`
beforeEach(()=>{
  state.native=true;state.values.clear();state.records.clear()
  state.values.set('qihuo_auth_user',JSON.stringify({id:'user-a',trading_mode:'live'}));state.values.set('access_token','session')
  vi.stubGlobal('localStorage',{getItem:(name:string)=>state.values.get(name)??null})
  vi.stubGlobal('window',{dispatchEvent:vi.fn()});vi.stubGlobal('__QH_API_BASE__','')
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('business server offline')))
  state.invoke.mockImplementation(async(command:string,args:{scope:string;action:string;collection:string;id:string;value:Record<string,unknown>})=>{
    expect(command).toBe('desktop_db')
    const {scope,action,collection,id,value}=args
    const identity=key(scope,collection,id),saved=state.records.get(identity)
    const own=[...state.records].filter(([name])=>name.startsWith(scope+'|')).map(([,row])=>row)
    if(action==='list')return own.filter(row=>row.collection===collection&&!row.deleted)
    if(action==='get')return saved??null
    if(action==='pending')return own.filter(row=>row.dirty)
    if(action==='put'||action==='delete'){
      const row={collection,id,value:action==='delete'?{}:value,revision:(saved?.revision??0)+1,base_version:saved?.base_version??'',dirty:true,deleted:action==='delete',updated_at:1000}
      state.records.set(identity,row);return row
    }
    if(action==='status')return {pending:own.filter(row=>row.dirty).length,conflicts:0}
    if(action==='ack'&&saved){saved.base_version=String(value.version);if(saved.revision===value.revision)saved.dirty=false}
    return {ok:true}
  })
})
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals()})

it('keeps watchlist and notification edits in native SQL with the business server blocked',async()=>{
  const created=await (await tryLocalRecordRequest('/api/watchlist',{method:'POST',body:JSON.stringify({contract_symbol:'btcusdt',contract_name:'BTC'})}))!.json()
  expect(created.contract_symbol).toBe('btcusdt')
  await tryLocalRecordRequest('/api/users/me/notify-settings',{method:'PUT',body:'{"notify_trade":false}'})
  const listed=await (await tryLocalRecordRequest('/api/watchlist'))!.json()
  expect(listed).toHaveLength(1)
  expect(await (await tryLocalRecordRequest('/api/users/me/notify-settings'))!.json()).toMatchObject({notify_trade:false,notify_fund:true})
  expect(fetch).not.toHaveBeenCalled()
  state.values.set('qihuo_auth_user',JSON.stringify({id:'user-a',trading_mode:'virtual'}))
  expect(await (await tryLocalRecordRequest('/api/watchlist'))!.json()).toEqual([])
  state.values.set('qihuo_auth_user',JSON.stringify({id:'user-b',trading_mode:'live'}))
  expect(await (await tryLocalRecordRequest('/api/watchlist'))!.json()).toEqual([])
})

it('does not acknowledge or erase local edits when sync cannot connect',async()=>{
  await tryLocalRecordRequest('/api/watchlist',{method:'POST',body:'{"contract_symbol":"ethusdt","contract_name":"ETH"}'})
  await expect(syncDesktopRecords()).rejects.toThrow('本机记录已保留')
  expect([...state.records.values()][0].dirty).toBe(true)
  expect(state.invoke.mock.calls.some(([,args])=>['ack','merge'].includes(args.action))).toBe(false)
})

it('never uploads financial records and acknowledges the captured revision even if another local edit occurs',async()=>{
  const created=await (await tryLocalRecordRequest('/api/watchlist',{method:'POST',body:'{"contract_symbol":"btcusdt","contract_name":"BTC"}'}))!.json()
  const scope='https://business:user-a:records:live'
  state.records.set(key(scope,'orders','private-command'),{collection:'orders',id:'private-command',value:{secret:'must-not-upload'},base_version:'',dirty:true,deleted:false,revision:1,updated_at:1})
  let finish!:(response:Response)=>void
  vi.mocked(fetch).mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const syncing=syncDesktopRecords()
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce())
  const body=JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
  expect(body.records).toHaveLength(1);expect(JSON.stringify(body)).not.toContain('must-not-upload')
  expect(body.records[0].revision).toBe(1)
  await tryLocalRecordRequest(`/api/watchlist/${created.id}`,{method:'PUT',body:'{"group_name":"new-local-edit"}'})
  finish(new Response(JSON.stringify({subject:'user-a',trading_mode:'live',records:[],conflicts:[],acks:[{collection:'watchlist',id:created.id,revision:1,version:'a'.repeat(64)}]})))
  await syncing
  const current=state.records.get(key(scope,'watchlist',created.id))!
  expect(current.revision).toBe(2);expect(current.dirty).toBe(true);expect(current.value.group_name).toBe('new-local-edit')
})

it('refuses an old account response after the session switches during synchronization',async()=>{
  await tryLocalRecordRequest('/api/watchlist',{method:'POST',body:'{"contract_symbol":"solusdt","contract_name":"SOL"}'})
  let finish!:(response:Response)=>void
  vi.mocked(fetch).mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const syncing=syncDesktopRecords()
  const rejected=expect(syncing).rejects.toThrow('已切换')
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce())
  state.values.set('qihuo_auth_user',JSON.stringify({id:'user-b',trading_mode:'live'}))
  finish(new Response(JSON.stringify({records:[],acks:[],conflicts:[]})))
  await rejected
  expect(state.invoke.mock.calls.some(([,args])=>['ack','merge'].includes(args.action))).toBe(false)
})

it('leaves normal browser and server-only task creation requests on the server path',async()=>{
  expect(await tryLocalRecordRequest('/api/ai-trading/tasks',{method:'POST',body:'{}'})).toBeNull()
  state.native=false
  expect(await tryLocalRecordRequest('/api/watchlist')).toBeNull()
})

it.each([{subject:'user-b',trading_mode:'live'},{subject:'user-a',trading_mode:'virtual'}])('rejects a wrong owner or trading mode before any acknowledgement: %o',async(identity)=>{
  await tryLocalRecordRequest('/api/watchlist',{method:'POST',body:'{"contract_symbol":"btcusdt","contract_name":"BTC"}'})
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({...identity,records:[],acks:[],conflicts:[]})))
  await expect(syncDesktopRecords()).rejects.toThrow('不匹配')
  expect([...state.records.values()][0].dirty).toBe(true)
  expect(state.invoke.mock.calls.some(([,args])=>['ack','merge'].includes(args.action))).toBe(false)
})

it('rejects an invalid acknowledgement before clearing any earlier valid revision',async()=>{
  await tryLocalRecordRequest('/api/watchlist',{method:'POST',body:'{"contract_symbol":"btcusdt","contract_name":"BTC"}'})
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({subject:'user-a',trading_mode:'live',records:[],conflicts:[],acks:[
    {collection:'watchlist',id:'btcusdt',revision:1,version:'a'.repeat(64)},
    {collection:'orders',id:'unknown',revision:1,version:'b'.repeat(64)},
  ]})))
  await expect(syncDesktopRecords()).rejects.toThrow('无效的同步确认')
  expect([...state.records.values()][0].dirty).toBe(true)
  expect(state.invoke.mock.calls.some(([,args])=>['ack','merge'].includes(args.action))).toBe(false)
})
