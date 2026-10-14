"use client"
import { MINING_FEATURES, ALL_MINING_FEATURE_IDS, ALL_SHORTLINE_FEATURE_IDS } from "@/lib/mining/feature-selection"

export function MiningFeatureSettings({selected, onChange, shortline = false, disabled = false}: {
  selected: number[]; onChange: (ids: number[]) => void; shortline?: boolean; disabled?: boolean
}) {
  const ids = shortline ? ALL_SHORTLINE_FEATURE_IDS : ALL_MINING_FEATURE_IDS
  const features = MINING_FEATURES.filter(f => ids.includes(f.id))
  const categories = [...new Set(features.map(f => f.category))]
  function toggle(id: number) {onChange(selected.includes(id) ? selected.filter(i => i !== id) : [...selected, id].sort((a,b) => a-b))}
  return <details className="rounded-lg border border-[var(--border)] p-3 text-xs col-span-full">
    <summary className="cursor-pointer font-medium">高级设置 · 参与挖掘与组合的因子（{selected.length}/{ids.length}）</summary>
    <fieldset disabled={disabled} className="mt-3 space-y-3 disabled:opacity-60">
      <p className="text-[var(--text-muted)]">默认全选。取消后，该特征不会参与新公式、种子或组合成员；已有任务保留原设置。鼠标悬停或键盘聚焦可查看作用。缺少真实数据的特征由引擎排除。</p>
      <div className="flex gap-3"><button type="button" onClick={() => onChange([...ids])}>全选</button><button type="button" onClick={() => onChange([])}>清空</button><button type="button" onClick={() => onChange(ids.filter(i => !selected.includes(i)))}>反选</button></div>
      {!selected.length && <p role="alert" className="text-red-400">至少选择一个因子才能开始挖掘。</p>}
      {categories.map(category => {
        const group = features.filter(f => f.category === category)
        const checked = group.every(f => selected.includes(f.id))
        return <section key={category} className="space-y-2">
          <label className="flex gap-2 font-medium"><input type="checkbox" checked={checked} onChange={() => onChange(checked ? selected.filter(i => !group.some(f => f.id === i)) : [...new Set([...selected, ...group.map(f => f.id)])].sort((a,b) => a-b))}/>{category}</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{group.map(f => <label key={f.id} className="relative group flex gap-2 items-center rounded border border-[var(--border)] px-2 py-1.5" title={f.description}>
            <input type="checkbox" aria-label={f.name} checked={selected.includes(f.id)} onChange={() => toggle(f.id)} aria-describedby={`feature-${shortline ? 'sl' : 'base'}-${f.id}`}/>
            <span className="truncate">{f.name}</span>
            <span role="tooltip" id={`feature-${shortline ? 'sl' : 'base'}-${f.id}`} className="pointer-events-none absolute left-0 bottom-full z-20 hidden w-56 rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-2 text-[var(--text-primary)] shadow-lg group-hover:block group-focus-within:block">{f.description}</span>
          </label>)}</div>
        </section>
      })}
    </fieldset>
  </details>
}
