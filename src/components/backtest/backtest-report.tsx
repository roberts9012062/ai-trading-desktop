"use client"

/**
 * 回测报告：指标 + K 线买卖点 + 成交明细
 * 多段回测时：汇总指标 + 段对比表 + 选中段明细（复用单段渲染）
 */

import { useState } from "react"
import type {
  BacktestBar,
  BacktestMetrics,
  BacktestReport,
  BacktestSegmentReport,
  BacktestTrade,
} from "@/lib/backtest-api"
import { BacktestKlineChart } from "@/components/backtest/backtest-kline-chart"
import { decisionActionLabel } from "@/lib/trade-labels"
import { cn } from "@/lib/utils"

interface BacktestReportViewProps {
  report: BacktestReport
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "up" | "down" | "muted"
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-tertiary)]/40 px-3 py-2.5">
      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
      <div
        className={cn(
          "mt-1 text-sm font-semibold font-num",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
          !tone && "text-[var(--text-primary)]",
        )}
      >
        {value}
      </div>
    </div>
  )
}

function signed(value: number, suffix = ""): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`
}

/** 单段明细：指标网格 + K 线买卖点 + 成交明细 */
function SegmentDetail({
  metrics,
  bars,
  trades,
  timeframe,
  summary,
}: {
  metrics: BacktestMetrics
  bars: BacktestBar[]
  trades: BacktestTrade[]
  timeframe: string
  summary?: string
}): React.JSX.Element {
  const up = metrics.total_return >= 0
  return (
    <div className="space-y-4">
      {summary && (
        <div className="text-xs text-[var(--text-secondary)]">{summary}</div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Metric
          label="总收益"
          value={signed(metrics.total_return)}
          tone={up ? "up" : "down"}
        />
        <Metric
          label="收益率"
          value={signed(metrics.total_return_pct, "%")}
          tone={up ? "up" : "down"}
        />
        <Metric
          label="最大回撤"
          value={`${metrics.max_drawdown_pct.toFixed(2)}%`}
          tone="down"
        />
        <Metric label="胜率" value={`${metrics.win_rate.toFixed(1)}%`} />
        <Metric label="期末权益" value={metrics.final_equity.toLocaleString()} />
        <Metric label="手续费(USDT)" value={metrics.fees_paid.toFixed(2)} tone="muted" />
        <Metric label="成交笔数" value={String(metrics.trade_count)} />
        <Metric label="盈亏比" value={String(metrics.profit_factor)} />
      </div>

      <div className="rounded-xl border border-[var(--border)] p-3">
        <div className="text-xs text-[var(--text-muted)] mb-2">
          回测 K 线 · 下方标记买卖点
        </div>
        <BacktestKlineChart bars={bars} trades={trades} timeframe={timeframe} />
      </div>

      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <div className="px-3 py-2 text-xs text-[var(--text-muted)] border-b border-[var(--border)]">
          成交明细（最近 {trades.length} 笔）
        </div>
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-[var(--text-muted)] sticky top-0 bg-[var(--bg-secondary)]">
              <tr>
                <th className="text-left p-2 font-normal">时间</th>
                <th className="text-left p-2 font-normal">动作</th>
                <th className="text-right p-2 font-normal">价</th>
                <th className="text-right p-2 font-normal">量</th>
                <th className="text-right p-2 font-normal">盈亏</th>
                <th className="text-right p-2 font-normal" title="相对本笔保证金（杠杆放大后）；悬浮看名义口径">
                  收益率
                </th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="p-4 text-center text-[var(--text-muted)]"
                  >
                    期间无成交
                  </td>
                </tr>
              )}
              {trades.map((t, i) => (
                <tr
                  key={i}
                  className="border-t border-[var(--border)]/60 text-[var(--text-secondary)]"
                >
                  <td className="p-2 whitespace-nowrap">
                    {String(t.time || "")}
                  </td>
                  <td className="p-2">
                    {decisionActionLabel(String(t.action || ""))}
                  </td>
                  <td className="p-2 text-right font-num">
                    {Number(t.price || 0).toFixed(2)}
                  </td>
                  <td className="p-2 text-right font-num">
                    {String(t.quantity || "")}
                  </td>
                  <td
                    className={cn(
                      "p-2 text-right font-num",
                      Number(t.pnl || 0) > 0 && "text-up",
                      Number(t.pnl || 0) < 0 && "text-down",
                    )}
                  >
                    {Number(t.pnl || 0).toFixed(2)}
                  </td>
                  <td
                    className={cn(
                      "p-2 text-right font-num",
                      Number(t.pnl_pct_margin || 0) > 0 && "text-up",
                      Number(t.pnl_pct_margin || 0) < 0 && "text-down",
                    )}
                    title={
                      Number(t.pnl_pct_notional || 0) !== 0
                        ? `保证金口径（杠杆后）${Number(t.pnl_pct_margin).toFixed(2)}%｜名义口径 ${Number(t.pnl_pct_notional).toFixed(2)}%｜保证金 ${t.margin} USDT × ${t.leverage || 1}x`
                        : undefined
                    }
                  >
                    {t.action === "close" && Number(t.pnl_pct_notional || 0) !== 0
                      ? `${Number(t.pnl_pct_margin || 0) > 0 ? "+" : ""}${Number(t.pnl_pct_margin || 0).toFixed(2)}%`
                      : "--"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function ReportHeader({ report }: { report: BacktestReport }): React.JSX.Element {
  const cfg = report.config
  const timeframe = String(cfg.timeframe || "1d")
  return (
    <div className="rounded-xl border border-[var(--border)] bg-gradient-to-br from-sky-500/10 to-transparent p-4">
      <div className="text-sm font-medium text-[var(--text-primary)]">
        {report.message}
      </div>
      <div className="mt-1 text-[11px] text-[var(--text-muted)]">
        {String(cfg.symbol_name || cfg.symbol)} · {timeframe} ·{" "}
        {String(cfg.start_date)} → {String(cfg.end_date)} ·{" "}
        {String(cfg.strategy_type)}
        {cfg.execution_mode === "local" ? " · 本机计算" : ""}
        {cfg.ai_calls ? ` · AI ${String(cfg.ai_calls)} 次` : ""}
      </div>
    </div>
  )
}

/** 多段回测视图：汇总 + 段对比 + 选中段明细 */
function MultiSegmentReportView({
  report,
}: {
  report: BacktestReport
}): React.JSX.Element {
  const segments = report.segments ?? []
  const [selected, setSelected] = useState(0)
  const cfg = report.config
  const timeframe = String(cfg.timeframe || "1d")
  const m = report.metrics
  const segCount = Number(m.segment_count || segments.length || 1)
  const compound = Number(m.compound_return_pct || 0)
  const meanRet = Number(m.mean_segment_return_pct || 0)
  const winning = Number(m.winning_segments || 0)
  const active: BacktestSegmentReport =
    segments[Math.min(selected, segments.length - 1)] ?? segments[0]

  return (
    <div className="space-y-4">
      <ReportHeader report={report} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Metric
          label="复合收益率"
          value={signed(compound, "%")}
          tone={compound >= 0 ? "up" : "down"}
        />
        <Metric
          label="平均段收益率"
          value={signed(meanRet, "%")}
          tone={meanRet >= 0 ? "up" : "down"}
        />
        <Metric
          label={`盈利段（共 ${segCount} 段）`}
          value={`${winning}/${segCount}`}
          tone={winning * 2 > segCount ? "up" : "down"}
        />
        <Metric
          label="平均最大回撤"
          value={`${Number(m.mean_segment_drawdown_pct || 0).toFixed(2)}%`}
          tone="down"
        />
        <Metric label="汇总胜率" value={`${m.win_rate.toFixed(1)}%`} />
        <Metric label="汇总成交笔数" value={String(m.trade_count)} />
        <Metric label="手续费合计(USDT)" value={m.fees_paid.toFixed(2)} tone="muted" />
        <Metric label="汇总盈亏比" value={String(m.profit_factor)} />
      </div>

      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <div className="px-3 py-2 text-xs text-[var(--text-muted)] border-b border-[var(--border)]">
          段对比（随机抽取，点击查看该段明细）
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[var(--text-muted)] bg-[var(--bg-secondary)]">
              <tr>
                <th className="text-left p-2 font-normal">段</th>
                <th className="text-left p-2 font-normal">区间</th>
                <th className="text-right p-2 font-normal">收益率</th>
                <th className="text-right p-2 font-normal">最大回撤</th>
                <th className="text-right p-2 font-normal">胜率</th>
                <th className="text-right p-2 font-normal">成交</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((seg) => {
                const sm = seg.metrics
                const ret = Number(sm.total_return_pct || 0)
                const isActive = seg.index === active?.index
                return (
                  <tr
                    key={seg.index}
                    onClick={() => setSelected(seg.index)}
                    className={cn(
                      "border-t border-[var(--border)]/60 cursor-pointer text-[var(--text-secondary)] transition-colors",
                      isActive
                        ? "bg-[var(--primary)]/10 text-[var(--text-primary)]"
                        : "hover:bg-[var(--bg-tertiary)]",
                    )}
                  >
                    <td className="p-2 font-medium">段 {seg.index + 1}</td>
                    <td className="p-2 whitespace-nowrap font-num">
                      {seg.start_date} → {seg.end_date}
                    </td>
                    <td
                      className={cn(
                        "p-2 text-right font-num",
                        ret > 0 && "text-up",
                        ret < 0 && "text-down",
                      )}
                    >
                      {signed(ret, "%")}
                    </td>
                    <td className="p-2 text-right font-num">
                      {Number(sm.max_drawdown_pct || 0).toFixed(2)}%
                    </td>
                    <td className="p-2 text-right font-num">
                      {Number(sm.win_rate || 0).toFixed(1)}%
                    </td>
                    <td className="p-2 text-right font-num">
                      {String(sm.trade_count || 0)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {active && (
        <div>
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
            段 {active.index + 1} 明细
            <span className="text-[11px] font-normal text-[var(--text-muted)] font-num">
              {active.start_date} → {active.end_date}
            </span>
          </div>
          <SegmentDetail
            metrics={active.metrics}
            bars={active.bars ?? []}
            trades={active.trades ?? []}
            timeframe={timeframe}
            summary={active.message}
          />
        </div>
      )}
    </div>
  )
}

/** 回测报告面板 */
export function BacktestReportView({
  report,
}: BacktestReportViewProps): React.JSX.Element {
  if (report.segments && report.segments.length > 0) {
    return <MultiSegmentReportView report={report} />
  }

  const m = report.metrics
  const cfg = report.config
  const timeframe = String(cfg.timeframe || "1d")

  return (
    <div className="space-y-4">
      <ReportHeader report={report} />
      <SegmentDetail
        metrics={m}
        bars={report.bars ?? []}
        trades={report.trades}
        timeframe={timeframe}
      />
    </div>
  )
}
