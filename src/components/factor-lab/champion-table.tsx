"use client"

/**
 * Champion 排行表 —— 点击行选中因子并触发回测；表头带指标释义
 */

import { useState } from "react"
import type { Champion } from "@/lib/factor-lab-api"
import { cn } from "@/lib/utils"
import { FACTOR_HELP, HelpTip } from "./help-tip"
import { ComboSimilarityPanel } from "./combo/combo-similarity-panel"

interface ChampionTableProps {
  champions: Champion[]
  selectedTokens: number[] | null
  onSelect: (champion: Champion) => void
  onFavorite: ((champion: Champion) => void) | null
  /** 已收藏的 tokens_key 集合；命中则整行变灰、收藏按钮禁用为"已收藏" */
  favoritedKeys?: Set<string>
  /** 组合挂载回调：勾选 2-5 个未带 overfit_warning 的冠军后可触发 */
  onComboMount?: ((champions: Champion[]) => void) | null
  /** 组合相关性分析用的品种/周期（与挂载目标一致；未传时面板不分析） */
  comboSymbol?: string
  comboTimeframe?: string
}

function tokenKey(tokens: number[]): string {
  return tokens.join(",")
}

interface HeadCellProps {
  label: string
  help: string
  align: "left" | "right"
}

/** 表头单元格 + 问号 */
function HeadCell(props: HeadCellProps): React.JSX.Element {
  const { label, help, align } = props
  return (
    <th
      className={cn(
        "px-2 py-1.5 font-medium",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-0.5",
          align === "right" && "justify-end w-full",
        )}
      >
        {label}
        <HelpTip
          text={help}
          side="bottom"
          align={align === "right" ? "end" : "start"}
          className=""
        />
      </span>
    </th>
  )
}

