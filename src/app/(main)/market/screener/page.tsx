"use client"

import { Suspense } from "react"
import { ScreenerWorkspace } from "@/components/screener/screener-workspace"

/** 行情筛选页（行情 → 行情筛选） */
export default function MarketScreenerPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
          加载行情筛选…
        </div>
      }
    >
      <ScreenerWorkspace />
    </Suspense>
  )
}
