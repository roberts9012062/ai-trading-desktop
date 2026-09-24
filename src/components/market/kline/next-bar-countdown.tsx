"use client"

/**
 * 下一根 K 线倒计时徽章（工具栏"指标"按钮旁）
 * - 分时（tick）无固定桶边界、日线（1d）不换根 → 不显示
 * - 休市（is_open=false）不启动；节段表为空（虚拟盘 7×24）同样不显示
 * - 剩余时间按品种交易分钟轴计算，见 ./next-bar-countdown-utils
 */
import { useEffect, useMemo, useState } from "react"
import { useSessionStatus } from "@/hooks/use-session-status"
import type { KlinePeriod } from "@/types"
import { PERIOD_MINUTES, computeRemainingSec, nowBjPseudoSec } from "./next-bar-countdown-utils"

export function NextBarCountdown({
  symbol,
  period,
}: {
  symbol?: string | null
  period: KlinePeriod
}): React.JSX.Element | null {
  const minutes = PERIOD_MINUTES[period]
  const { status, isOpen } = useSessionStatus(symbol ?? "")
  const [nowPseudo, setNowPseudo] = useState<number>(() => nowBjPseudoSec())

  useEffect(() => {
    const timer = setInterval(() => setNowPseudo(nowBjPseudoSec()), 500)
    return () => clearInterval(timer)
  }, [])

  const remainingSec = useMemo(
    () => (symbol && isOpen ? computeRemainingSec(status?.sessions ?? [], nowPseudo, minutes) : null),
    [symbol, isOpen, status, nowPseudo, minutes],
  )

  if (remainingSec === null) return null

  const mm = String(Math.floor(remainingSec / 60)).padStart(2, "0")
  const ss = String(Math.floor(remainingSec % 60)).padStart(2, "0")

  return (
    <span
      title="距下一根K线"
      className="rounded bg-orange-500 px-2 py-0.5 text-xs font-medium tabular-nums text-white select-none"
    >
      {mm}:{ss}
    </span>
  )
}
