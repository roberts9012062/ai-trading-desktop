import {collectionMode,collectionGeneration,collectionStatus,loadCollectionConfig,onCollectionChange} from './collection-config'
import {directOkxMode} from './market-provider'
import {getCollectionStream} from './collection-stream'
import {getOkxSnippetWebSocket} from './okx-snippet-ws'
import type {ChartSubscriptionKey,ConnectionState,MessageHandler,StateHandler} from './websocket'

/** Stable subscriptions survive scoped key changes. Only the selected transport
 * may publish, including callbacks already queued by a retired socket. */
class PublicMarketSocket {
  private active:ReturnType<typeof getCollectionStream>|ReturnType<typeof getOkxSnippetWebSocket>|null=null
  private running=false
  private epoch=-1
  private binding=0
  private cleanup:(()=>void)[]=[]
  private quotes:string[]=[]
  private depths:string[]=[]
  private charts:ChartSubscriptionKey[]=[]
  private messages=new Set<MessageHandler>()
  private states=new Set<StateHandler>()
  private quoteStates=new Set<StateHandler>()
  private freshness=new Set<(symbols:string[])=>void>()
  constructor(){onCollectionChange(()=>this.sync())}
  get state():ConnectionState{return this.active?.state??'disconnected'}
  private release(){
    this.binding++
    for(const off of this.cleanup)off()
    this.cleanup=[]
    const old=this.active;this.active=null;old?.disconnect()
  }
  private sync(){
    if(!this.running)return
    if(collectionMode()&&collectionStatus().loading){this.release();return}
    const next=collectionMode()&&!directOkxMode()?getCollectionStream():getOkxSnippetWebSocket()
    const epoch=collectionGeneration()
    if(this.active===next&&this.epoch===epoch)return
    this.release();this.active=next;this.epoch=epoch
    const binding=this.binding
    const current=()=>this.active===next&&this.binding===binding
    this.cleanup=[
      next.onMessage(message=>{if(current())this.messages.forEach(fn=>fn(message))}),
      next.onStateChange(state=>{if(current())this.states.forEach(fn=>fn(state))}),
      next.onQuoteStateChange(state=>{if(current())this.quoteStates.forEach(fn=>fn(state))}),
      next.onQuoteFreshnessChange(symbols=>{if(current())this.freshness.forEach(fn=>fn(symbols))}),
    ]
    next.setQuoteSymbols(this.quotes);next.setDepthSymbols(this.depths);next.setChartSubscription(this.charts);next.connect()
  }
  connect(){this.running=true;if(collectionMode())void loadCollectionConfig().then(()=>this.sync());else this.sync()}
  disconnect(){this.running=false;this.release()}
  onMessage(fn:MessageHandler){this.messages.add(fn);return()=>{this.messages.delete(fn)}}
  onStateChange(fn:StateHandler){this.states.add(fn);return()=>{this.states.delete(fn)}}
  onQuoteStateChange(fn:StateHandler){this.quoteStates.add(fn);return()=>{this.quoteStates.delete(fn)}}
  onQuoteFreshnessChange(fn:(symbols:string[])=>void){this.freshness.add(fn);return()=>{this.freshness.delete(fn)}}
  setQuoteSymbols(symbols:string[]){this.quotes=[...symbols];this.active?.setQuoteSymbols(symbols)}
  setDepthSymbols(symbols:string[]){this.depths=[...symbols];this.active?.setDepthSymbols(symbols)}
  setChartSubscription(keys:ChartSubscriptionKey[]){this.charts=[...keys];this.active?.setChartSubscription(keys)}
  observeVersion(version:number|undefined){this.active?.observeVersion(version)}
  hasFreshQuote(symbol:string){return this.active?.hasFreshQuote(symbol)??false}
  hasFreshDepth(symbol:string){return this.active?.hasFreshDepth(symbol)??false}
  hasFreshCandle(symbol:string,period:string){return this.active?.hasFreshCandle(symbol,period)??false}
}
let singleton:PublicMarketSocket|undefined
export const getPublicMarketSocket=()=>collectionMode()?(singleton??=new PublicMarketSocket()):getOkxSnippetWebSocket()
