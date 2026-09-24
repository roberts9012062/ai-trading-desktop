"use client"

/**
 * 行情筛选工作台 —— 周期选择 + 条件组合（AND）+ 点击筛选 + 结果列表
 *
 * 与信号播报不同：不自动轮询，仅在用户点击「开始筛选」时扫描一次；
 * 条件参数持久化在 localStorage，刷新后恢复。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Filter, Play, RotateCcw, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAppStore } from "@/stores/app"
import { useAuthStore } from "@/stores/auth"
import { ConditionCard } from "./condition-card"
import {
  COND_TYPE_META,
  SCREENER_PERIODS,
  applyChartDefaults,
  makeCondition,
  normalizeCondition,
  runScreenerApi,
  type ChartIndicatorConfig,
  type ScreenerCondType,
  type ScreenerCondition,
  type ScreenerPeriod,
  type ScreenerResponse,
} from "@/lib/screener-api"
import { getIndicatorSettingsApi } from "@/lib/api"

const CONFIG_KEY = "qihuo-market-screener-config"

interface PersistedConfig {
  period: ScreenerPeriod
  conditions: ScreenerCondition[]
}

function loadPersistedConfig(): PersistedConfig | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedConfig
    const validPeriod = SCREENER_PERIODS.some((p) => p.value === parsed.period)
    if (!validPeriod || !Array.isArray(parsed.conditions)) return null
    // 归一化补齐新增字段，兼容旧版本保存的配置
    return { period: parsed.period, conditions: parsed.conditions.map(normalizeCondition) }
  } catch {
    return null
  }
}

const DIRECTION_META: Record<string, { label: string; cls: string }> = {
  long: { label: "多", cls: "bg-emerald-500/15 text-emerald-400" },
  short: { label: "空", cls: "bg-red-500/15 text-red-400" },
  mixed: { label: "多空混合", cls: "bg-amber-500/15 text-amber-400" },
  neutral: { label: "中性", cls: "bg-zinc-500/15 text-zinc-400" },
}

/** 行情筛选主工作区 */
export function ScreenerWorkspace(): React.JSX.Element {
  const router = useRouter()
  const setActiveContract = useAppStore((s) => s.setActiveContract)
  const tradingMode = useAuthStore((s) => s.user?.trading_mode ?? "live")
  const isVirtual = tradingMode === "virtual"

  const [period, setPeriod] = useState<ScreenerPeriod>("1d")
  const [conditions, setConditions] = useState<ScreenerCondition[]>(() => [
    makeCondition("pivot"),
  ])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ScreenerResponse | null>(null)
  const runSeqRef = useRef(0)
  /** 用户图表指标设置：新建条件的默认参数来源，保证筛选与图上一致 */
  const chartCfgRef = useRef<ChartIndicatorConfig | null>(null)

  // 恢复上次筛选配置
  useEffect(() => {
    const saved = loadPersistedConfig()
    if (saved && saved.conditions.length > 0) {
      setPeriod(saved.period)
      setConditions(saved.conditions)
    }
  }, [])

  // 拉取图表指标设置（未登录/失败静默，用内置默认值）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cfg = await getIndicatorSettingsApi()
        if (!cancelled) chartCfgRef.current = cfg
      } catch {
        // 静默：保持内置默认参数
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 配置变化即持久化
  useEffect(() => {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ period, conditions }))
    } catch {
      // 存储满等异常静默
    }
  }, [period, conditions])

  const addCondition = useCallback((type: ScreenerCondType) => {
    setConditions((prev) => [
      ...prev,
      applyChartDefaults(makeCondition(type), chartCfgRef.current),
    ])
  }, [])

  const updateCondition = useCallback(
    (id: string, patch: Partial<ScreenerCondition>) => {
      setConditions((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      )
    },
    [],
  )

  const removeCondition = useCallback((id: string) => {
    setConditions((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const resetConditions = useCallback(() => {
    setConditions([makeCondition("pivot")])
    setResult(null)
    setError(null)
  }, [])

  const run = useCallback(async () => {
    if (conditions.length === 0 || running) return
    const seq = ++runSeqRef.current
    setRunning(true)
    setError(null)
    try {
      const res = await runScreenerApi(period, conditions)
      if (runSeqRef.current !== seq) return
      setResult(res)
    } catch (err) {
      if (runSeqRef.current !== seq) return
      setResult(null)
      setError(err instanceof Error ? err.message : "筛选失败")
    } finally {
      if (runSeqRef.current === seq) setRunning(false)
    }
  }, [conditions, period, running])

  const periodLabel = useMemo(
    () => SCREENER_PERIODS.find((p) => p.value === period)?.label ?? period,
    [period],
  )

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      {/* 页头 */}
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <Filter className="w-5 h-5 text-sky-400" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            行情筛选
          </h1>
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded",
              isVirtual
                ? "bg-sky-500/15 text-sky-400"
                : "bg-emerald-500/15 text-emerald-400",
            )}
          >
            {isVirtual ? "虚拟盘 7×24" : "实盘"}
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          全市场主力 · 波段多空 / MACD / 均线 / KDJ / RSI / 布林带 ·
          参数可调 · 多条件组合（全部满足） · 点击开始筛选
        </p>
      </div>

      {/* 周期 + 操作 */}
      <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
        <Tabs value={period} onValueChange={(v) => setPeriod(v as ScreenerPeriod)}>
          <TabsList className="h-9 bg-[var(--bg-tertiary)]">
            {SCREENER_PERIODS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="text-xs px-3 h-8">
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={resetConditions}
            disabled={running}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            重置
          </button>
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || conditions.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--primary)] text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            {running ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            {running ? "筛选中…" : "开始筛选"}
          </button>
        </div>
      </div>

      {/* 条件组合区 */}
      <Card className="mb-4">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">
            筛选条件
            <span className="ml-2 text-[11px] font-normal text-[var(--text-muted)]">
              {conditions.length > 0
                ? `${conditions.length} 个条件 · 全部满足才命中`
                : "请至少添加一个条件"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {conditions.map((cond) => (
            <ConditionCard
              key={cond.id}
              cond={cond}
              onChange={(patch) => updateCondition(cond.id, patch)}
              onRemove={() => removeCondition(cond.id)}
            />
          ))}

          {/* 添加条件 */}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className="text-[11px] text-[var(--text-muted)]">添加：</span>
            {(Object.keys(COND_TYPE_META) as ScreenerCondType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => addCondition(type)}
                disabled={running}
                className="px-2.5 py-1 rounded-md text-xs border border-dashed border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-50 cursor-pointer"
              >
                + {COND_TYPE_META[type].name}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 结果区 */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">
            筛选结果
            {result && (
              <span className="ml-2 text-[11px] font-normal text-[var(--text-muted)]">
                {result.message ||
                  `${periodLabel} · 扫描 ${result.scanned} · 命中 ${result.total}`}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="py-6 text-center text-xs text-[var(--accent-danger)]">
              {error}
              <button
                type="button"
                className="ml-2 text-[var(--accent-info)] hover:underline cursor-pointer"
                onClick={() => void run()}
              >
                重试
              </button>
            </div>
          ) : running ? (
            <div className="py-8 text-center text-xs text-[var(--text-muted)]">
              <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
              正在扫描全市场主力 {periodLabel} K线…
            </div>
          ) : !result ? (
            <div className="py-8 text-center text-xs text-[var(--text-muted)]">
              设置条件后点击「开始筛选」，扫描全市场主力合约
            </div>
          ) : result.items.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--text-muted)]">
              {result.message || `无品种满足当前 ${conditions.length} 个条件`}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--text-muted)] border-b border-[var(--border)]">
                    <th className="py-2 pr-3 font-normal">品种</th>
                    <th className="py-2 pr-3 font-normal">合约</th>
                    <th className="py-2 pr-3 font-normal text-right">最新价</th>
                    <th className="py-2 pr-3 font-normal text-center">方向</th>
                    <th className="py-2 pr-3 font-normal">命中条件</th>
                    <th className="py-2 font-normal">信号K线</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((item) => {
                    const dir =
                      DIRECTION_META[item.direction] ?? DIRECTION_META.neutral
                    return (
                      <tr
                        key={item.symbol}
                        title={`查看 ${item.name}（${item.symbol}）K线图`}
                        onClick={() => {
                          setActiveContract(item.symbol)
                          router.push(
                            `/market?symbol=${encodeURIComponent(item.symbol)}`,
                          )
                        }}
                        className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-tertiary)] cursor-pointer transition-colors"
                      >
                        <td className="py-2 pr-3 font-semibold text-[var(--text-primary)] whitespace-nowrap">
                          {item.product_name || item.name || item.symbol}
                        </td>
                        <td className="py-2 pr-3 font-num text-[var(--text-muted)] whitespace-nowrap">
                          {item.symbol}
                        </td>
                        <td className="py-2 pr-3 text-right font-num text-[var(--text-secondary)]">
                          {item.last_price ?? "-"}
                        </td>
                        <td className="py-2 pr-3 text-center">
                          <span
                            className={cn(
                              "inline-block text-[10px] px-1.5 py-0.5 rounded",
                              dir.cls,
                            )}
                          >
                            {dir.label}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex flex-wrap gap-1">
                            {item.conditions.map((c, i) => (
                              <span
                                key={`${item.symbol}-${c.type}-${i}`}
                                title={c.detail}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                              >
                                {c.label}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-2 font-num text-[var(--text-muted)] whitespace-nowrap">
                          {item.as_of || "-"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
