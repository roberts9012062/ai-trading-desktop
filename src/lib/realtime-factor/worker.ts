import type { KlineBar } from '@/types'

/** Dedicated instance: backtests/mining cannot queue in front of live scoring. */
export class FactorWorker {
  private worker = new Worker(new URL('../../workers/pyodide-backtest.worker.ts',import.meta.url),{type:'module'})
  private seq=0
  private pending=new Map<number,{resolve:(score: number)=>void; reject:(error: Error)=>void; timer:ReturnType<typeof setTimeout>}>()
  constructor() {
    this.worker.onmessage=event=>{
      const msg=event.data as {type: string;reqId: number;report?:{score:number};message?:string}
      if (msg.type==='error' && msg.reqId===0) { this.close(msg.message??'计算线程启动失败'); return }
      const p=this.pending.get(msg.reqId)
      if (!p || !['result','error'].includes(msg.type)) return
      clearTimeout(p.timer); this.pending.delete(msg.reqId)
      const score=msg.report?.score
      if (msg.type==='error' || typeof score!=='number' || !Number.isFinite(score)) p.reject(new Error(msg.message??'因子评分无效'))
      else p.resolve(score)
    }
    this.worker.onerror=event=>this.close(event.message)
  }
  score(params: unknown, bars: KlineBar[], volumeScale: number, timeout=2500): Promise<number> {
    const reqId=++this.seq
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(reqId);reject(new Error('秒级计算超时，已停止续期'))},timeout)
      this.pending.set(reqId,{resolve,reject,timer})
      this.worker.postMessage({type:'realtime_factor',reqId,payload:{params,volume_scale:volumeScale},bars})
    })
  }
  close(reason='计算线程已关闭') {
    for (const p of this.pending.values()) {clearTimeout(p.timer);p.reject(new Error(reason))}
    this.pending.clear();this.worker.terminate()
  }
}
