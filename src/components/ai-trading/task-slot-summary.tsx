import { slotSummary, type TaskSlots } from "@/lib/task-slots"

export function TaskSlotSummary({ slots }: { slots?: TaskSlots | null }): React.JSX.Element | null {
  if (!slots) return null
  return <div className="text-xs text-[var(--text-secondary)] space-y-1" aria-label="任务槽额度">
    <p>{slotSummary(slots)}</p>
    {slots.close_only > 0 && <p className="text-amber-400">另有 {slots.close_only} 个失效槽仅允许减仓和平仓，确认空仓后自动回收。</p>}
  </div>
}
