"use client"

/**
 * OKX 盈亏日历（本地直连，不与业务服务器交互）
 *
 * 结构自上而下：月度汇总条（盈亏比 / 总盈利 / 总亏损 / 净盈亏）→
 * 日历九宫格（每格当日盈亏，红盈绿亏 CN 口径，底色深浅=当日盈亏强度）→
 * 当月累计盈亏曲线（lightweight-charts）。
 *
 * 数据源：OKX /api/v5/account/bills-history 本地签名分页拉取，按日聚合
 * 「已实现盈亏 + 手续费 + 资金费」；凭据与聚合缓存仅存本机 localStorage。
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
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  clearLocalOkxCredentials,
  clearOkxDailyCache,
  loadLocalOkxCredentials,
  loadOkxDailyCache,
  refreshOkxDailyPnl,
  saveLocalOkxCredentials,
  testOkxConnection,
  type OkxDailyPnlCache,
  type OkxInstType,
  type OkxLocalCredentials,
} from "@/lib/okx-direct"

const INST_TYPES: { value: OkxInstType; label: string }[] = [
  { value: "SWAP", label: "永续" },
  { value: "FUTURES", label: "交割" },
  { value: "MARGIN", label: "杠杆" },
]

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

/** 当月累计盈亏曲线：业务日字符串作 Time，固定展示整月横轴 */
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

