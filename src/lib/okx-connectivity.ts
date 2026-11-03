import {collectionScope,collectionGeneration} from './collection-config'
type Channel='market'|'stream'|'account'
type Source='direct'|'collection'
export interface ConnectivityContext {scope:string;generation:number}
export interface OkxConnectivityStatus {scope:string;warnings:{channel:Channel;source:Source}[]}
let status:OkxConnectivityStatus={scope:'',warnings:[]}
const listeners=new Set<()=>void>()
export const captureOkxConnectivity=():ConnectivityContext=>({scope:collectionScope(),generation:collectionGeneration()})
export function okxConnectivityStatus(){const scope=collectionScope();if(status.scope!==scope)status={scope,warnings:[]};return status}
export function onOkxConnectivityChange(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn)}}
function publish(next:OkxConnectivityStatus){status=next;listeners.forEach(fn=>fn())}
function active(context:ConnectivityContext){return context.scope===collectionScope()&&context.generation===collectionGeneration()}
export function okxReadUnavailable(context:ConnectivityContext,channel:Channel,source:Source){
 if(!active(context))return
 const current=okxConnectivityStatus()
 if(current.warnings.some(w=>w.channel===channel&&w.source===source))return
 publish({scope:context.scope,warnings:[...current.warnings.filter(w=>w.channel!==channel),{channel,source}]})
}
export function okxReadReceived(context:ConnectivityContext,channel:Channel){
 if(!active(context))return
 const current=okxConnectivityStatus();if(!current.warnings.some(w=>w.channel===channel))return
 publish({scope:context.scope,warnings:current.warnings.filter(w=>w.channel!==channel)})
}
export function clearOkxConnectivity(){publish({scope:collectionScope(),warnings:[]})}
