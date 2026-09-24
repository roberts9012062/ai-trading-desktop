"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { useAuthStore } from "@/stores/auth"
import { useMarketStore } from "@/stores/market"
import { broadcastContractChange } from "@/hooks/sync"
import {
  getVolumeProfileApi,
  type VolumeProfileDTO,
  type VolumeProfileRowDTO,
} from "@/lib/api"
import { contractName } from "@/lib/contract-names"
import type { TradeRecord } from "@/types"

/**
 * 成交量分布 —— 当前交易日（前夜 21:00 夜盘起）按价格聚合的多空力量
 *
 * 数据源：后端 trade_tick 按 price GROUP BY 聚合（每晚 20:30 清空，只看当日）。
 * 四路开平（开多/平空/开空/平多）为估算口径：单秒主动买卖量 + 持仓变化比例分摊。
 * 多单 = 开多 + 平空（主动买方）；空单 = 开空 + 平多（主动卖方）。
 * 多空比悬殊（≥阈值）的价格标色：多头大 → 红，空头大 → 绿（涨红跌绿惯例）。
 *
 * 更新机制：REST 全量聚合为权威基线；live 盘叠加 WS trades 帧（秒级）增量累积，
 * 按秒级 ts 去重、以 REST asof 对齐防重复，每 30s REST 校准防漂移。
 * virtual 盘 trades 为模拟撮合，与真实分布口径不符，不参与增量。
 */

type EnrichedRow = VolumeProfileRowDTO & {
  /** 多空比 max/min，一侧为 0 时为 Infinity */
  ratio: number
  dominant: "buy" | "sell"
}

const _fmt = (n: number): string => n.toLocaleString("zh-CN")

function _formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "∞"
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}:1`
}

/** ts（"20260917 21:00:05" 或 "2026-09-17 21:00:05"）→ 可比较的 "YYYY-MM-DD HH:MM:SS" */
function _tsKey(ts: string): string {
  const spaceAt = ts.indexOf(" ")
  if (spaceAt < 0) return ts
  const d = ts.slice(0, spaceAt)
  const t = ts.slice(spaceAt + 1, spaceAt + 9)
  if (d.length === 8 && /^\d+$/.test(d)) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t}`
  }
  return `${d} ${t}`
}

/** 已消费的秒级 ts（去重），按插入顺序修剪防止无限增长 */
const _SEEN_LIMIT = 240

