"use client"

/**
 * 组合因子相似度面板 —— 勾选 2-5 个因子后自动分析（两页共享：因子实验室 / 超级因子挖掘）
 *
 * 相似度衡量的是「行为重合」而非谁更厉害：
 * - 指标相关：tanh 仓位意图序列走势是否一致（技术口径相似）
 * - 盈亏波段重合：赚钱的时段是否叠在一起
 * 低相关 = 一个回撤时其它未必同向亏，资金曲线更平滑；
 * 高相关 = 同涨同跌，等于把同一因子放大 N 倍，没有分散意义。
 *
 * 桌面端适配（web fad6967 之外）：
 * - token 为桌面谱系编码，提交前经 desktopTokensToServerV3 转 v3（幂等）
 * - 组合含服务器无数据源的直连特征（逐笔/强平类）或 gate_usdt 渠道因子时，
 *   服务端 similarity 无法计算 → 本地预检直接给说明，不发起注定 400 的请求
 */

import { useEffect, useMemo, useState } from "react"
import {
  analyzeFactorSimilarity,
  type Champion,
  type FactorSimilarityResult,
} from "@/lib/factor-lab-api"
import {
  desktopTokensToServerV3,
  isResearchOnlyFactor,
  requiresLocalFactorEngine,
} from "@/lib/factor-access"
import { cn } from "@/lib/utils"

interface ComboSimilarityPanelProps {
  /** 已勾选的组合成员（≥2 才分析） */
  champions: Champion[]
  symbol: string
  timeframe: string
}

const LEVEL_STYLE: Record<string, { label: string; cls: string }> = {
  high: { label: "高度相似", cls: "bg-red-500/15 text-red-300" },
  mid: { label: "中等相关", cls: "bg-amber-500/15 text-amber-300" },
  low: { label: "低相关", cls: "bg-emerald-500/15 text-emerald-300" },
}

export function ComboSimilarityPanel({
  champions,
  symbol,
  timeframe,
}: ComboSimilarityPanelProps): React.JSX.Element {
  const key = useMemo(
    () => champions.map((c) => c.tokens.join(",")).join("|"),
    [champions],
  )
  const [result, setResult] = useState<FactorSimilarityResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 服务端无法计算的成员（无数据源直连特征 / gate_usdt 渠道）：本地预检降级
  const blocked = champions.some(
    (c) =>
      isResearchOnlyFactor(c.tokens, c.metrics) ||
      requiresLocalFactorEngine(c.tokens, c.metrics),
  )

  useEffect(() => {
    if (champions.length < 2 || !symbol || !timeframe || blocked) {
      setResult(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    analyzeFactorSimilarity({
      symbol,
      timeframe,
      token_groups: champions.map((c) => desktopTokensToServerV3(c.tokens)),
    })
      .then((r) => {
        if (!cancelled) setResult(r)
      })
      .catch((e) => {
        if (!cancelled) {
          setResult(null)
          setError(e instanceof Error ? e.message : "相似度分析失败")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // key 变化（勾选集合变化）才重新分析
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, symbol, timeframe, blocked])

  if (champions.length < 2) {
    return (
      <p className="text-[10px] text-[var(--text-muted)]">
        勾选 2-5 个因子后自动分析组合相关性（相似度与谁更厉害无关，只看行为是否重合）。
      </p>
    )
  }
  if (blocked) {
    return (
      <p className="text-[10px] text-amber-400/90">
        组合含服务器无数据源的直连特征（逐笔/强平类）或 gate_usdt 渠道因子，
        服务端无法计算相似度；该组合挂载后将自动切换本地引擎执行（需应用保持运行）。
      </p>
    )
  }
  if (loading) {
    return (
      <p className="text-[10px] text-[var(--text-muted)]">相似度分析中…</p>
    )
  }
  if (error) {
    return <p className="text-[10px] text-amber-400/90">{error}</p>
  }
  if (!result) return <></>

  return (
    <div className="space-y-1.5">
      {/* 单因子相似度评分：分接近且偏高的两个因子互为相似因子 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {result.factors.map((f) => {
          const c = champions[f.index]
          const score = f.score
          return (
            <span
              key={f.index}
              title={c?.text || ""}
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded font-num",
                score >= 5
                  ? "bg-amber-500/15 text-amber-300"
                  : score >= 2.5
                    ? "bg-white/5 text-[var(--text-secondary)]"
                    : "bg-emerald-500/15 text-emerald-300",
              )}
            >
              因子{f.index + 1} {score.toFixed(1)}分
              <span className="ml-1 font-normal text-[var(--text-muted)]">
                综合{(c?.composite ?? 0).toFixed(2)}
              </span>
            </span>
          )
        })}
        <span className="text-[9px] text-[var(--text-muted)]">
          （0=与其它因子都不相关；分数接近且偏高的一对互为相似因子）
        </span>
      </div>

      {/* 两两相似度明细 */}
      <div className="flex flex-col gap-1">
        {result.pairs.map((p) => {
          const lv = LEVEL_STYLE[p.level] ?? LEVEL_STYLE.low
          return (
            <div
              key={`${p.i}-${p.j}`}
              className="flex items-center gap-2 text-[10px] font-num"
            >
              <span className={cn("px-1.5 py-0.5 rounded font-medium", lv.cls)}>
                {lv.label} {p.similarity.toFixed(1)}
              </span>
              <span className="text-[var(--text-secondary)]">
                因子{p.i + 1} × 因子{p.j + 1}
              </span>
              <span className="text-[var(--text-muted)]">
                指标相关 {p.value_corr.toFixed(2)} · 赚钱波段重合{" "}
                {p.win_overlap_pct.toFixed(0)}%
              </span>
            </div>
          )
        })}
      </div>

      <p
        className={cn(
          "text-[11px]",
          result.pairs.some((p) => p.level === "high")
            ? "text-amber-400/90"
            : "text-emerald-400/90",
        )}
      >
        {result.verdict}
      </p>
      <p className="text-[9px] text-[var(--text-muted)]">
        基于 {result.bars} 根 {result.timeframe} K 线 ·
        低相关因子回撤互相对冲、曲线更平滑；高相关≈同一因子加倍，无分散意义
      </p>
    </div>
  )
}
