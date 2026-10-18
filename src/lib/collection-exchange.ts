import { COLLECTION_BASE, collectionRequest, collectionStatus, collectionScope, collectionGeneration, loadCollectionConfig, refreshCollectionPermissions } from './collection-config'
import { collectionTicket, collectionHttpSlot } from './collection-api'

const reads=new Set(['account/balance','account/positions','account/positions-history','account/config','account/leverage-info','account/trade-fee','account/bills','account/bills-archive','trade/orders-pending','trade/orders-history','trade/orders-history-archive','trade/order','trade/fills','trade/fills-history','trade/orders-algo-pending','trade/orders-algo-history','trade/order-algo','public/instruments','public/time'])
const writes=new Set(['trade/order','trade/batch-orders','trade/cancel-order','trade/cancel-batch-orders','trade/amend-order','trade/amend-batch-orders','trade/close-position','account/set-leverage','account/set-position-mode','trade/order-algo','trade/cancel-algos','trade/amend-algos'])

export function collectionPrivateAddress(raw:string,ws=false):string{
  const url=new URL(raw,COLLECTION_BASE)
  if(url.origin!==COLLECTION_BASE||url.username||url.password||url.hash||url.pathname!==(ws?'/edge/okx-ws':'/edge/okx')||[...url.searchParams.keys()].some(k=>k!=='ticket')||!url.searchParams.get('ticket'))throw new Error('无效的交易所接口票据')
  if(ws)url.protocol='wss:'
  return url.href
}
export async function requireCollectionPrivate(operation='okx_private'){
  await loadCollectionConfig()
  if(!collectionStatus().configured)throw new Error('请先在个人中心 → 数据配置填写 API VALUE COLLECTION Key')
  const permissions=collectionStatus().permissions??await refreshCollectionPermissions()
  if(!permissions.active_packages.some(g=>g.markets.includes('crypto')&&g.capabilities.includes(operation)))throw new Error(`API VALUE COLLECTION Key 未开通${operation==='okx_private_ws'?'私有账户推送':'交易所账户接口'}权限`)
}
export function signedCollectionBody(frame:Record<string,unknown>){
  const method=String(frame.method),full=String(frame.path),[path,query='']=full.split('?')
  const route=path.replace(/^\/api\/v5\//,'')
  if(!path.startsWith('/api/v5/')||!(method==='GET'?reads:method==='POST'?writes:new Set()).has(route)||full.includes('#')||full.includes('\\')||full.length>4096)throw new Error('不支持的交易所请求')
  const headers=new Headers(frame.headers as HeadersInit)
  const body=method==='POST'?String(frame.body??''):''
  if(body.length>65536)throw new Error('交易所请求超出限制')
  const publicRead=method==='GET'&&route.startsWith('public/')
  const field=(name:string)=>{const value=headers.get(name);if(!value&&!publicRead)throw new Error('交易所签名不完整');return value||'public'}
  return {method,path,query,body,access_key:field('OK-ACCESS-KEY'),signature:field('OK-ACCESS-SIGN'),timestamp:field('OK-ACCESS-TIMESTAMP'),passphrase:field('OK-ACCESS-PASSPHRASE'),simulated:headers.get('x-simulated-trading')==='1'}
}
let activeRpc:{tail:Promise<unknown>}|null=null
// Reserve transport before requesting any business signature. Waiting after
// signing used to consume the relay's 15s response window and expire requests.
export async function collectionRpcSlot<T>(work:()=>Promise<T>,priority=1):Promise<T>{
  await loadCollectionConfig()
  const generation=collectionGeneration(),scope=collectionScope()
  return collectionHttpSlot(async()=>{
    if(generation!==collectionGeneration()||scope!==collectionScope())throw new Error('会话或数据配置已变化')
    const lease={tail:Promise.resolve() as Promise<unknown>}
    activeRpc=lease
    try{return await work()}
    finally{await lease.tail.catch(()=>{});if(activeRpc===lease)activeRpc=null}
  },priority)
}
function signedHttpSlot<T>(work:()=>Promise<T>):Promise<T>{
  const lease=activeRpc
  if(!lease)return collectionHttpSlot(work,1)
  // A single business call may request several exchange endpoints. They share
  // its reservation instead of deadlocking on the outer HTTP queue.
  const next=lease.tail.catch(()=>{}).then(work)
  lease.tail=next
  return next
}
export async function forwardCollectionExchange(frame:Record<string,unknown>,canSend=()=>true){
  const request=signedCollectionBody(frame),generation=collectionGeneration(),scope=collectionScope()
  const current=()=>canSend()&&generation===collectionGeneration()&&scope===collectionScope()
  await requireCollectionPrivate()
  return signedHttpSlot(async()=>{
    if(!current())throw new Error('交易所查询已取消')
    const ticket=await collectionTicket({market_type:'crypto',exchange:'okx',symbol:'BTC-USDT-SWAP',operation:'okx_private'})
    if(!current())throw new Error('交易所查询已取消')
    const address=new URL(collectionPrivateAddress(ticket.url))
    const result=await collectionRequest<{raw:string}>(address.pathname+address.search,request)
    if(!current())throw new Error('会话或数据配置已变化')
    const data=JSON.parse(result.raw)
    if(!data||typeof data.code!=='string'||!Array.isArray(data.data))throw new Error('交易所返回数据格式异常')
    return {status:200,data}
  })
}
export async function collectionPrivateSocketAddress(simulated=false){
  await requireCollectionPrivate('okx_private_ws')
  const ticket=await collectionTicket({market_type:'crypto',exchange:'okx',symbol:'BTC-USDT-SWAP',operation:'okx_private_ws',seconds:45,simulated})
  return collectionPrivateAddress(ticket.url,true)
}
