import type {KlineBar,TradeRecord,OrderBook} from '@/types'
import type {ChartSubscriptionKey,ConnectionState,MessageHandler,StateHandler} from './websocket'
import {collectionStatus,collectionGeneration,collectionScope,loadCollectionConfig,onCollectionChange,refreshCollectionPermissions,collectionIssue,collectionReceived} from './collection-config'
import {COLLECTION_PERIODS,collectionTicket,ticketAddress,collectionSymbol,desktopSymbol,mapCollectionBar,mapCollectionQuote,mapCollectionTrade,collectionData,collectionSpec,type CollectionTick,type CollectionBar,type CollectionQuote} from './collection-api'

export function mergeCollectionTrades(previous:TradeRecord[],incoming:TradeRecord[]):TradeRecord[]{
  const rows=new Map([...previous,...incoming].map(row=>[row.trade_id,row]))
  return [...rows.values()].sort((a,b)=>Number(b.ts)-Number(a.ts)).slice(0,100)
}
export function candleGroups(keys:ChartSubscriptionKey[]){
  const groups=new Map<string,string[]>()
  for(const {symbol,period} of keys)if(COLLECTION_PERIODS[period]&&/^[a-z0-9]{1,16}usdt$/.test(symbol)){
    const periods=groups.get(symbol)||[];if(!periods.includes(period))periods.push(period);groups.set(symbol,periods)
  }
  return [...groups].map(([symbol,periods])=>({symbol,periods}))
}
type Frame={kind:string;code?:string;symbol:string;resolution?:string;payload?:{records:CollectionBar[];ticks:CollectionTick[];quote:CollectionQuote|null;order_book?:{timestamp:number;bids:{price:number;volume:number}[];asks:{price:number;volume:number}[];volume_unit:string}|null}}
const fatal=(message:string)=>/not_entitled|invalid_or_expired|unauthorized|key_rotated|revoked|user_disabled/.test(message)

class Channel {
  private socket:WebSocket|null=null
  private timer:ReturnType<typeof setTimeout>|null=null
  private timeout:ReturnType<typeof setTimeout>|null=null
  private alive=true
  private attempt=0
  constructor(private query:Record<string,unknown>,private frame:(value:Frame)=>void,private changed:(state:ConnectionState)=>void){void this.open()}
  private async open(){
    if(!this.alive)return
    this.changed(this.attempt?'reconnecting':'connecting')
    const generation=collectionGeneration(),scope=collectionScope()
    try {
      const ticket=await collectionTicket({...this.query,seconds:45})
      if(!this.alive||generation!==collectionGeneration()||scope!==collectionScope())return
      const socket=new WebSocket(ticketAddress(ticket.url));this.socket=socket
      this.timeout=setTimeout(()=>this.retry(),55000)
      socket.onopen=()=>{if(this.alive)this.changed('connected')}
      socket.onmessage=event=>{
        if(!this.alive||generation!==collectionGeneration()||scope!==collectionScope())return
        try{
          const value=JSON.parse(event.data) as Frame
          if(value.kind==='error'){collectionIssue(value.code||'行情推送异常');if(fatal(value.code||'')){this.stop();return}this.retry();return}
          if(value.kind==='symbol_error'){collectionIssue(value.code||'部分合约暂不可用');return}
          if(value.payload){this.frame(value);this.attempt=0}
        }catch{collectionIssue('行情字段校验失败')}
      }
      socket.onclose=()=>this.retry()
      socket.onerror=()=>this.retry()
    }catch(error){const msg=error instanceof Error?error.message:String(error);collectionIssue(msg);if(!fatal(msg))this.retry();else this.stop()}
  }
  private detach(){if(this.timeout)clearTimeout(this.timeout);this.timeout=null;const old=this.socket;this.socket=null;if(old){old.onopen=old.onclose=old.onerror=old.onmessage=null;old.close()}}
  private retry(){if(!this.alive||this.timer)return;this.detach();this.changed('reconnecting');const delay=Math.min(30000,500*2**Math.min(this.attempt++,6))+Math.random()*300;this.timer=setTimeout(()=>{this.timer=null;void this.open()},delay)}
  stop(){this.alive=false;if(this.timer)clearTimeout(this.timer);this.timer=null;this.detach();this.changed('disconnected')}
}

