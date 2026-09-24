"use client"

/**
 * 回测时间尺 —— 双柄范围选择
 * 左柄=开始，右柄=结束，中间蓝色；拖到边界超最大宽度时连带另一端平移。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  maxDaysFor,
  parseISO,
  railDaysFor,
  railStartFor,
  RAIL_START_ISO,
  toISO,
} from "@/components/backtest/timeframe-limits"

interface BacktestRangeSliderProps {
  timeframe: string
  start: string
  end: string
  today: Date
  onChange: (start: string, end: string) => void
  /** 手动输入超出 K 线周期约束时上抛错误文案；null 表示合法 */
  onRangeError?: (msg: string | null) => void
  /** 覆盖默认的周期最大天数（因子评估等场景用自己的上限表） */
  maxDaysOverride?: number
  /** 最小区间（含首尾自然天，默认 1）。多段回测传 段数×周期上限，
   * 拖柄/键盘/手动输入三处统一强制不低于该跨度 */
  minDays?: number
}

const DAY_MS = 86_400_000

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** 双柄时间尺 */
export function BacktestRangeSlider(
  props: BacktestRangeSliderProps,
): React.JSX.Element {
  const { timeframe, start, end, today, onChange, onRangeError, maxDaysOverride } =
    props
  const minDays = Math.max(1, Math.floor(props.minDays ?? 1))
  const railRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<null | "start" | "end" | "range">(null)
  // 整体平移用「绝对锚点」法：pointerdown 时记录鼠标 pct 与区间起始 pct，
  // move 时 nl = 锚点leftPct + (当前pct - 锚点pct)。
  // 不依赖被拖拽冻结保护锁定的 rangeRef，避免增量无法累加导致蓝条拖不动。
  const rangeAnchorPct = useRef(0)
  const rangeAnchorLeft = useRef(0)

  // 时间尺起点固定为 2024-01-01，跨度随 today 动态增长。
  // 所有周期统一长尺，用户在尺上拖选区选回测段。
  const railStart = useMemo(() => railStartFor(), [])
  const railDays = useMemo(
    () => railDaysFor(timeframe, today),
    [timeframe, today],
  )
  const maxDays = maxDaysOverride ?? maxDaysFor(timeframe)

  const startD = parseISO(start)
  const endD = parseISO(end)
  const leftPct = clamp(diffDays(startD, railStart) / railDays, 0, 1)
  const rightPct = clamp(diffDays(endD, railStart) / railDays, 0, 1)
  const maxGap = Math.min(1, maxDays / railDays)
  // 最小可选跨度（含首尾）：默认 1 天（maxGap 封顶防分钟周期倒挂）；
  // 多段回测等场景由 minDays 指定更大的下限（如 3 段 15m → 90 天）。
  // 旧值 maxGap*0.05 在 1d 周期高达 ~91 天，鼠标/键盘都选不到 7 天级小跨度。
  const minGap = Math.min(maxGap, minDays / railDays)

  const pctToISO = useCallback(
    (pct: number): string => {
      const d = new Date(railStart)
      d.setUTCDate(d.getUTCDate() + Math.round(pct * railDays))
      return toISO(d)
    },
    [railStart, railDays],
  )

  // 手动输入日期的约束校验：与拖柄几何 clamp 同源（都用 maxDaysFor），
  // 保证手动/拖动两套入口约束完全等价。非法值不回写，弹出"已超出"。
  const todayISO = toISO(today)
  const applyManualDate = useCallback(
    (which: "start" | "end", value: string): void => {
      if (!value) return // 清空时不处理，等用户输完
      const ns = which === "start" ? value : start
      const ne = which === "end" ? value : end
      const sD = parseISO(ns)
      const eD = parseISO(ne)
      if (eD.getTime() < sD.getTime()) {
        onRangeError?.("结束日期不能早于开始日期")
        return
      }
      if (diffDays(eD, sD) + 1 < minDays) {
        onRangeError?.(
          `区间至少需要 ${minDays} 天（当前 ${diffDays(eD, sD) + 1} 天）`,
        )
        return
      }
      if (diffDays(eD, sD) > maxDays) {
        onRangeError?.(`已超出回测时间范围：${timeframe} 周期最多 ${maxDays} 天`)
        return
      }
      if (ns < RAIL_START_ISO || ns > todayISO || ne < RAIL_START_ISO || ne > todayISO) {
        onRangeError?.(`日期超出可选范围（${RAIL_START_ISO} ~ ${todayISO}）`)
        return
      }
      onRangeError?.(null)
      onChange(ns, ne)
    },
    [start, end, maxDays, minDays, timeframe, todayISO, onChange, onRangeError],
  )

  const clientToPct = useCallback((clientX: number): number => {
    const el = railRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return clamp((clientX - rect.left) / rect.width, 0, 1)
  }, [])

  // 用 ref 实时跟踪当前区间，避免 useCallback 闭包在快速拖拽时用过期值。
  // 拖拽期间冻结：防止 props 回写（start/end）或 timeframe 变化触发重渲染时，
  // 把 rangeRef 覆盖成新派生值，导致 move 系列函数基准跳变、柄乱伸缩。
  const rangeRef = useRef({ leftPct, rightPct, maxGap, minGap })
  if (!drag) {
    rangeRef.current = { leftPct, rightPct, maxGap, minGap }
  }

  const moveStart = useCallback(
    (pct: number): void => {
      const { leftPct: lp, rightPct: rp, maxGap: mg, minGap: mng } =
        rangeRef.current
      // 左柄：向右拖（缩小区间）右柄不动；向左拖（扩大区间）超 maxGap 才连带右柄
      const expanding = pct < lp
      let nl = clamp(pct, 0, rp - mng)
      let nr = rp
      if (expanding && nr - nl > mg) {
        if (nl + mg <= 1) {
          nr = nl + mg
        } else {
          nr = 1
          nl = 1 - mg
        }
      }
      onChange(pctToISO(nl), pctToISO(nr))
    },
    [pctToISO, onChange],
  )

  const moveEnd = useCallback(
    (pct: number): void => {
      const { leftPct: lp, rightPct: rp, maxGap: mg, minGap: mng } =
        rangeRef.current
      // 右柄：向左拖（缩小区间）左柄不动；向右拖（扩大区间）超 maxGap 才连带左柄
      const expanding = pct > rp
      let nr = clamp(pct, lp + mng, 1)
      let nl = lp
      if (expanding && nr - nl > mg) {
        if (nr - mg >= 0) {
          nl = nr - mg
        } else {
          nl = 0
          nr = mg
        }
      }
      onChange(pctToISO(nl), pctToISO(nr))
    },
    [pctToISO, onChange],
  )

  // 键盘微调：←/→ = ±1 天，Shift+←/→ = ±30 天。
  // 复用 moveStart/moveEnd，与鼠标拖动共用同一套 minGap/maxGap 约束与超宽连带平移。
  const nudgeStart = useCallback(
    (deltaDays: number): void => {
      const { leftPct: lp } = rangeRef.current
      moveStart(clamp(lp + deltaDays / railDays, 0, 1))
    },
    [moveStart, railDays],
  )
  const nudgeEnd = useCallback(
    (deltaDays: number): void => {
      const { rightPct: rp } = rangeRef.current
      moveEnd(clamp(rp + deltaDays / railDays, 0, 1))
    },
    [moveEnd, railDays],
  )

  // 整体平移：保持区间宽度，左右柄一起移动；撞边界贴边
  // 绝对锚点法：nl = 锚点leftPct + (当前pct - 锚点pct)，不读冻结的 rangeRef，
  // 避免每次 move 都以原始位置为基准导致位移无法累加（旧实现的"阻力"BUG）。
  const moveRange = useCallback(
    (pct: number): void => {
      const { rightPct: rp } = rangeRef.current
      const width = rp - rangeAnchorLeft.current
      const nl = clamp(
        rangeAnchorLeft.current + (pct - rangeAnchorPct.current),
        0,
        1 - width,
      )
      const nr = nl + width
      onChange(pctToISO(nl), pctToISO(nr))
    },
    [pctToISO, onChange],
  )

  useEffect(() => {
    if (!drag) return
    function onMove(e: PointerEvent): void {
      const pct = clientToPct(e.clientX)
      if (drag === "start") moveStart(pct)
      else if (drag === "end") moveEnd(pct)
      else moveRange(pct)
    }
    function onUp(): void {
      setDrag(null)
    }
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", onUp)
    return () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onUp)
    }
  }, [drag, clientToPct, moveStart, moveEnd, moveRange])

  return (
    <div className="space-y-2 select-none" style={{ touchAction: "none" }}>
      <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] font-num">
        <span>{toISO(railStart)}</span>
        {minDays > 1 ? (
          <span>
            最少 <span className="text-[var(--text-secondary)]">{minDays}</span> 天
            · 区间无上限
          </span>
        ) : (
          <span>
            最大 <span className="text-[var(--text-secondary)]">{maxDays}</span> 天
          </span>
        )}
        <span>{toISO(today)}</span>
      </div>
      <div
        ref={railRef}
        className="relative h-9 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border)]"
      >
        {/* 选中区间（可拖动整体平移） */}
        <div
          className="absolute top-0 bottom-0 rounded-full bg-[var(--primary)]/35 border-x border-[var(--primary)]/60 cursor-grab active:cursor-grabbing"
          style={{ left: `${leftPct * 100}%`, right: `${(1 - rightPct) * 100}%` }}
          onPointerDown={(e) => {
            e.preventDefault()
            // 记录锚点：鼠标起始 pct + 区间起始 leftPct（用 live 值，不用冻结 ref）
            rangeAnchorPct.current = clientToPct(e.clientX)
            rangeAnchorLeft.current = leftPct
            setDrag("range")
          }}
        />
        {/* 左柄 */}
        <Handle
          pct={leftPct}
          label={start}
          onDown={() => setDrag("start")}
          onNudge={nudgeStart}
          active={drag === "start"}
        />
        {/* 右柄 */}
        <Handle
          pct={rightPct}
          label={end}
          onDown={() => setDrag("end")}
          onNudge={nudgeEnd}
          active={drag === "end"}
        />
      </div>
      <div className="text-[10px] text-center text-[var(--text-muted)]">
        点击拖柄后可用 ←/→ 微调 ±1 天，Shift+←/→ 一次 30 天
      </div>
      <div className="flex items-center justify-between text-xs text-[var(--text-primary)] font-num gap-2">
        <label className="flex items-center gap-1 cursor-pointer">
          起
          <input
            type="date"
            value={start}
            min={RAIL_START_ISO}
            max={todayISO}
            onChange={(e) => applyManualDate("start", e.target.value)}
            className="bg-transparent border-b border-[var(--border)] text-[var(--primary)] focus:outline-none focus:border-[var(--primary)] cursor-text px-0.5 py-0.5"
          />
        </label>
        <span className="text-[var(--text-muted)]">
          {diffDays(endD, startD) + 1} 天
        </span>
        <label className="flex items-center gap-1 cursor-pointer">
          止
          <input
            type="date"
            value={end}
            min={RAIL_START_ISO}
            max={todayISO}
            onChange={(e) => applyManualDate("end", e.target.value)}
            className="bg-transparent border-b border-[var(--border)] text-[var(--primary)] focus:outline-none focus:border-[var(--primary)] cursor-text px-0.5 py-0.5"
          />
        </label>
      </div>
    </div>
  )
}

