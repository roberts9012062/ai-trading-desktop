"use client"

/**
 * AI 任务可选挂载因子 —— 启用后从收藏选因子，注入 factor_signal
 * 不启用：纯 AI，strategy_params 不含 factor_tokens，prompt 零因子内容
 */

import { useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
import { desktopTokensToServerV3, serverFactorBlockReason } from "@/lib/factor-access"
import {
  listFactorFavorites,
  type FactorFavoriteItem,
} from "@/lib/factor-lab-api"

interface AiFactorMountProps {
  /** 当前挂载的因子 tokens；null=未启用 */
  value: number[] | null
  onChange: (tokens: number[] | null) => void
  symbol: string
}

/** AI 任务因子挂载（开关 + 收藏下拉） */
export function AiFactorMount({
  value,
  onChange,
  symbol,
}: AiFactorMountProps): React.JSX.Element {
  const enabled = Array.isArray(value)
  const [favs, setFavs] = useState<FactorFavoriteItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const items = await listFactorFavorites(symbol || undefined)
        if (!cancelled) setFavs(items)
      } catch {
        if (!cancelled) setFavs([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [symbol])

  // 收藏里是桌面编码；value 持有的是服务器 v3 编码 —— 匹配前统一转换
  const selected = favs.find(
    (f) =>
      JSON.stringify(desktopTokensToServerV3(f.tokens ?? [])) ===
      JSON.stringify(value || []),
  )

  return (
    <div className="space-y-1.5 rounded-md border border-[var(--border)] p-2.5">
      <label className="flex items-center gap-2 text-xs cursor-pointer text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? [] : null)}
        />
        挂载因子信号（可选）
      </label>
      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        启用后选择收藏因子，AI 决策时作为量化参考注入；不启用则纯 AI，零因子内容。
      </p>
      {enabled && (
        <div className="space-y-1">
          <Label className="text-[11px]">从收藏选择因子</Label>
          {loading ? (
            <div className="text-[10px] text-[var(--text-muted)]">加载收藏…</div>
          ) : favs.length === 0 ? (
            <div className="text-[10px] text-[var(--text-muted)]">
              暂无收藏，请先到因子实验室收藏因子配方
            </div>
          ) : (
            <select
              value={selected?.id ?? ""}
              onChange={(e) => {
                const it = favs.find((f) => f.id === e.target.value)
                if (it && serverFactorBlockReason(it.tokens, it.metrics)) return
                onChange(it ? desktopTokensToServerV3(it.tokens) : [])
              }}
              className="w-full h-8 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] text-xs px-2"
            >
              <option value="">请选择…</option>
              {favs.map((f) => (
                <option key={f.id} value={f.id} disabled={!!serverFactorBlockReason(f.tokens, f.metrics)}>
                  {f.name}
                  {serverFactorBlockReason(f.tokens, f.metrics) ? "（不支持此处挂载）" : ""}
                  {f.symbol ? ` · ${f.symbol}` : ""}
                  {f.composite != null ? ` · ${f.composite.toFixed(2)}` : ""}
                </option>
              ))}
            </select>
          )}
          {selected && (
            <div className="text-[10px] text-[var(--text-muted)] font-num break-all">
              {selected.text}
            </div>
          )}
          {selected && serverFactorBlockReason(selected.tokens, selected.metrics) && (
            <p role="alert" className="text-[11px] text-amber-500">{serverFactorBlockReason(selected.tokens, selected.metrics)}，请重新选择或取消挂载。</p>
          )}
        </div>
      )}
    </div>
  )
}
