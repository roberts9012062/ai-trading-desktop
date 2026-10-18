import {paperFactorCatalog} from '@/lib/mining/paper-factors'
import {MINING_FEATURES} from '@/lib/mining/feature-selection'

export function PaperResearchSettings({selected,enabled,onChange,disabled=false}:{
 selected:number[];enabled:boolean;onChange:(enabled:boolean)=>void;disabled?:boolean
}) {
 const names=new Set(MINING_FEATURES.filter(f=>f.id<64&&selected.includes(f.id)).map(f=>String(f.name)))
 const rows=paperFactorCatalog.factors
 const compatible=rows.filter(row=>row.features.every(name=>names.has(name))).length
 return <fieldset disabled={disabled} className="rounded-lg border border-[var(--border)] p-3 space-y-2 text-xs disabled:opacity-60">
   <label className="flex items-center gap-2 font-medium"><input type="checkbox" aria-label="启用论文研究配方" checked={enabled} onChange={e=>onChange(e.target.checked)}/>论文研究配方 · {rows.length} 类 / {rows.length*2} 个方向公式</label>
   <p className="text-[var(--text-muted)]">这些配方由基础特征组合而成，单独列示。按已选基础特征可构造 {compatible} 类，真实数据覆盖由引擎检查。此开关也保留原有 3 类经济假设种子；配方均须经过样本外验收。</p>
   <details><summary className="cursor-pointer">查看 {rows.length} 类论文配方{!enabled?'（当前关闭）':''}</summary>
     <ul className="mt-2 space-y-2">{rows.map(row=>{
       const missing=row.features.filter(name=>!names.has(name))
       return <li key={row.id}><span className="font-medium">{row.name}</span><span className="text-[var(--text-muted)]"> · 2 个方向</span>
         <p className="text-[var(--text-muted)] break-words">依赖：{row.features.join('、')}{missing.length>0?`；未选中：${missing.join('、')}`:''}</p>
       </li>
     })}</ul>
   </details>
 </fieldset>
}
