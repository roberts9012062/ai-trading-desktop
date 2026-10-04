"use client"

/**
 * 选中因子：公式摘要、操作按钮、曲线与指标卡
 */

import { FactorEquityChart } from "../factor-equity-chart"
import { FACTOR_HELP, HelpTip, MetricCard } from "../help-tip"
import type { Champion, FactorBacktestResult } from "@/lib/factor-lab-api"
import { cn } from "@/lib/utils"
import { useEffect, useState } from "react"
import { ProfitLockSettings } from "@/components/ai-trading/form/profit-lock-settings"
import { DEFAULT_PROFIT_LOCK, buildProfitLockConfig } from "@/lib/profit-lock"
import type { ProfitLockConfig } from "@/lib/ai-trading-api"

interface SelectedFactorPanelProps {
  selected: Champion | null
  bt: FactorBacktestResult | null
  btLoading: boolean
  building: boolean
  buildMsg: string | null
  favoritedKeys?: Set<string>
  onBuildTask: (profitLock?: ProfitLockConfig) => void
  onFavorite: () => void
  onCopyTokens: () => void
}

/** 右侧选中因子详情 */
export function SelectedFactorPanel(
  props: SelectedFactorPanelProps,
): React.JSX.Element {
  const {
    selected,
    bt,
    btLoading,
    building,
    buildMsg,
    favoritedKeys,
    onBuildTask,
    onFavorite,
    onCopyTokens,
  } = props
  const selectedFavorited = Boolean(
    selected && favoritedKeys?.has(selected.tokens.join(",")),
  )
  // 兜底回退因子（测试段亏损/WF 不稳健）：禁止收藏与挂载实盘
  const overfit = Boolean(selected?.metrics?.overfit_warning)
  const [profitLock, setProfitLock] = useState({ ...DEFAULT_PROFIT_LOCK })
  const [lockError, setLockError] = useState("")
  const selectedKey = selected?.tokens.join(",")
  useEffect(() => { setProfitLock({ ...DEFAULT_PROFIT_LOCK }); setLockError("") }, [selectedKey])
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-[var(--text-secondary)]">
        资金曲线
      </h2>
      {selected && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-xs space-y-1.5">
          <div className="font-num text-[11px] text-[var(--text-primary)] break-all">
            {selected.text}
          </div>
          <div className="flex gap-3 flex-wrap text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-0.5">
              综合
              <HelpTip
                text={FACTOR_HELP.composite}
                side="top"
                align="center"
                className=""
              />
              <span className="font-num text-[var(--text-primary)] ml-0.5">
                {selected.composite.toFixed(2)}
              </span>
            </span>
            <span className="inline-flex items-center gap-0.5">
              ts_IC
              <HelpTip
                text={FACTOR_HELP.ts_ic}
                side="top"
                align="center"
                className=""
              />
              <span className="font-num text-[var(--text-primary)] ml-0.5">
                {selected.metrics.ts_ic.toFixed(3)}
              </span>
            </span>
            {/* P5 统计严谨性：多重检验修正后的可信度标注 */}
            {selected.metrics.pbo_proxy != null && (
              <span
                className="inline-flex items-center gap-0.5"
                title="训练段最优 K 个候选中样本外失败的比例（PBO 代理）"
              >
                PBO
                <span
                  className={cn(
                    "font-num ml-0.5",
                    selected.metrics.pbo_proxy >= 0.5
                      ? "text-down"
                      : "text-[var(--text-primary)]",
                  )}
                >
                  {(selected.metrics.pbo_proxy * 100).toFixed(0)}%
                </span>
              </span>
            )}
            {selected.metrics.oos_conservative != null && (
              <span
                className="inline-flex items-center gap-0.5"
                title="测试段四等分最差子段的 Sortino（样本外保守下界）"
              >
                保守OOS
                <span
                  className={cn(
                    "font-num ml-0.5",
                    selected.metrics.oos_conservative > 0
                      ? "text-up"
                      : "text-down",
                  )}
                >
                  {selected.metrics.oos_conservative.toFixed(2)}
                </span>
              </span>
            )}
            {selected.metrics.trials != null && (
              <span
                className="inline-flex items-center gap-0.5"
                title="本次搜索总试验数（该分数是 N 次尝试的最优值）"
              >
                试验
                <span className="font-num text-[var(--text-primary)] ml-0.5">
                  {selected.metrics.trials}
                </span>
              </span>
            )}
          </div>
          {selected.metrics.regime && (
            <div
              className="flex items-center gap-3 flex-wrap text-[11px] pt-0.5"
              title="测试段按市场状态切分的 Sortino（识别依赖单一行情的单腿因子）"
            >
              <span className="text-[var(--text-muted)]">状态分解</span>
              {(["trend_up", "trend_down", "chop"] as const).map((k) => {
                const seg = selected.metrics!.regime?.[k]
                if (!seg || seg.sortino == null) return null
                const label =
                  k === "trend_up" ? "趋势上" : k === "trend_down" ? "趋势下" : "震荡"
                return (
                  <span key={k} className="inline-flex items-center gap-0.5">
                    {label}
                    <span
                      className={cn(
                        "font-num ml-0.5",
                        seg.sortino > 0 ? "text-up" : "text-down",
                      )}
                    >
                      {seg.sortino.toFixed(2)}
                    </span>
                    <span className="text-[var(--text-muted)]">
                      ({seg.bars}根)
                    </span>
                  </span>
                )
              })}
            </div>
          )}
          <ProfitLockSettings value={profitLock} onChange={setProfitLock} />
          {lockError && <p role="alert" className="text-xs text-red-400">{lockError}</p>}
          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button
              type="button"
              onClick={() => {
                try { const config = buildProfitLockConfig(profitLock); setLockError(""); onBuildTask(config) }
                catch (e) { setLockError(e instanceof Error ? e.message : "锁利设置无效") }
              }}
              disabled={building || overfit}
              title={overfit ? "未通过样本外验证，禁止挂载实盘" : undefined}
              className="text-[11px] px-2.5 py-1 rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/20 disabled:opacity-50"
            >
              {building ? "创建中…" : "创建为因子任务"}
            </button>
            <button
              type="button"
              onClick={onFavorite}
              disabled={selectedFavorited || overfit}
              title={overfit ? "未通过样本外验证，禁止收藏" : undefined}
              className={cn(
                "text-[11px] px-2.5 py-1 rounded-md border",
                selectedFavorited || overfit
                  ? "border-[var(--border)] text-[var(--text-muted)] opacity-60 cursor-not-allowed"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
              )}
            >
              {selectedFavorited ? "已收藏" : "收藏"}
            </button>
            {overfit && (
              <span className="text-[11px] text-down">
                ⚠ 该因子未通过样本外验证（测试段亏损），已禁止收藏/挂载
              </span>
            )}
            <button
              type="button"
              onClick={onCopyTokens}
              className="text-[11px] px-2.5 py-1 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              复制 tokens
            </button>
            {buildMsg && (
              <span className="text-[11px] text-[var(--text-muted)] truncate">
                {buildMsg}
              </span>
            )}
          </div>
        </div>
      )}
      {btLoading ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
          回测中…
        </div>
      ) : (
        <FactorEquityChart curve={bt?.equity_curve ?? []} />
      )}
      {bt && (
        <div className="text-[11px] text-[var(--text-muted)] font-num">
          区间 {bt.range?.from?.slice(0, 10) ?? "—"} ~{" "}
          {bt.range?.to?.slice(0, 10) ?? "—"} · {bt.bars} 根
        </div>
      )}
      {/* 实盘离散口径：±1 手全进全出 + 0.3 入场阈值，与连续仓位理论值对照 */}
      {bt?.live_metrics && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]/30 px-3 py-2 text-[11px] text-[var(--text-secondary)] font-num flex items-center gap-3 flex-wrap">
          <span className="text-[var(--text-muted)]">实盘口径（±1手·0.3入场）</span>
          <span>
            年化{" "}
            <span
              className={cn(
                bt.live_metrics.ann_ret >= 0 ? "text-up" : "text-down",
              )}
            >
              {(bt.live_metrics.ann_ret * 100).toFixed(1)}%
            </span>
          </span>
          <span>Sortino {bt.live_metrics.sortino.toFixed(2)}</span>
          <span>开仓 {bt.live_metrics.n_trades} 次</span>
          <span className="text-[var(--text-muted)]">
            （连续仓位理论值：{((bt.metrics.ann_ret ?? 0) * 100).toFixed(1)}%）
          </span>
        </div>
      )}
      {bt && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <MetricCard
            label="年化"
            value={`${(bt.metrics.ann_ret * 100).toFixed(1)}%`}
            up={bt.metrics.ann_ret >= 0}
            help={FACTOR_HELP.ann_ret}
          />
          <MetricCard
            label="Sortino"
            value={bt.metrics.sortino.toFixed(2)}
            up={bt.metrics.sortino > 0}
            help={FACTOR_HELP.sortino}
          />
          <MetricCard
            label="Calmar"
            value={bt.metrics.calmar.toFixed(2)}
            up={bt.metrics.calmar > 0}
            help={FACTOR_HELP.calmar}
          />
          <MetricCard
            label="OOS Sortino"
            value={bt.metrics.oos_sortino.toFixed(2)}
            up={bt.metrics.oos_sortino > 0}
            help={FACTOR_HELP.oos_sortino}
          />
        </div>
      )}
      {/* 防过拟合：训练 vs 测试段对比（存在 test_metrics 时才显示） */}
      {bt?.metrics.test_metrics && bt?.metrics.train_metrics && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-xs space-y-2">
          <div className="flex items-center gap-1 text-[var(--text-secondary)]">
            <span className="font-medium">训练 vs 测试对比</span>
            <HelpTip
              text={FACTOR_HELP.test_metrics}
              side="top"
              align="center"
              className=""
            />
          </div>
          <div className="grid grid-cols-3 gap-2 font-num">
            <div className="text-[var(--text-muted)]">指标</div>
            <div className="text-[var(--text-muted)] text-right">训练段</div>
            <div className="text-[var(--text-muted)] text-right">测试段</div>
            <div>年化</div>
            <div className="text-right">
              {(bt.metrics.train_metrics.ann_ret * 100).toFixed(1)}%
            </div>
            <div
              className={cn(
                "text-right",
                bt.metrics.test_metrics.ann_ret >= 0
                  ? "text-up"
                  : "text-down font-bold",
              )}
            >
              {(bt.metrics.test_metrics.ann_ret * 100).toFixed(1)}%
            </div>
            <div>Sortino</div>
            <div className="text-right">
              {bt.metrics.train_metrics.sortino.toFixed(2)}
            </div>
            <div
              className={cn(
                "text-right",
                bt.metrics.test_metrics.sortino > 0
                  ? "text-up"
                  : "text-down font-bold",
              )}
            >
              {bt.metrics.test_metrics.sortino.toFixed(2)}
            </div>
            <div>ts_IC</div>
            <div className="text-right">
              {bt.metrics.train_metrics.ts_ic.toFixed(3)}
            </div>
            <div
              className={cn(
                "text-right",
                bt.metrics.test_metrics.ts_ic >= 0 ? "text-up" : "text-down",
              )}
            >
              {bt.metrics.test_metrics.ts_ic.toFixed(3)}
            </div>
          </div>
          {/* 过拟合警告：训练好但测试为负 */}
          {bt.metrics.train_metrics.ann_ret > 0.1 &&
            bt.metrics.test_metrics.ann_ret < 0 && (
              <div className="text-[11px] text-down flex items-center gap-1">
                <span>⚠</span>
                <span>{FACTOR_HELP.overfit_warning}</span>
              </div>
            )}
        </div>
      )}
      {/* 防过拟合：walk-forward 滚动验证明细 */}
      {bt?.walk_forward && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-xs space-y-2">
          <div className="flex items-center gap-1 text-[var(--text-secondary)]">
            <span className="font-medium">
              Walk-Forward 验证（{bt.walk_forward.n_folds} 折）
            </span>
            <HelpTip
              text={FACTOR_HELP.walk_forward_folds}
              side="top"
              align="center"
              className=""
            />
            <span
              className={cn(
                "ml-auto px-1.5 py-0.5 rounded text-[10px]",
                bt.walk_forward.wf_stable
                  ? "bg-up/15 text-up"
                  : "bg-down/15 text-down",
              )}
            >
              {bt.walk_forward.wf_stable ? "稳健" : "不稳"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 font-num">
            <div className="text-[var(--text-muted)]">折</div>
            <div className="text-[var(--text-muted)] text-right">训练Sortino</div>
            <div className="text-[var(--text-muted)] text-right">测试Sortino</div>
            {bt.walk_forward.folds.map((f, idx) => (
              <FoldRow key={idx} idx={idx} fold={f} />
            ))}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] flex justify-between">
            <span>
              平均测试年化:
              <span
                className={cn(
                  "ml-1 font-num",
                  bt.walk_forward.wf_mean_test_ann >= 0
                    ? "text-up"
                    : "text-down",
                )}
              >
                {(bt.walk_forward.wf_mean_test_ann * 100).toFixed(1)}%
              </span>
            </span>
            <span>
              跨折一致性: {bt.walk_forward.wf_consistency.toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/** walk-forward 单折行 */
function FoldRow({
  idx,
  fold,
}: {
  idx: number
  fold: { train: { sortino: number }; test: { sortino: number } }
}): React.JSX.Element {
  return (
    <>
      <div className="text-[var(--text-muted)]">#{idx + 1}</div>
      <div className="text-right">{fold.train.sortino.toFixed(2)}</div>
      <div
        className={cn(
          "text-right",
          fold.test.sortino > 0 ? "text-up" : "text-down font-bold",
        )}
      >
        {fold.test.sortino.toFixed(2)}
      </div>
    </>
  )
}
