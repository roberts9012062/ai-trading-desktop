"use client"

/** 量化任务：因子公式参数（收藏下拉 + 手动 tokens） */

import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { QuantParamsState } from "@/lib/quant-strategy"
import {
  listFactorFavorites,
  type FactorFavoriteItem,
} from "@/lib/factor-lab-api"

interface FactorKindParamsProps {
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  symbol: string
  /** 选中收藏时回填该因子的品种/周期到外层表单 */
  onApplyMeta?: (symbol: string | null, timeframe: string | null) => void
}

/** 因子策略参数区 */
export function FactorKindParams({
  quant,
  onQuant,
  symbol,
  onApplyMeta,
}: FactorKindParamsProps): React.JSX.Element {
  const [favorites, setFavorites] = useState<FactorFavoriteItem[]>([])
  const [loading, setLoading] = useState(false)
  const [favId, setFavId] = useState("")

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const items = await listFactorFavorites(symbol || undefined)
        if (!cancelled) setFavorites(items)
      } catch {
        if (!cancelled) setFavorites([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [symbol])

  function pickFavorite(id: string): void {
    setFavId(id)
    const item = favorites.find((f) => f.id === id)
    if (!item) return
    onQuant({ ...quant, factorTokensText: item.tokens.join(",") })
    // 回填收藏因子的品种与周期到外层任务表单
    if (onApplyMeta) onApplyMeta(item.symbol, item.timeframe)
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-[11px]">从收藏选择</Label>
        {loading ? (
          <div className="text-[10px] text-[var(--text-muted)]">加载收藏…</div>
        ) : favorites.length === 0 ? (
          <div className="text-[10px] text-[var(--text-muted)]">
            暂无收藏，请先到因子实验室收藏配方，或下方手动粘贴 tokens。
          </div>
        ) : (
          <select
            value={favId}
            onChange={(e) => pickFavorite(e.target.value)}
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] text-xs px-2"
          >
            <option value="">请选择收藏的因子…</option>
            {favorites.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.symbol ? ` · ${f.symbol}` : ""}
                {f.composite != null ? ` · ${f.composite.toFixed(2)}` : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="space-y-1">
        <Label className="text-[11px]">因子公式 tokens（逗号分隔）</Label>
        <Input
          value={quant.factorTokensText}
          onChange={(e) => {
            setFavId("")
            onQuant({ ...quant, factorTokensText: e.target.value })
          }}
          placeholder="如 0,8,1,14（从因子实验室复制）"
          className="font-num"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-[11px]">开仓线（0.05-0.5，默认 0.3）</Label>
        <Input
          type="number"
          min={0.05}
          max={0.5}
          step={0.05}
          value={quant.factorEntry}
          onChange={(e) => onQuant({ ...quant, factorEntry: e.target.value })}
          placeholder="0.3"
          className="font-num"
        />
        <p className="text-[10px] text-[var(--text-muted)]">
          因子仓位意图 |值| 越过该线才给开仓建议；调低（如 0.2）信号更频繁。留空=默认 0.3。
        </p>
      </div>
    </div>
  )
}
