import { create } from 'zustand'
import type { Analysis, Cadence } from '@/lib/realtime-factor/model'
import { appendAnalysis } from '@/lib/realtime-factor/model'

export interface RealtimeView {
  state: 'preparing'|'active'|'stopping'|'fallback'
  interval: Cadence
  message: string
  rows: Analysis[]
}
export const useRealtimeFactorStore=create<{
  tasks:Record<string,RealtimeView>
  update:(id:string,view:Partial<RealtimeView>)=>void
  record:(id:string,row:Analysis)=>void
  amend:(id:string,rowId:string,patch:Partial<Analysis>)=>void
  reset:()=>void
}>((set)=>({
  tasks:{},
  update:(id,view)=>set(s=>({tasks:{...s.tasks,[id]:{...(s.tasks[id]??{state:'preparing',interval:3,message:'',rows:[]}),...view}}})),
  record:(id,row)=>set(s=>s.tasks[id]?{tasks:{...s.tasks,[id]:{...s.tasks[id],rows:appendAnalysis(s.tasks[id].rows,row)}}}:s),
  amend:(id,rowId,patch)=>set(s=>s.tasks[id]?{tasks:{...s.tasks,[id]:{...s.tasks[id],rows:s.tasks[id].rows.map(r=>r.id===rowId?{...r,...patch}:r)}}}:s),
  reset:()=>set({tasks:{}}),
}))
