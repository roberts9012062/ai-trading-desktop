"use client"
import {EMPTY_FAVORITE_FILTERS, type FavoriteFilters} from "@/lib/favorite-filters"
export function FavoriteFilterBar({value, onChange}: {value: FavoriteFilters; onChange: (value: FavoriteFilters) => void}) {
  const cls = "h-8 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-xs"
  const invalid = value.minAnnual.trim() && value.maxAnnual.trim() && Number(value.minAnnual) > Number(value.maxAnnual)
  return <div className="flex flex-wrap items-center gap-2 my-3 text-xs">
    <label className="flex gap-1 items-center">时间周期<select className={cls} value={value.timeframe} onChange={e => onChange({...value, timeframe: e.target.value})}>
      <option value="">全部周期</option>{["1m", "5m", "15m", "30m", "60m", "240m", "1d"].map(tf => <option key={tf} value={tf}>{tf}</option>)}
    </select></label>
    <label className="flex gap-1 items-center">年化 ≥<input aria-label="最低年化百分比" type="number" step="any" className={`${cls} w-24`} value={value.minAnnual} onChange={e => onChange({...value, minAnnual: e.target.value})} placeholder="不限"/>%</label>
    <label className="flex gap-1 items-center">年化 ≤<input aria-label="最高年化百分比" type="number" step="any" className={`${cls} w-24`} value={value.maxAnnual} onChange={e => onChange({...value, maxAnnual: e.target.value})} placeholder="不限"/>%</label>
    <button type="button" className={cls} onClick={() => onChange({...EMPTY_FAVORITE_FILTERS})}>重置筛选</button>
    <p className="basis-full text-[var(--text-muted)]">使用已保存的年化数据；设置年化范围后不包含缺少年化数据的收藏。{invalid ? "最低年化不能大于最高年化。" : ""}</p>
  </div>
}
