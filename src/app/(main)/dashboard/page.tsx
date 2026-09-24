"use client"

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { AssetSummaryBar } from "@/components/dashboard/asset-summary"
import { ActiveChannelBadge } from "@/components/dashboard/active-channel-badge"
import { WatchlistTable } from "@/components/dashboard/watchlist"
import { PositionOverview } from "@/components/dashboard/position-overview"
import { RecentTrades } from "@/components/dashboard/recent-trades"
import { AnnouncementBar } from "@/components/dashboard/announcement-bar"
import { AiTradingOverview } from "@/components/dashboard/ai-trading-overview"

/** 工作台 —— 实时账户/持仓/成交 + AI 交易概览（信号筛选已移至 行情→行情筛选） */
export default function DashboardPage(): React.JSX.Element {
  return (
    <div className="flex flex-col h-full">
      <ActiveChannelBadge />
      <AssetSummaryBar />

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>自选行情</CardTitle>
            </CardHeader>
            <CardContent>
              <WatchlistTable />
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>持仓概览</CardTitle>
              </CardHeader>
              <CardContent>
                <PositionOverview />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>最近成交</CardTitle>
              </CardHeader>
              <CardContent>
                <RecentTrades />
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>AI 交易概览</CardTitle>
          </CardHeader>
          <CardContent>
            <AiTradingOverview />
          </CardContent>
        </Card>
      </div>

      <AnnouncementBar />
    </div>
  )
}