/** Champion 排行表 */
export function ChampionTable({
  champions,
  selectedTokens,
  onSelect,
  onFavorite,
  favoritedKeys,
  onComboMount,
  comboSymbol,
  comboTimeframe,
}: ChampionTableProps): React.JSX.Element {
  // 本地 pending：点击收藏后立即置灰，避免重复点击；网络失败由调用方负责回退
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  // 组合勾选：2-5 个成员
  const [comboKeys, setComboKeys] = useState<Set<string>>(new Set())

  if (champions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
        暂无结果，先配置参数并执行搜索
      </div>
    )
  }
  // 防过拟合：任一 champion 带 test_metrics 时才显示测试列（动态列）
  const showTest = champions.some((c) => c.metrics.test_metrics)
  // 增强挖掘(本地 selection_v2)产出封存段指标与 DSR 时才显示对应列
  const showHoldout = champions.some((c) => c.metrics.holdout_metrics)
  const showDsr = champions.some((c) => c.metrics.dsr != null)
  const activeKey = selectedTokens ? tokenKey(selectedTokens) : null
  const showCombo = !!onComboMount && champions.length >= 2
  const comboChampions = showCombo
    ? champions.filter(
        (c) =>
          comboKeys.has(tokenKey(c.tokens)) && !c.metrics.overfit_warning,
      )
    : []
  const comboReady = showCombo && comboChampions.length >= 2
  return (
    <div className="space-y-2">
      {showCombo && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-2.5 space-y-2">
          <div className="flex items-center justify-end gap-2 text-xs">
            <span className="text-[var(--text-muted)]">
              勾选 2-5 个低相关因子组合挂载（等权）
            </span>
            <button
              type="button"
              disabled={!comboReady}
              className={cn(
                "text-[11px] px-2 py-0.5 rounded-md border border-[var(--border)]",
                comboReady
                  ? "text-[var(--primary)] hover:bg-[var(--bg-tertiary)] cursor-pointer"
                  : "text-[var(--text-muted)] cursor-not-allowed",
              )}
              onClick={() => {
                if (comboReady && onComboMount) {
                  onComboMount(comboChampions)
                  setComboKeys(new Set())
                }
              }}
            >
              组合挂载所选 ({comboChampions.length})
            </button>
          </div>
          <ComboSimilarityPanel
            champions={comboChampions}
            symbol={comboSymbol || ""}
            timeframe={comboTimeframe || ""}
          />
        </div>
      )}
    <div className="rounded-xl border border-[var(--border)] overflow-x-auto overflow-y-visible bg-[var(--bg-secondary)]">
      <table className="w-full text-xs">
        <thead className="bg-[var(--bg-tertiary)] text-[var(--text-muted)] relative z-10">
          <tr>
            {showCombo && (
              <th className="w-6 px-1 py-1.5" aria-label="组合勾选" />
            )}
            <th className="text-left px-2 py-1.5 font-medium">#</th>
            <HeadCell label="公式" help={FACTOR_HELP.formula} align="left" />
            <HeadCell label="综合" help={FACTOR_HELP.composite} align="right" />
            <HeadCell label="年化" help={FACTOR_HELP.ann_ret} align="right" />
            <HeadCell label="Sortino" help={FACTOR_HELP.sortino} align="right" />
            <HeadCell label="OOS" help={FACTOR_HELP.oos_sortino} align="right" />
            {showTest && (
              <HeadCell
                label="测试年化"
                help={FACTOR_HELP.test_ann_ret}
                align="right"
              />
            )}
            {showTest && (
              <HeadCell
                label="测试Sortino"
                help={FACTOR_HELP.test_sortino}
                align="right"
              />
            )}
            {showHoldout && (
              <HeadCell label="封存Sortino" help={FACTOR_HELP.holdout_sortino} align="right" />
            )}
            {showDsr && <HeadCell label="DSR" help={FACTOR_HELP.dsr} align="right" />}
            <th className="text-right px-2 py-1.5 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {champions.map((c, i) => {
            const key = tokenKey(c.tokens)
            const on = activeKey === key
            const tm = c.metrics.test_metrics
            // 过拟合警告标记：训练年化>10% 但测试年化为负，或后端标注了 overfit_warning（兜底回退）
            const overfit =
              (!!tm && c.metrics.ann_ret > 0.1 && tm.ann_ret < 0) ||
              Boolean(c.metrics.overfit_warning)
            // v2 研究状态徽标(crypto_local_v2):封存通过/验证通过/拒绝/探索
            const status = String(c.metrics.candidate_status ?? "")
            const statusBadge =
              status === "holdout_passed" ? "封存通过"
              : status === "validation_passed" ? "验证通过"
              : status === "rejected" ? "已拒绝"
              : status === "exploratory" ? "探索"
              : ""
            const insufficient = Boolean(c.metrics.insufficient_samples)
            // 已收藏：后端已入库 或 本地 pending（刚点击）—— 整行变灰、收藏按钮禁用
            const favorited =
              (favoritedKeys?.has(key) ?? false) || pendingKeys.has(key)
            const comboOn = comboKeys.has(key)
            return (
              <tr
                key={key}
                onClick={() => onSelect(c)}
                className={cn(
                  "cursor-pointer border-t border-[var(--border)] transition-colors",
                  on
                    ? "bg-[var(--primary)]/10"
                    : "hover:bg-[var(--bg-tertiary)]",
                  favorited && "opacity-50 hover:bg-transparent",
                )}
              >
                {showCombo && (
                  <td className="px-1 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)] cursor-pointer"
                      disabled={Boolean(c.metrics.overfit_warning)}
                      checked={comboOn}
                      onChange={() => {
                        setComboKeys((prev) => {
                          const next = new Set(prev)
                          if (next.has(key)) {
                            next.delete(key)
                          } else if (next.size < 5) {
                            next.add(key)
                          }
                          return next
                        })
                      }}
                    />
                  </td>
                )}
                <td className="px-2 py-1.5 text-[var(--text-muted)]">{i + 1}</td>
                <td
                  className="px-2 py-1.5 max-w-[260px] truncate font-num text-[11px] text-[var(--text-primary)]"
                  title={c.text}
                >
                  {c.metrics.local_only && (
                    <span
                      className="mr-1 px-1 py-px rounded bg-violet-500/15 text-violet-400 text-[9px] font-num"
                      title="含本地专属特征：本机执行与回放（可收藏）"
                    >
                      本地
                    </span>
                  )}
                  {statusBadge && (
                    <span
                      className={cn(
                        "mr-1 px-1 py-px rounded text-[9px] font-num",
                        status === "holdout_passed" && "bg-emerald-500/15 text-emerald-400",
                        status === "validation_passed" && "bg-sky-500/15 text-sky-400",
                        status === "rejected" && "bg-rose-500/15 text-rose-400",
                        status === "exploratory" && "bg-amber-500/15 text-amber-400",
                      )}
                      title={
                        insufficient
                          ? "样本不足，仅探索（不计入合格因子数）"
                          : status === "holdout_passed"
                            ? "预注册验证与封存评估均通过（研究证据，不自动获得实盘权限）"
                            : status === "validation_passed"
                              ? "验证区 1×/2× 成本与折检验通过（封存未揭示）"
                              : status === "rejected"
                                ? "验证区未通过严格筛"
                                : ""
                      }
                    >
                      {statusBadge}
                    </span>
                  )}
                  {c.text}
                </td>
                <td className="px-2 py-1.5 text-right font-num">
                  {c.composite.toFixed(2)}
                </td>
                <td
                  className={cn(
                    "px-2 py-1.5 text-right font-num",
                    c.metrics.ann_ret >= 0 ? "text-up" : "text-down",
                  )}
                >
                  {(c.metrics.ann_ret * 100).toFixed(1)}%
                </td>
                <td className="px-2 py-1.5 text-right font-num">
                  {c.metrics.sortino.toFixed(2)}
                </td>
                <td
                  className={cn(
                    "px-2 py-1.5 text-right font-num",
                    c.metrics.oos_sortino > 0 ? "text-up" : "text-down",
                  )}
                >
                  {c.metrics.oos_sortino.toFixed(2)}
                </td>
                {showTest && (
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right font-num",
                      overfit
                        ? "text-down font-bold"
                        : tm
                          ? tm.ann_ret >= 0
                            ? "text-up"
                            : "text-down"
                          : "text-[var(--text-muted)]",
                    )}
                    title={overfit ? FACTOR_HELP.overfit_warning : undefined}
                  >
                    {tm ? `${(tm.ann_ret * 100).toFixed(1)}%` : "—"}
                    {overfit ? " ⚠" : ""}
                  </td>
                )}
                {showTest && (
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right font-num",
                      tm
                        ? tm.sortino > 0
                          ? "text-up"
                          : "text-down"
                        : "text-[var(--text-muted)]",
                    )}
                  >
                    {tm ? tm.sortino.toFixed(2) : "—"}
                  </td>
                )}
                {showHoldout && (() => {
                  const hm = c.metrics.holdout_metrics
                  const live = hm?.live_discrete_sortino
                  return (
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right font-num",
                        hm ? (hm.sortino > 0 ? "text-up" : "text-down") : "text-[var(--text-muted)]",
                      )}
                      title={live != null ? `实盘离散口径 Sortino ${live.toFixed(2)}` : undefined}
                    >
                      {hm ? hm.sortino.toFixed(2) : "—"}
                    </td>
                  )
                })()}
                {showDsr && (
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right font-num",
                      c.metrics.dsr == null
                        ? "text-[var(--text-muted)]"
                        : c.metrics.dsr >= 0.5
                          ? "text-up"
                          : "text-[var(--text-secondary)]",
                    )}
                  >
                    {c.metrics.dsr != null ? `${(c.metrics.dsr * 100).toFixed(0)}%` : "—"}
                  </td>
                )}
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <button
                    type="button"
                    className="text-[10px] text-[var(--text-muted)] hover:text-[var(--primary)] mr-2"
                    title="复制因子 tokens"
                    onClick={(e) => {
                      e.stopPropagation()
                      void navigator.clipboard
                        .writeText(c.tokens.join(","))
                        .then(() => {
                          setCopiedKey(key)
                          setTimeout(() => setCopiedKey(null), 1200)
                        })
                        .catch(() => {})
                    }}
                  >
                    {copiedKey === key ? "已复制" : "复制"}
                  </button>
                  {onFavorite && (
                    <button
                      type="button"
                      disabled={favorited}
                      className={cn(
                        "text-[10px]",
                        favorited
                          ? "text-[var(--text-muted)] cursor-not-allowed"
                          : "text-[var(--primary)] hover:underline",
                      )}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (favorited) return
                        // 本地立即置灰，避免重复点击；收藏一次入库就好
                        setPendingKeys((prev) => {
                          const next = new Set(prev)
                          next.add(key)
                          return next
                        })
                        onFavorite(c)
                      }}
                    >
                      {favorited ? "已收藏" : "收藏"}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
    </div>
  )
}
