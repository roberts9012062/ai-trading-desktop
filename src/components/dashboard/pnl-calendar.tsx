"use client"

/**
 * 实盘盈亏日历（数据经业务服务器同步，复用「实盘交易所接入」凭证）
 *
 * 结构自上而下：月度汇总条（盈亏比 / 总盈利 / 总亏损 / 净盈亏）→
 * 日历九宫格（每格当日盈亏，红盈绿亏 CN 口径，底色深浅=当日盈亏强度）→
 * 当月累计盈亏曲线（lightweight-charts）。
 *
 * 数据源：/api/live/bills（跟随当前实盘交易场所），按自然日在本地聚合
 * 「已实现盈亏 + 手续费」；聚合缓存仅存本机 localStorage。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineType,
  createChart,
  type Time,
} from "lightweight-charts"
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  getCredentialsApi,
  getStoredVenue,
  venueName,
  type VenueCredential,
} from "@/lib/live-api"
import {
  BILLS_LIMIT,
  CACHE_FRESH_MS,
  loadDailyPnlCache,
  refreshDailyPnl,
  type DailyPnlCache,
} from "@/lib/pnl-calendar"

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]

function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "--"
  return Math.abs(v) >= 100000
    ? v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
    : v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 日历格子用的紧凑金额：+1.2万 / -345.6 / +0.0012 */
