"use client"

/**
 * 再进化一轮 —— 携带当前 champions 作为 seed
 */

interface EvolveBarProps {
  disabled: boolean
  loading: boolean
  coachNote: string | null
  appliedSource: string | null
  onEvolve: () => void
}

/** 再进化操作条 */
export function EvolveBar(props: EvolveBarProps): React.JSX.Element {
  const { disabled, loading, coachNote, appliedSource, onEvolve } = props
  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={onEvolve}
        className="text-[11px] px-2.5 py-1 rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/20 disabled:opacity-50"
      >
        {loading ? "进化中…" : "再进化一轮"}
      </button>
      {appliedSource && (
        <span className="text-[10px] text-[var(--text-muted)]">
          来源 {appliedSource}
        </span>
      )}
      {coachNote && (
        <span className="text-[10px] text-[var(--text-secondary)] truncate max-w-full">
          教练：{coachNote}
        </span>
      )}
    </div>
  )
}
