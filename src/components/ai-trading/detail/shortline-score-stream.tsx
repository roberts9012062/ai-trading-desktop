"use client"

/** 短线打分流面板 —— 最近 50 步 cadence 分数(服务端环形缓冲)
 *
 * 抽屉「分析记录」对短线任务按设计折叠了 hold 步(3-60s cadence 会刷屏),
 * 只留有意义动作;本面板补上逐 cadence 的打分轨迹,让"秒级分析记录"可见。
 */

import { useEffect, useState } from "react"
import { getShortlineScores, type ShortlineScoreStep } from "@/lib/shortline/server-api"

function fmtTime(tsMs: number): string {
  const d = new Date(tsMs)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const ACTION_STYLE: Record<string, string> = {
  open_long: "text-emerald-500",
  open_short: "text-red-500",
  close: "text-amber-500",
  hold: "text-[var(--text-muted)]",
}

export function ShortlineScoreStream({ taskId }: { taskId: string }) {
  const [steps, setSteps] = useState<ShortlineScoreStep[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const rows = await getShortlineScores(taskId)
        if (!cancelled) {
          setSteps(rows)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [taskId])

  if (error) {
    return (
      <div className="text-[11px] text-red-500 px-1 py-2">
        打分流不可用：{error}
      </div>
    )
  }
  if (steps === null) {
    return <div className="text-[11px] text-[var(--text-muted)] px-1 py-2">加载打分流…</div>
  }

  return (
    <div className="rounded-md border border-[var(--border)] mb-3">
      <div className="px-2 py-1.5 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--text-secondary)]">
          短线打分流（最近 {steps.length} 步 · 每 10s 刷新）
        </span>
        <span className="text-[10px] text-[var(--text-muted)]">
          hold 步在「分析记录」列表中按设计折叠,此处为逐 cadence 原始轨迹
        </span>
      </div>
      <div className="max-h-52 overflow-auto divide-y divide-[var(--border)]">
        {steps.length === 0 ? (
          <div className="text-[11px] text-[var(--text-muted)] px-2 py-2">
            暂无打分记录(任务可能未运行或刚启动)
          </div>
        ) : (
          steps.map((s, i) => (
            <div key={`${s.ts}-${i}`} className="flex items-center gap-2 px-2 py-1 text-[11px]">
              <span className="font-num text-[var(--text-muted)] w-16 shrink-0">
                {fmtTime(s.ts)}
              </span>
              <span
                className={`font-num w-20 shrink-0 ${
                  (s.combo ?? 0) > 0 ? "text-emerald-500" : "text-red-500"
                }`}
              >
                {typeof s.combo === "number" ? s.combo.toFixed(4) : "—"}
              </span>
              <span className={`w-16 shrink-0 ${ACTION_STYLE[s.action] ?? ""}`}>
                {s.action}
                {s.stale ? "·陈旧" : ""}
              </span>
              <span className="text-[var(--text-muted)] truncate">{s.rule ?? s.eval_error ?? ""}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