function fmtCompact(v: number): string {
  const sign = v > 0 ? "+" : ""
  const a = Math.abs(v)
  if (a >= 100000000) return `${sign}${(a / 100000000).toFixed(2)}亿`
  if (a >= 10000) return `${sign}${(a / 10000).toFixed(1)}万`
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(1)}k`
  if (a > 0 && a < 0.01) return `${sign}${a.toFixed(4)}`
  return `${sign}${a.toFixed(2)}`
}

function pnlColor(v: number): string {
  return v > 0 ? "text-up" : v < 0 ? "text-down" : "text-[var(--text-secondary)]"
}

const pad = (n: number) => String(n).padStart(2, "0")

/** 当月累计盈亏曲线：业务日字符串作 Time */
function CumulativeChart({ points }: { points: { time: string; value: number }[] }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || points.length === 0) return
    const chart = createChart(el, {
      height: 170,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(156,163,175,0.9)",
        fontSize: 11,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      },
      localization: { locale: "zh-CN" },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.03)", style: 1 },
        horzLines: { color: "rgba(255,255,255,0.05)", style: 1 },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.1 },
        entireTextOnly: true,
      },
      leftPriceScale: { visible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: false,
        secondsVisible: false,
        fixLeftEdge: true,
        rightOffset: 2,
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: "rgba(148,163,184,0.35)",
          width: 1,
          style: 2,
          labelBackgroundColor: "rgba(30,41,59,0.95)",
        },
        horzLine: {
          color: "rgba(148,163,184,0.25)",
          width: 1,
          style: 2,
          labelBackgroundColor: "rgba(30,41,59,0.95)",
        },
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: false },
      handleScale: { axisPressedMouseMove: false, mouseWheel: false, pinch: false },
    })
    const final = points[points.length - 1].value
    const color = final >= 0 ? "#ef4444" : "#22c55e"
    const series = chart.addSeries(LineSeries, {
      color,
      lineWidth: 2,
      lineType: LineType.Simple,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerBorderColor: "#1a1a1e",
      crosshairMarkerBackgroundColor: color,
    })
    series.setData(points.map((p) => ({ time: p.time as Time, value: p.value })))
    series.createPriceLine({
      price: 0,
      color: "rgba(148,163,184,0.45)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
    })
    chart.applyOptions({ width: el.clientWidth })
    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [points])

  return <div ref={containerRef} className="w-full" />
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function PnlCalendar(): React.JSX.Element {
  // 跟随当前实盘交易场所（资产/交易页切换后回到工作台即生效）
  const [venue] = useState(() => getStoredVenue())
  const [credential, setCredential] = useState<VenueCredential | null>(null)
  const [credLoaded, setCredLoaded] = useState(false)
  const [cache, setCache] = useState<DailyPnlCache | null>(() => loadDailyPnlCache(getStoredVenue()))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [monthOffset, setMonthOffset] = useState(0)
  const reqSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    getCredentialsApi()
      .then((cs) => {
        if (!cancelled) setCredential(cs.find((c) => c.venue === venue) ?? null)
      })
      .catch(() => {
        if (!cancelled) setCredential(null)
      })
      .finally(() => {
        if (!cancelled) setCredLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [venue])

  const doRefresh = useCallback(async () => {
    const seq = (reqSeq.current += 1)
    setLoading(true)
    setError("")
    try {
      const next = await refreshDailyPnl({ venue })
      if (reqSeq.current === seq) setCache(next)
    } catch (e) {
      if (reqSeq.current === seq) {
        setError(e instanceof Error ? e.message : "同步实盘账单失败")
      }
    } finally {
      if (reqSeq.current === seq) setLoading(false)
    }
  }, [venue])

  useEffect(() => {
    if (!credential) return
    const cached = loadDailyPnlCache(venue)
    setCache(cached)
    if (!cached || Date.now() - cached.fetchedAt > CACHE_FRESH_MS) void doRefresh()
  }, [credential, venue, doRefresh])

  /** 月视图：日历格子 + 汇总 + 月内累计序列 */
  const monthView = useMemo(() => {
    const now = new Date()
    const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
    const year = first.getFullYear()
    const month = first.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const todayKey = dayKeyOf(now)

    type Cell = {
      day: number
      key: string | null
      pnl: number | null
      count: number
      isToday: boolean
      isFuture: boolean
    }
    const leadingBlanks = (first.getDay() + 6) % 7 // 周一开头
    const cells: Cell[] = []
    for (let i = 0; i < leadingBlanks; i += 1) {
      cells.push({ day: 0, key: null, pnl: null, count: 0, isToday: false, isFuture: false })
    }
    let profit = 0
    let loss = 0
    let winDays = 0
    let lossDays = 0
    let tradedDays = 0
    let totalCount = 0
    let maxAbs = 0
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`
      const entry = cache?.days[key]
      const pnl = entry ? entry.pnl : null
      if (entry) {
        tradedDays += 1
        totalCount += entry.count
        if (entry.pnl > 0) {
          profit += entry.pnl
          winDays += 1
        } else if (entry.pnl < 0) {
          loss += entry.pnl
          lossDays += 1
        }
        maxAbs = Math.max(maxAbs, Math.abs(entry.pnl))
      }
      cells.push({
        day,
        key,
        pnl,
        count: entry?.count ?? 0,
        isToday: key === todayKey,
        isFuture: key > todayKey,
      })
    }
    const net = profit + loss
    const ratio = profit > 0 && loss === 0 ? Infinity : profit + loss === 0 ? null : profit / -loss

    const cumulative: { time: string; value: number }[] = []
    let acc = 0
    const lastDay = monthOffset === 0 ? now.getDate() : daysInMonth
    for (let day = 1; day <= lastDay; day += 1) {
      acc += cache?.days[`${year}-${pad(month + 1)}-${pad(day)}`]?.pnl ?? 0
      cumulative.push({ time: `${year}-${pad(month + 1)}-${pad(day)}`, value: acc })
    }

    return {
      title: `${year}年${month + 1}月`,
      cells,
      maxAbs,
      summary: { profit, loss, net, ratio, winDays, lossDays, tradedDays, totalCount },
      cumulative,
      hasData: tradedDays > 0,
    }
  }, [cache, monthOffset])

  /** 翻月下限：不早于最早一条账单所在月 */
  const canGoPrev = useMemo(() => {
    const earliest = cache?.earliestTsMs ?? Date.now()
    const e = new Date(earliest)
    const target = new Date()
    return new Date(target.getFullYear(), target.getMonth() + monthOffset - 1, 1).getTime() >=
      new Date(e.getFullYear(), e.getMonth(), 1).getTime()
  }, [cache, monthOffset])

  const s = monthView.summary
  const ratioText =
    s.ratio === Infinity ? "∞" : s.ratio == null ? "--" : `${s.ratio.toFixed(2)} : 1`

  const summaryCells = [
    {
      label: "盈亏比",
      value: ratioText,
      valueClass: "text-[var(--text-primary)]",
      sub: s.winDays + s.lossDays > 0 ? `盈利 ${s.winDays} 天 · 亏损 ${s.lossDays} 天` : "本月暂无盈亏记录",
    },
    {
      label: "总盈利",
      value: `+${fmtMoney(s.profit)}`,
      valueClass: "text-up",
      sub: "当月盈利日合计",
    },
    {
      label: "总亏损",
      value: s.loss === 0 ? "0.00" : `-${fmtMoney(-s.loss)}`,
      valueClass: "text-down",
      sub: "当月亏损日合计",
    },
    {
      label: "净盈亏",
      value: `${s.net > 0 ? "+" : ""}${fmtMoney(s.net)}`,
      valueClass: pnlColor(s.net),
      sub: `${monthView.title} · ${venueName(venue)}`,
    },
    {
      label: "交易笔数",
      value: String(s.totalCount),
      valueClass: "text-[var(--text-primary)]",
      sub: `有盈亏记录 ${s.tradedDays} 天`,
    },
  ]

  const coverageText = useMemo(() => {
    if (!cache) return ""
    const parts: string[] = []
    if (cache.earliestTsMs != null) {
      const e = new Date(cache.earliestTsMs)
      parts.push(`覆盖 ${e.getMonth() + 1}月${e.getDate()}日 起`)
    }
    if (cache.billCount >= BILLS_LIMIT) parts.push(`已达单次 ${BILLS_LIMIT} 条上限，较早账单未含`)
    return parts.join(" · ")
  }, [cache])

  return (
    <div className="mt-4 pt-4 border-t border-[var(--border)]/60">
      {/* 工具行：月份切换 + 场所徽章 + 刷新 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="上一月"
            disabled={monthOffset <= -240 || !canGoPrev}
            onClick={() => setMonthOffset((v) => v - 1)}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </Button>
          <span className="text-sm font-semibold min-w-[88px] text-center">
            {monthView.title}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="下一月"
            disabled={monthOffset >= 0}
            onClick={() => setMonthOffset((v) => v + 1)}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
          {venueName(venue)}{credential?.demo ? " 模拟盘" : " 实盘"}
        </span>
        {credential?.api_key_masked && (
          <span className="font-num text-[10px] text-[var(--text-muted)]">{credential.api_key_masked}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {cache && (
            <span className="text-[10px] text-[var(--text-muted)] font-num">
              数据截至 {new Date(cache.fetchedAt).toLocaleString("zh-CN", { hour12: false })}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!credential || loading}
            onClick={() => void doRefresh()}
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            刷新
          </Button>
        </div>
      </div>

      {/* 未配置凭证 / 加载 / 出错 提示 */}
      {credLoaded && !credential && (
        <div className="mt-3 rounded-lg bg-[var(--bg-tertiary)]/50 px-4 py-6 text-center">
          <p className="text-xs text-[var(--text-secondary)]">
            尚未配置 {venueName(venue)} 实盘凭证。盈亏日历通过业务服务器同步实盘账单，
            请先在「资产 → 实盘交易所接入」配置 API 凭证。
          </p>
          <Link
            href="/assets"
            className="inline-flex items-center h-7 px-3 mt-2 rounded-md text-xs bg-[var(--bg-primary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            去配置实盘凭证
          </Link>
        </div>
      )}
      {!credLoaded && !cache && (
        <p className="mt-3 text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> 检查实盘凭证配置…
        </p>
      )}
      {loading && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)] font-num">同步实盘账单中…</p>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-2">
          <p className="text-[11px] text-[var(--accent-danger)] break-all">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px]"
            disabled={loading || !credential}
            onClick={() => void doRefresh()}
          >
            重试
          </Button>
        </div>
      )}

      {credential && (
        <>
          {/* 汇总条：盈亏比 / 总盈利 / 总亏损 / 净盈亏 / 交易笔数 */}
          <div className="mt-3 grid grid-cols-2 lg:grid-cols-5 gap-2 rounded-lg bg-[var(--bg-tertiary)]/50 px-2 py-3">
            {summaryCells.map((c, i) => (
              <div key={c.label} className={cn("min-w-0 px-1", i > 0 ? "border-l border-[var(--border)]/60 pl-3" : undefined)}>
                <div className="text-[11px] text-[var(--text-muted)]">{c.label}</div>
                <div className={cn("font-num text-lg font-semibold truncate mt-0.5", c.valueClass)}>
                  {c.value}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">{c.sub}</div>
              </div>
            ))}
          </div>

          {/* 日历九宫格：每格当日盈亏，底色深浅=盈亏强度 */}
          <div className="mt-3 grid grid-cols-7 gap-1">
            {WEEKDAYS.map((w) => (
              <div key={w} className="text-center text-[10px] text-[var(--text-muted)] pb-1">
                {w}
              </div>
            ))}
            {monthView.cells.map((c, i) =>
              c.key ? (
                <div
                  key={c.key}
                  className={cn(
                    "rounded-md border px-1 py-1 min-h-[46px] flex flex-col gap-0.5",
                    c.pnl == null || c.pnl === 0
                      ? "border-[var(--border)]/40 bg-[var(--bg-tertiary)]/30"
                      : "border-transparent",
                    c.isToday && "ring-1 ring-[var(--text-primary)]/50",
                  )}
                  style={
                    c.pnl != null && c.pnl !== 0 && monthView.maxAbs > 0
                      ? {
                          backgroundColor:
                            c.pnl > 0
                              ? `rgba(239,68,68,${(0.08 + 0.24 * Math.min(Math.abs(c.pnl) / monthView.maxAbs, 1)).toFixed(3)})`
                              : `rgba(34,197,94,${(0.08 + 0.24 * Math.min(Math.abs(c.pnl) / monthView.maxAbs, 1)).toFixed(3)})`,
                        }
                      : undefined
                  }
                  title={
                    c.pnl != null
                      ? `${c.key} · ${fmtCompact(c.pnl)} USDT${c.count > 0 ? ` · ${c.count} 笔` : ""}`
                      : c.key
                  }
                >
                  <span className="text-[10px] text-[var(--text-muted)] leading-none">{c.day}</span>
                  {c.pnl != null ? (
                    <span className={cn("font-num text-[11px] font-semibold leading-tight break-all", pnlColor(c.pnl))}>
                      {fmtCompact(c.pnl)}
                    </span>
                  ) : (
                    !c.isFuture && (
                      <span className="text-[10px] text-[var(--text-muted)]/50 leading-none">--</span>
                    )
                  )}
                </div>
              ) : (
                <div key={`blank-${i}`} />
              ),
            )}
          </div>

          {/* 当月累计盈亏曲线 */}
          <div className="mt-3">
            <div className="text-[11px] text-[var(--text-muted)] mb-1">
              当月累计盈亏曲线（{monthView.title}，USDT）
            </div>
            {monthView.hasData && monthView.cumulative.length > 0 ? (
              <CumulativeChart points={monthView.cumulative} />
            ) : (
              <div className="h-[100px] rounded-lg bg-[var(--bg-tertiary)]/30 flex items-center justify-center text-[11px] text-[var(--text-muted)]">
                {cache ? "本月暂无盈亏记录" : "暂无数据"}
              </div>
            )}
          </div>

          <p className="mt-2 text-[10px] text-[var(--text-muted)]">
            口径：实盘账单「已实现盈亏 + 手续费」按自然日聚合；红=盈、绿=亏。
            账单经业务服务器同步自 {venueName(venue)}
            {credential.demo ? "（模拟盘）" : ""}，复用「实盘交易所接入」凭证；
            {coverageText ? ` ${coverageText}。` : " "}
            聚合与图表在本地计算。
          </p>
        </>
      )}
    </div>
  )
}