export class CollectionMarketStream {
  state:ConnectionState='disconnected'
  private running=false
  private quotes:string[]=[]
  private depths:string[]=[]
  private charts:ChartSubscriptionKey[]=[]
  private channels=new Map<string,Channel>()
  private handlers=new Set<MessageHandler>()
  private states=new Set<StateHandler>()
  private quoteStates=new Set<StateHandler>()
  private freshnessHandlers=new Set<(symbols:string[])=>void>()
  private quoteAt=new Map<string,number>()
  private depthAt=new Map<string,number>()
  private candleAt=new Map<string,number>()
  private recent=new Map<string,TradeRecord[]>()
  private pending:ReturnType<typeof setTimeout>|null=null
  private recovery:ReturnType<typeof setTimeout>|null=null
  private epoch=0
  private scope=''
  private generation=-1
  private limit=5
  private subscriptions=100
  constructor(){onCollectionChange(()=>{if(this.generation!==collectionGeneration()){this.disconnect();this.connect()}})}
  onMessage(handler:MessageHandler){this.handlers.add(handler);return()=>{this.handlers.delete(handler)}}
  onStateChange(handler:StateHandler){this.states.add(handler);return()=>{this.states.delete(handler)}}
  onQuoteStateChange(handler:StateHandler){this.quoteStates.add(handler);return()=>{this.quoteStates.delete(handler)}}
  onQuoteFreshnessChange(handler:(symbols:string[])=>void){this.freshnessHandlers.add(handler);return()=>{this.freshnessHandlers.delete(handler)}}
  private emit(type:string,data:unknown){this.handlers.forEach(fn=>fn({type,data}))}
  connect(){if(this.running)return;this.running=true;this.scope=collectionScope();this.generation=collectionGeneration();void this.prepare()}
  private async prepare(){
    const epoch=this.epoch
    await loadCollectionConfig()
    if(!this.running||epoch!==this.epoch||!collectionStatus().configured)return
    try{
      const data=await refreshCollectionPermissions();if(!this.running||epoch!==this.epoch)return
      const grants=data.active_packages.filter(g=>g.markets.includes('crypto'))
      if(!grants.length){collectionIssue('当前 Key 未开通加密货币行情');return}
      this.limit=Math.max(1,...grants.map(g=>g.connections));this.subscriptions=Math.max(0,...grants.map(g=>g.market_subscriptions?.crypto??100))
      this.schedule()
    }catch(error){const message=error instanceof Error?error.message:String(error);collectionIssue(message);if(this.running&&!fatal(message))this.recovery=setTimeout(()=>{this.recovery=null;void this.prepare()},5000)}
  }
  disconnect(){if(this.recovery)clearTimeout(this.recovery);this.recovery=null;this.running=false;this.epoch++;if(this.pending)clearTimeout(this.pending);this.pending=null;for(const ch of this.channels.values())ch.stop();this.channels.clear();this.quoteAt.clear();this.depthAt.clear();this.candleAt.clear();this.recent.clear();this.state='disconnected'}
  setQuoteSymbols(symbols:string[]){this.quotes=[...new Set(symbols)].filter(s=>/^[a-z0-9]{1,16}usdt$/.test(s));this.schedule()}
  setDepthSymbols(symbols:string[]){this.depths=[...new Set(symbols)].filter(s=>/^[a-z0-9]{1,16}usdt$/.test(s));this.schedule()}
  setChartSubscription(keys:ChartSubscriptionKey[]){this.charts=keys;this.schedule()}
  observeVersion(_version:number|undefined){}
  hasFreshQuote(symbol:string){return Date.now()-(this.quoteAt.get(symbol)||0)<15000}
  hasFreshDepth(symbol:string){return Date.now()-(this.depthAt.get(symbol)||0)<15000}
  hasFreshCandle(symbol:string,period:string){return Date.now()-(this.candleAt.get(symbol+':'+period)||0)<15000}
  private schedule(){if(!this.running||this.pending||!collectionStatus().permissions)return;this.pending=setTimeout(()=>{this.pending=null;this.sync()},100)}
  private sync(){
    if(!this.running||this.scope!==collectionScope())return
    const grants=collectionStatus().permissions?.active_packages.filter(g=>g.markets.includes('crypto'))||[]
    const entitled=(op:string)=>grants.some(g=>g.capabilities.includes(op))
    const desired=new Map<string,Record<string,unknown>>()
    const selected=this.depths[0]||this.charts[0]?.symbol
    const symbols=[...new Set([...(selected?[selected]:[]),...this.quotes])].slice(0,this.subscriptions)
    if(entitled('stream_quotes')) for(let start=0;start<Math.min(symbols.length,200);start+=100){const batch=symbols.slice(start,start+100);desired.set('quotes:'+batch.join(','),{market_type:'crypto',exchange:'okx',operation:'stream_quotes',symbols:batch.map(collectionSymbol)})}
    if(selected&&entitled('stream_quotes')&&!entitled('stream_ticks'))desired.set('depth:'+selected,{market_type:'crypto',exchange:'okx',symbol:collectionSymbol(selected),operation:'stream_quotes',depth:true})
    if(selected&&entitled('stream_ticks'))desired.set('trades:'+selected,{market_type:'crypto',exchange:'okx',symbol:collectionSymbol(selected),operation:'stream_ticks',depth:entitled('stream_quotes')})
    // Reserve a connection for history/HTTP. Every period for one symbol shares a WS.
    const budget=Math.max(0,this.limit-1)
    for(const group of candleGroups(this.charts))if(desired.size<budget&&entitled('stream_bars'))desired.set('candles:'+group.symbol+':'+group.periods.join(','),{market_type:'crypto',exchange:'okx',symbol:collectionSymbol(group.symbol),operation:'stream_bars',resolution:COLLECTION_PERIODS[group.periods[0]],resolutions:group.periods.map(p=>COLLECTION_PERIODS[p])})
    while(desired.size>budget){const last=[...desired.keys()].at(-1);if(last)desired.delete(last);else break}
    for(const [key,ch] of this.channels)if(!desired.has(key)){ch.stop();this.channels.delete(key)}
    for(const [key,query] of desired)if(!this.channels.has(key)){
      const channel=new Channel(query,frame=>this.receive(frame),state=>{
        if(key.startsWith('candles:')){this.state=state;this.states.forEach(fn=>fn(state))}
        else this.quoteStates.forEach(fn=>fn(state))
      });this.channels.set(key,channel)
      if(key.startsWith('trades:')&&selected&&entitled('ticks')){
        const epoch=this.epoch
        void collectionData({market_type:'crypto',exchange:'okx',symbol:collectionSymbol(selected),operation:'ticks',count:100}).then(data=>{if(epoch===this.epoch)this.receive({kind:'recent_trades',symbol:collectionSymbol(selected),payload:{records:[],ticks:data.ticks,quote:null}})}).catch(()=>{})
      }
    }
  }
  private receive(frame:Frame){
    collectionReceived()
    const symbol=desktopSymbol(frame.symbol),payload=frame.payload
    if(!payload)return
    if(payload.quote){const quote=mapCollectionQuote(symbol,payload.quote);this.quoteAt.set(symbol,Date.now());this.emit('quote',[quote]);this.freshnessHandlers.forEach(fn=>fn([...this.quoteAt.keys()].filter(s=>this.hasFreshQuote(s))))}
    if(payload.order_book){const book=payload.order_book;this.depthAt.set(symbol,Date.now());this.emit('orderbook',[{symbol,asks:book.asks,bids:book.bids,asof:book.timestamp,volume_unit:book.volume_unit,source:'lium-okx',stale:false} satisfies OrderBook])}
    if(payload.ticks?.length){const rows=payload.ticks.map(mapCollectionTrade);const merged=mergeCollectionTrades(this.recent.get(symbol)||[],rows);this.recent.set(symbol,merged);this.emit('trades',{[symbol]:merged})}
    if(payload.records?.length&&frame.resolution){const period=Object.keys(COLLECTION_PERIODS).find(p=>COLLECTION_PERIODS[p]===frame.resolution);if(period){this.candleAt.set(symbol+':'+period,Date.now());this.emit('chart_kline',payload.records.map(row=>({symbol,period,bar:mapCollectionBar(row,period)})))}}
  }
}
let singleton:CollectionMarketStream|undefined
export function getCollectionStream(){return singleton??=new CollectionMarketStream()}
