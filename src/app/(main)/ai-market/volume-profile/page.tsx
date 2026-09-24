"use client"

import { Suspense } from "react"
import { VolumeProfileWorkspace } from "@/components/market/volume-profile-workspace"

/** 成交量分布页（AI看盘行情 → 成交量分布） */
export default function VolumeProfilePage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center text-sm text-[var(--text-muted)]">
          加载成交量分布…
        </div>
      }
    >
      <VolumeProfileWorkspace />
    </Suspense>
  )
}