interface HandleProps {
  pct: number
  label: string
  onDown: () => void
  onNudge: (deltaDays: number) => void
  active: boolean
}

function Handle(props: HandleProps): React.JSX.Element {
  const { pct, label, onDown, onNudge, active } = props
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault()
        // preventDefault 会吞掉点击聚焦，手动补上，
        // 让「拖完直接按 ←/→ 微调」成立；纯键盘用户也可 Tab 聚焦。
        e.currentTarget.focus()
        onDown()
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
        e.preventDefault()
        onNudge((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 30 : 1))
      }}
      // 柄视觉宽度只有 6px：长轨道上 1px ≈ 好几天，宽柄会把「两柄相碰」
      // 变成事实上的最小跨度（用户想微调也压不进去）。命中区用伪元素
      // 外扩 ±8px，视觉细但点按手感不变。拖动中的柄抬高 z，防止钻到另一柄下面。
      className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-9 rounded-full border-2 bg-[var(--bg-secondary)] shadow before:absolute before:inset-y-0 before:-inset-x-2 before:content-[''] ${
        active
          ? "z-20 border-[var(--primary)] scale-125"
          : "z-10 border-[var(--primary)]/70 hover:border-[var(--primary)]"
      }`}
      style={{ left: `${pct * 100}%` }}
    />
  )
}