/** 本地 OKX 凭据配置弹窗：保存/测试/删除，凭据只落本机 */
function CredentialsDialog({
  open,
  onOpenChange,
  creds,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  creds: OkxLocalCredentials | null
  onSaved: (c: OkxLocalCredentials | null) => void
}): React.JSX.Element {
  const [form, setForm] = useState({ apiKey: "", secret: "", passphrase: "", demo: false })
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (open) {
      setForm({
        apiKey: creds?.apiKey ?? "",
        secret: "",
        passphrase: "",
        demo: creds?.demo ?? false,
      })
      setError("")
      setMessage("")
    }
  }, [open, creds])

  const merged = (): OkxLocalCredentials | null => {
    const apiKey = form.apiKey.trim()
    if (!apiKey) {
      setError("请填写 API Key")
      return null
    }
    const secret = form.secret.trim() || creds?.secret || ""
    if (!secret) {
      setError("请填写 Secret")
      return null
    }
    const passphrase = form.passphrase.trim() || creds?.passphrase || ""
    if (!passphrase) {
      setError("请填写 Passphrase（OKX 专用）")
      return null
    }
    return { apiKey, secret, passphrase, demo: form.demo }
  }

  const save = () => {
    const c = merged()
    if (!c) return
    saveLocalOkxCredentials(c)
    onSaved(c)
    onOpenChange(false)
  }

  const test = async () => {
    const c = merged()
    if (!c) return
    setError("")
    setMessage("")
    setTesting(true)
    try {
      const res = await testOkxConnection(c)
      setMessage(`连通正常 · 权益 ${res.equity.toFixed(2)} USDT${c.demo ? "（模拟盘）" : ""}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "连通失败")
    } finally {
      setTesting(false)
    }
  }

  const remove = () => {
    setBusy(true)
    try {
      clearLocalOkxCredentials()
      clearOkxDailyCache()
      onSaved(null)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>OKX 本地直连凭据</DialogTitle>
          <DialogDescription>
            凭据仅保存在本机，用于本地签名直连 OKX 拉取账单，不会上传任何服务器。
            建议只开启「读取 + 交易」权限，禁止提币权限。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">API Key</Label>
            <Input
              className="h-8 text-xs font-num"
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder="输入 API Key"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Secret{creds ? "（留空保留原值）" : ""}</Label>
            <Input
              className="h-8 text-xs font-num"
              type="password"
              value={form.secret}
              onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
              placeholder={creds ? "留空保留原值" : "输入 Secret"}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Passphrase（OKX 专用{creds ? "，留空保留原值" : ""}）</Label>
            <Input
              className="h-8 text-xs font-num"
              type="password"
              value={form.passphrase}
              onChange={(e) => setForm((f) => ({ ...f, passphrase: e.target.value }))}
              placeholder={creds ? "留空保留原值" : "输入口令"}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={form.demo}
              onChange={(e) => setForm((f) => ({ ...f, demo: e.target.checked }))}
            />
            模拟盘凭证（OKX Demo Trading）
          </label>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" disabled={testing} onClick={() => void test()}>
              {testing && <Loader2 className="w-3 h-3 animate-spin" />}测试连通
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={save}>
              保存
            </Button>
            {creds && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-[var(--accent-danger)]"
                disabled={busy}
                onClick={remove}
              >
                删除本机凭据
              </Button>
            )}
          </div>
          {error && <p className="text-[11px] text-[var(--accent-danger)] break-all">{error}</p>}
          {message && <p className="text-[11px] text-[var(--accent-up)] break-all">{message}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function OkxPnlCalendar(): React.JSX.Element {
  const [creds, setCreds] = useState<OkxLocalCredentials | null>(() => loadLocalOkxCredentials())
  const [instType, setInstType] = useState<OkxInstType>("SWAP")
  const [cache, setCache] = useState<OkxDailyPnlCache | null>(() => loadOkxDailyCache("SWAP"))
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState("")
  const [monthOffset, setMonthOffset] = useState(0)
  const [configOpen, setConfigOpen] = useState(false)
  const reqSeq = useRef(0)

  const doRefresh = useCallback(async () => {
    if (!creds) return
    const seq = (reqSeq.current += 1)
    setLoading(true)
    setError("")
    setProgress(0)
    try {
      const next = await refreshOkxDailyPnl({
        instType,
        creds,
        onProgress: (n) => {
          if (reqSeq.current === seq) setProgress(n)
        },
      })
      if (reqSeq.current === seq) setCache(next)
    } catch (e) {
      if (reqSeq.current === seq) {
        setError(e instanceof Error ? e.message : "同步 OKX 账单失败")
      }
    } finally {
      if (reqSeq.current === seq) setLoading(false)
    }
  }, [creds, instType])

  useEffect(() => {
    if (!creds) {
      setCache(null)
      return
    }
    const cached = loadOkxDailyCache(instType)
    setCache(cached && cached.demo === creds.demo ? cached : null)
    const stale =
      !cached || cached.demo !== creds.demo || Date.now() - cached.fetchedAt > 10 * 60 * 1000
    if (stale) void doRefresh()
  }, [creds, instType, doRefresh])

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

  const canGoPrev = useMemo(() => {
    const earliest = cache ? cache.fetchedAt - cache.windowDays * 86_400_000 : Date.now()
    const target = new Date()
    return new Date(target.getFullYear(), target.getMonth() + monthOffset - 1, 1).getTime() >=
      new Date(
        new Date(earliest).getFullYear(),
        new Date(earliest).getMonth(),
        1,
      ).getTime()
  }, [cache, monthOffset])

  const instLabel = INST_TYPES.find((t) => t.value === instType)?.label ?? instType
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
      sub: `${monthView.title} · ${instLabel}`,
    },
    {
      label: "交易笔数",
      value: String(s.totalCount),
      valueClass: "text-[var(--text-primary)]",
      sub: `有盈亏记录 ${s.tradedDays} 天`,
    },
  ]

  return (
    <div className="mt-4 pt-4 border-t border-[var(--border)]/60">
      {/* 工具行：月份切换 + 产品类型 + 刷新/配置 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label="上一月"
            disabled={monthOffset <= -120 || !canGoPrev}
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
        <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
          {INST_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={cn(
                "px-2 h-7 text-[11px] transition-colors",
                instType === t.value
                  ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
              )}
              onClick={() => setInstType(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {cache && (
            <span className="text-[10px] text-[var(--text-muted)] font-num">
              数据截至 {new Date(cache.fetchedAt).toLocaleString("zh-CN", { hour12: false })} · 近{cache.windowDays}天
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!creds || loading}
            onClick={() => void doRefresh()}
          >
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setConfigOpen(true)}
          >
            <Settings2 className="w-3 h-3" />
            {creds ? "凭据" : "配置 OKX API"}
          </Button>
        </div>
      </div>

      {/* 无凭据 / 加载 / 出错 提示 */}
      {!creds && (
        <div className="mt-3 rounded-lg bg-[var(--bg-tertiary)]/50 px-4 py-6 text-center">
          <p className="text-xs text-[var(--text-secondary)]">
            配置 OKX API 凭据后，本地直连拉取账单并统计每日盈亏（不经过服务器）。
          </p>
          <Button size="sm" className="h-7 text-xs mt-2" onClick={() => setConfigOpen(true)}>
            配置 OKX API
          </Button>
        </div>
      )}
      {loading && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)] font-num">
          同步 OKX 账单中…已获取 {progress} 条
        </p>
      )}
      {error && (
        <div className="mt-2 flex items-center gap-2">
          <p className="text-[11px] text-[var(--accent-danger)] break-all">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px]"
            disabled={loading || !creds}
            onClick={() => void doRefresh()}
          >
            重试
          </Button>
        </div>
      )}

      {creds && (
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
            口径：OKX 账单「已实现盈亏 + 手续费 + 资金费」按自然日本地聚合；红=盈、绿=亏。
            数据在本地签名直连 OKX 获取并计算，不与业务服务器交互；凭据仅存本机。
          </p>
        </>
      )}

      <CredentialsDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        creds={creds}
        onSaved={(c) => {
          setCreds(c)
          setMonthOffset(0)
        }}
      />
    </div>
  )
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
