"use client"

/** 量化任务:短线因子参数(短线收藏下拉 + 手动 tokens)
 *
 * 与因子策略的 FactorKindParams 严格分流——短线因子是桌面编码
 * (62 行特征表),与服务端因子收藏的 v3 编码在 52 号后同号不同义,
 * 混用必然"数据不足或因子无效"。
 */

import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { QuantParamsState } from "@/lib/quant-strategy"
import {
  listShortlineFavorites,
  type ShortlineFavoriteItem,
} from "@/lib/shortline/server-api"

interface ShortlineKindParamsProps {
  quant: QuantParamsState
  onQuant: (q: QuantParamsState) => void
  symbol: string
  onApplyMeta?: (symbol: string | null, timeframe: string | null) => void
}

/** 短线因子策略参数区(收藏源=短线因子库) */
export function ShortlineKindParams({
  quant,
  onQuant,
  symbol,
  onApplyMeta,
}: ShortlineKindParamsProps): React.JSX.Element {
  const [favorites, setFavorites] = useState<ShortlineFavoriteItem[]>([])
  const [loading, setLoading] = useState(false)
  const [favId, setFavId] = useState("")

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const items = await listShortlineFavorites(symbol || undefined)
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
    if (onApplyMeta) onApplyMeta(item.symbol, item.timeframe)
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-[11px]">从短线因子收藏选择</Label>
        {loading ? (
          <div className="text-[10px] text-[var(--text-muted)]">加载短线收藏…</div>
        ) : favorites.length === 0 ? (
          <div className="text-[10px] text-[var(--text-muted)]">
            暂无短线因子收藏——请先在桌面端短线因子实验室收藏冠军，或下方手动粘贴 tokens。
          </div>
        ) : (
          <select
            value={favId}
            onChange={(e) => pickFavorite(e.target.value)}
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] text-xs px-2"
          >
            <option value="">请选择收藏的短线因子…</option>
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
        <Label className="text-[11px]">短线因子 tokens（逗号分隔，桌面编码）</Label>
        <Input
          value={quant.factorTokensText}
          onChange={(e) => {
            setFavId("")
            onQuant({ ...quant, factorTokensText: e.target.value })
          }}
          placeholder="如 0,87,76（从桌面短线实验室复制）"
          className="font-num"
        />
      </div>
    </div>
  )
}