export function VolumeProfileWorkspace(): React.JSX.Element {
  const { activeContract, setActiveContract } = useAppStore()
  const tradingMode = useAuthStore((s) => s.user?.trading_mode ?? "live")
  const isLive = tradingMode === "live"
  const codeTree = useMarketStore((s) => s.codeTree)
  const fetchCodeTree = useMarketStore((s) => s.fetchCodeTree)

  const [data, setData] = useState<VolumeProfileDTO | null>(null)
  const [loading, setLoading] = useState(false)
  const [minVolume, setMinVolume] = useState(0)
  const [ratioThreshold, setRatioThreshold] = useState(2)
  const [onlySkew, setOnlySkew] = useState(false)
  const [sortBy, setSortBy] = useState<"latest" | "volume" | "price">("latest")

  // live 盘逐秒成交环形（WS 全市场广播，store 整表替换）；兼容大小写 symbol 键
  const liveTrades = useMarketStore((s) => {
    if (!activeContract) return undefined
    return (
      s.trades[activeContract] ??
      s.trades[activeContract.toLowerCase()] ??
      s.trades[activeContract.toUpperCase()]
    )
  })

  const seenRef = useRef<Set<string>>(new Set())
  const seenOrderRef = useRef<string[]>([])

  const _markSeen = (key: string) => {
    if (seenRef.current.has(key)) return
    seenRef.current.add(key)
    seenOrderRef.current.push(key)
    if (seenOrderRef.current.length > _SEEN_LIMIT) {
      const drop = seenOrderRef.current.splice(0, seenOrderRef.current.length - _SEEN_LIMIT)
      for (const k of drop) seenRef.current.delete(k)
    }
  }

  // 品种下拉数据（主力合约列表）
  useEffect(() => {
    if (!codeTree) void fetchCodeTree()
  }, [codeTree, fetchCodeTree])

  const masterOptions = useMemo(() => {
    if (!codeTree) return [] as Array<{ value: string; label: string }>
    return Object.values(codeTree)
      .filter((t) => t.master)
      .map((t) => ({
        value: t.master as string,
        label: `${t.name}（${t.master}）`,
      }))
  }, [codeTree])

  const refresh = useCallback(async () => {
    if (!activeContract) {
      setData(null)
      return
    }
    setLoading(true)
    try {
      const fresh = await getVolumeProfileApi(activeContract)
      // 以 REST asof 对齐环形：≤ asof 的秒已含在快照里，标记已见防 WS 重复累积；
      // > asof 的留给 WS 增量（快照未含，避免丢失）
      const asofKey = fresh.asof ? fresh.asof.slice(0, 19).replace("T", " ") : ""
      const ring = useMarketStore.getState().trades[activeContract.toLowerCase()]
      seenRef.current = new Set()
      seenOrderRef.current = []
      if (ring) {
        for (const t of ring) {
          if (!t.ts) continue
          if (!asofKey || _tsKey(t.ts) <= asofKey) _markSeen(t.ts)
        }
      }
      setData(fresh)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [activeContract])

  // 合约变化时刷新
  useEffect(() => {
    void refresh()
  }, [refresh])

  // 每 30s REST 校准一次（权威快照兜底 WS 断连/漂移/20:30 清空）
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(timer)
  }, [refresh])

  // WS 秒级增量：环形里未见的秒 → 合并进当前分布（data 有基线后才启用）
  useEffect(() => {
    if (!isLive || !data) return
    const list = liveTrades ?? []
    const freshItems: Array<TradeRecord & { ts: string }> = []
    for (const t of list) {
      if (!t.ts) continue
      if (seenRef.current.has(t.ts)) continue
      _markSeen(t.ts)
      freshItems.push({ ...t, ts: t.ts })
    }
    if (freshItems.length === 0) return
    setData((prev) => {
      if (!prev) return prev
      const byPrice = new Map(prev.rows.map((r) => [r.price, { ...r }]))
      let lastKey = prev.asof ? prev.asof.slice(0, 19).replace("T", " ") : ""
      let lastPrice = prev.last_price
      for (const t of freshItems) {
        const row =
          byPrice.get(t.price) ??
          ({
            price: t.price,
            open_long: 0,
            close_long: 0,
            open_short: 0,
            close_short: 0,
            buy_total: 0,
            sell_total: 0,
            total: 0,
          } satisfies VolumeProfileRowDTO)
        row.total += t.volume
        const { open_long, close_long, open_short, close_short } = t
        if (
          open_long != null &&
          close_long != null &&
          open_short != null &&
          close_short != null
        ) {
          row.open_long += open_long
          row.close_long += close_long
          row.open_short += open_short
          row.close_short += close_short
          row.buy_total += open_long + close_short
          row.sell_total += open_short + close_long
        }
        byPrice.set(t.price, row)
        const key = _tsKey(t.ts)
        if (key > lastKey) {
          lastKey = key
          lastPrice = t.price
        }
      }
      return {
        ...prev,
        rows: [...byPrice.values()],
        asof: lastKey || prev.asof,
        last_price: lastPrice,
      }
    })
  }, [isLive, data, liveTrades])

  // 派生：多空比 + 过滤 + 排序
  const rows = useMemo<EnrichedRow[]>(() => {
    if (!data) return []
    return data.rows.map((r) => {
      const dominant: "buy" | "sell" = r.buy_total >= r.sell_total ? "buy" : "sell"
      const minor = dominant === "buy" ? r.sell_total : r.buy_total
      const major = dominant === "buy" ? r.buy_total : r.sell_total
      return { ...r, ratio: minor > 0 ? major / minor : Infinity, dominant }
    })
  }, [data])

  const maxTotal = useMemo(
    () => rows.reduce((m, r) => Math.max(m, r.total), 0),
    [rows],
  )

  const visibleRows = useMemo(() => {
    let out = rows
    if (minVolume > 0 || (onlySkew && ratioThreshold > 1)) {
      out = out.filter((r) => {
        if (minVolume > 0 && r.total >= minVolume) return true
        if (onlySkew && ratioThreshold > 1 && r.ratio >= ratioThreshold) return true
        return false
      })
    }
    const sorted = [...out].sort((a, b) =>
      sortBy === "volume" || sortBy === "latest"
        ? b.total - a.total
        : b.price - a.price,
    )
    // "最新价"模式：最新成交价档置顶（其余保持总手降序），一眼定位当前价位
    if (sortBy === "latest" && data?.last_price != null) {
      const idx = sorted.findIndex((r) => r.price === data.last_price)
      if (idx > 0) {
        const [anchor] = sorted.splice(idx, 1)
        sorted.unshift(anchor)
      }
    }
    return sorted
  }, [rows, minVolume, onlySkew, ratioThreshold, sortBy, data])

  const summary = useMemo(() => {
    const total = rows.reduce((s, r) => s + r.total, 0)
    const buy = rows.reduce((s, r) => s + r.buy_total, 0)
    const sell = rows.reduce((s, r) => s + r.sell_total, 0)
    let poc: number | null = null
    let pocTotal = -1
    for (const r of rows) {
      if (r.total > pocTotal) {
        pocTotal = r.total
        poc = r.price
      }
    }
    return { total, buy, sell, poc, unknown: total - buy - sell }
  }, [rows])

  const filterActive = minVolume > 0 || onlySkew

  return (
    <div className="h-full flex flex-col text-xs">
      {/* 工具条：品种 + 阈值设置 + 刷新 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0 flex-wrap">
        <select
          value={masterOptions.some((o) => o.value === activeContract) ? activeContract : ""}
          onChange={(e) => {
            const v = e.target.value
            if (v) {
              setActiveContract(v)
              broadcastContractChange(v)
            }
          }}
          className="h-6 px-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[11px] max-w-[190px]"
          aria-label="选择品种（主力合约）"
        >
          {!masterOptions.some((o) => o.value === activeContract) && (
            <option value="">
              {activeContract ? `当前：${contractName(activeContract)}` : "选择品种"}
            </option>
          )}
          {masterOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          <span className="text-[var(--text-muted)]">≥</span>
          <input
            type="number"
            min={0}
            value={minVolume || ""}
            onChange={(e) => {
              const v = Number(e.target.value)
              setMinVolume(Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
            }}
            placeholder="总手"
            title="只显示总手数达到该值的价格"
            className="h-5 w-16 px-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[11px]"
          />
          <span className="text-[var(--text-muted)]">手</span>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-[var(--text-muted)]">悬殊比 ≥</span>
          <input
            type="number"
            min={1}
            step={0.5}
            value={ratioThreshold || ""}
            onChange={(e) => {
              const v = Number(e.target.value)
              setRatioThreshold(Number.isFinite(v) && v > 1 ? v : 0)
            }}
            title="多空比达到该值的价格标红/绿"
            className="h-5 w-14 px-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[11px]"
          />
        </div>

        <label className="flex items-center gap-1 cursor-pointer text-[11px] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={onlySkew}
            onChange={(e) => setOnlySkew(e.target.checked)}
            className="cursor-pointer"
          />
          只看悬殊
        </label>

        <div className="flex items-center gap-1">
          {(
            [
              { v: "latest", label: "最新价" },
              { v: "volume", label: "按总手" },
              { v: "price", label: "按价格" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => setSortBy(opt.v)}
              className={cn(
                "px-1.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer",
                sortBy === opt.v
                  ? "bg-[var(--primary)] text-white"
                  : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)]",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            setMinVolume(0)
            setOnlySkew(false)
          }}
          disabled={!filterActive}
          className="px-1.5 py-0.5 rounded text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] cursor-pointer disabled:opacity-40"
        >
          重置
        </button>

        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] transition-colors cursor-pointer disabled:opacity-50"
          aria-label="刷新"
          title="刷新"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>

        <span className="ml-auto text-[10px] text-[var(--text-muted)]">
          {isLive ? "WS 实时 + 30s 校准" : "30s 轮询（虚盘）"} · 开平为估算 · 每晚 20:30 清空
          {data?.asof ? ` · 至 ${data.asof.slice(11, 19)}` : ""}
        </span>
      </div>

      {/* 汇总条 */}
      <div className="flex items-center gap-4 px-3 py-1.5 border-b border-[var(--border)] shrink-0 text-[11px] text-[var(--text-secondary)] flex-wrap">
        <span>
          {activeContract ? contractName(activeContract) : "未选品种"}
          <span className="text-[var(--text-muted)]"> · 交易日 {data?.trading_day ?? "—"}</span>
        </span>
        <span>
          总手 <b className="font-num">{_fmt(summary.total)}</b>
        </span>
        <span>
          多单 <b className="font-num text-up">{_fmt(summary.buy)}</b>
        </span>
        <span>
          空单 <b className="font-num text-down">{_fmt(summary.sell)}</b>
        </span>
        {summary.poc !== null && (
          <span title="成交量最大的价格">
            POC <b className="font-num">{summary.poc}</b>
          </span>
        )}
        {summary.unknown > 0 && (
          <span className="text-[var(--text-muted)]" title="方向不明的成交（不计入多空）">
            未分类 {_fmt(summary.unknown)}
          </span>
        )}
      </div>

      {/* 表头 */}
      <div
        className="grid grid-cols-[1.1fr_2fr_1fr_1fr_1.1fr_1fr_1fr_1.1fr_1fr_1.1fr] px-3 py-1 text-[var(--text-muted)] border-b border-[var(--border)] shrink-0"
      >
        <span>价格</span>
        <span>量能（多/空构成）</span>
        <span className="text-right">开多</span>
        <span className="text-right">平空</span>
        <span className="text-right text-up">多单</span>
        <span className="text-right">开空</span>
        <span className="text-right">平多</span>
        <span className="text-right text-down">空单</span>
        <span className="text-right">多空比</span>
        <span className="text-right">总手</span>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {!activeContract ? (
          <div className="flex flex-col items-center justify-center h-[240px] text-[var(--text-muted)] gap-1 text-center">
            <span>请先选择品种</span>
            <span className="text-[10px]">可用上方下拉切换主力合约，或在行情页选择具体合约</span>
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[240px] text-[var(--text-muted)] gap-1 text-center">
            <span>{loading ? "加载中…" : data?.rows.length ? "没有满足筛选条件的价格" : "暂无成交"}</span>
            <span className="text-[10px]">
              夜盘 21:00 起逐秒累积，每晚 20:30 清空{filterActive ? "，可放宽筛选条件" : ""}
            </span>
          </div>
        ) : (
          visibleRows.map((r) => {
            const skewed =
              ratioThreshold > 1 && r.ratio >= ratioThreshold && r.total > 0
            const isAnchor = data?.last_price != null && r.price === data.last_price
            const priceColor = skewed
              ? r.dominant === "buy"
                ? "text-up font-bold"
                : "text-down font-bold"
              : "text-[var(--text-primary)]"
            const buyW = maxTotal > 0 ? (r.buy_total / maxTotal) * 100 : 0
            const sellW = maxTotal > 0 ? (r.sell_total / maxTotal) * 100 : 0
            return (
              <div
                key={r.price}
                className={cn(
                  "grid grid-cols-[1.1fr_2fr_1fr_1fr_1.1fr_1fr_1fr_1.1fr_1fr_1.1fr] px-3 py-1 items-center hover:bg-[var(--bg-tertiary)]",
                  isAnchor && "sticky top-0 z-[1] bg-[var(--bg-primary)]",
                )}
                style={
                  isAnchor
                    ? {
                        boxShadow:
                          "inset 3px 0 0 var(--primary), 0 1px 0 var(--border)",
                      }
                    : undefined
                }
                title={`价格 ${r.price}：多单 ${_fmt(r.buy_total)} 手 / 空单 ${_fmt(r.sell_total)} 手`}
              >
                <span className={cn("font-num flex items-center gap-1", priceColor)}>
                  {r.price}
                  {isAnchor && (
                    <span className="text-[9px] px-1 rounded bg-[var(--primary)]/25 text-[var(--primary)] font-medium">
                      现价
                    </span>
                  )}
                </span>
                <span className="flex items-center h-2 pr-6" aria-hidden>
                  <span className="h-2 bg-up" style={{ width: `${buyW}%` }} />
                  <span className="h-2 bg-down" style={{ width: `${sellW}%` }} />
                </span>
                <span className="text-right font-num">{_fmt(r.open_long)}</span>
                <span className="text-right font-num">{_fmt(r.close_short)}</span>
                <span className="text-right font-num text-up font-medium">
                  {_fmt(r.buy_total)}
                </span>
                <span className="text-right font-num">{_fmt(r.open_short)}</span>
                <span className="text-right font-num">{_fmt(r.close_long)}</span>
                <span className="text-right font-num text-down font-medium">
                  {_fmt(r.sell_total)}
                </span>
                <span
                  className={cn(
                    "text-right font-num",
                    skewed && r.dominant === "buy" && "text-up",
                    skewed && r.dominant === "sell" && "text-down",
                  )}
                >
                  {r.buy_total + r.sell_total > 0 ? _formatRatio(r.ratio) : "—"}
                </span>
                <span className="text-right font-num text-[var(--text-secondary)]">
                  {_fmt(r.total)}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
