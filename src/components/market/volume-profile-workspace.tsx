"use client"

import { useEffect, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/stores/app"
import { useAuthStore } from "@/stores/auth"
import { useMarketStore } from "@/stores/market"
import { broadcastContractChange } from "@/hooks/sync"
import { type VolumeProfileDTO, type VolumeProfileRowDTO } from "@/lib/api"
import { contractName } from "@/lib/contract-names"
import { profileRows } from "@/lib/volume-profile-core"
import { useVolumeProfileStore } from "@/stores/volume-profile"

/**
 * 成交量分布 —— 当前交易日（前夜 21:00 夜盘起）按价格聚合的多空力量
 *
 * 【桌面端本地化分叉（同步 web 版此文件时勿覆盖数据源层）】数据源为
 * 本地引擎实时聚合（volume-profile-engine：1s 心跳采集 WS orderbook/
 * quote 快照，口径同源移植自 web 服务端 trade_tick_svc），IndexedDB 按
 * 交易日持久化，重启/刷新不丢。web 端的 REST 基线 + 30s 校准 + WS ring
 * 增量三段逻辑在桌面端由 store 订阅替代，渲染层保持同构。
 *
 * 四路开平（开多/平空/开空/平多）为估算口径：单秒主动买卖量 + 持仓变化比例分摊。
 * 多单 = 开多 + 平空（主动买方）；空单 = 开空 + 平多（主动卖方）。
 * 多空比悬殊（≥阈值）的价格标色：多头大 → 红，空头大 → 绿（涨红跌绿惯例）。
 * virtual 盘 trades 为模拟撮合，与真实分布口径不符，引擎不采集。
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

export function VolumeProfileWorkspace(): React.JSX.Element {
  const { activeContract, setActiveContract } = useAppStore()
  const tradingMode = useAuthStore((s) => s.user?.trading_mode ?? "live")
  const isLive = tradingMode === "live"
  const codeTree = useMarketStore((s) => s.codeTree)
  const fetchCodeTree = useMarketStore((s) => s.fetchCodeTree)

  const [minVolume, setMinVolume] = useState(0)
  const [ratioThreshold, setRatioThreshold] = useState(2)
  const [onlySkew, setOnlySkew] = useState(false)
  const [sortBy, setSortBy] = useState<"latest" | "volume" | "price">("latest")

  // 本地引擎聚合态（当日，symbol 小写键）；输出与 web 端 VolumeProfileDTO 同构
  const acc = useVolumeProfileStore((s) =>
    activeContract ? (s.bySymbol[activeContract.toLowerCase()] ?? null) : null,
  )
  const vpDay = useVolumeProfileStore((s) => s.day)
  const data = useMemo<VolumeProfileDTO | null>(() => {
    if (!acc || acc.asof == null) return null
    return {
      symbol: activeContract.toLowerCase(),
      trading_day: vpDay,
      asof: acc.asof,
      last_price: acc.last_price,
      rows: profileRows(acc),
    }
  }, [acc, vpDay, activeContract])

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

        <span className="ml-auto text-[10px] text-[var(--text-muted)]">
          {isLive ? "本地实时聚合 · 重启不丢" : "虚盘不采集（切回实盘后展示）"} · 开平为估算 · 按交易日清空
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
            <span>{data?.rows.length ? "没有满足筛选条件的价格" : "暂无成交（应用启动起本地采集）"}</span>
            <span className="text-[10px]">
              夜盘 21:00 起逐秒累积，按交易日清空{filterActive ? "，可放宽筛选条件" : ""}
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
