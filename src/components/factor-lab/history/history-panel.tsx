"use client"

/**
 * 因子历史面板 —— 当前合约最近 Champion（≤10）
 */

import type { FactorHistoryItem } from "@/lib/factor-lab-api"

/** 历史来源标签(与服务端 FactorHistory.source 枚举对应;未知值原样展示) */
const SOURCE_LABELS: Record<string, string> = {
  gp: "GP",
  evolve: "进化",
  llm_gen: "LLM",
  mining: "挖掘",
  manual: "手动",
  local: "本地",
}

interface HistoryPanelProps {
  symbol: string
  items: FactorHistoryItem[]
  loading: boolean
  favoritedKeys?: Set<string>
  onSelect: (item: FactorHistoryItem) => void
  onDelete: (id: string) => void
  onFavorite: (item: FactorHistoryItem) => void
  onRefresh: () => void
}

/** 历史列表 */
export function HistoryPanel(props: HistoryPanelProps): React.JSX.Element {
  const {
    symbol,
    items,
    loading,
    favoritedKeys,
    onSelect,
    onDelete,
    onFavorite,
    onRefresh,
  } = props
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-[var(--text-secondary)]">
          历史 · {symbol || "—"}
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          刷新
        </button>
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">
        每合约最多保留 10 条；搜索成功自动写入 Champion。
      </p>
      {loading ? (
        <div className="text-[11px] text-[var(--text-muted)] py-2">加载中…</div>
      ) : items.length === 0 ? (
        <div className="text-[11px] text-[var(--text-muted)] py-2">
          暂无历史，先跑一次搜索。
        </div>
      ) : (
        <ul className="space-y-1.5 max-h-56 overflow-y-auto">
          {items.map((it) => {
            const favorited = Boolean(
              it.tokens?.length && favoritedKeys?.has(it.tokens.join(",")),
            )
            return (
              <li
                key={it.id}
                className="rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)]/40 px-2 py-1.5 text-[11px]"
              >
                <button
                  type="button"
                  className="w-full text-left font-num text-[var(--text-primary)] break-all hover:text-[var(--primary)]"
                  onClick={() => onSelect(it)}
                >
                  {it.text}
                </button>
                <div className="flex flex-wrap items-center gap-2 mt-1 text-[var(--text-muted)]">
                  <span>
                    综合{" "}
                    <span className="font-num text-[var(--text-secondary)]">
                      {it.composite.toFixed(2)}
                    </span>
                  </span>
                  <span>{it.timeframe}</span>
                  <span>{SOURCE_LABELS[it.source] ?? it.source}</span>
                  <button
                    type="button"
                    disabled={favorited}
                    className={
                      favorited
                        ? "text-[var(--text-muted)] opacity-60 cursor-not-allowed"
                        : "text-[var(--primary)] hover:underline"
                    }
                    onClick={() => {
                      if (favorited) return
                      onFavorite(it)
                    }}
                  >
                    {favorited ? "已收藏" : "收藏"}
                  </button>
                  <button
                    type="button"
                    className="text-red-400/80 hover:underline"
                    onClick={() => onDelete(it.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
