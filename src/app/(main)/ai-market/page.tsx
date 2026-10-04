"use client"

import { useEffect } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { KlineChart } from "@/components/market/kline-chart"
import { NewsTicker } from "@/components/market/news-ticker"
import { NewsViewerDialog } from "@/components/market/news-viewer-dialog"
import { TaskWatchList } from "@/components/ai-market/task-watch-list"
import { TaskInfoPanel } from "@/components/ai-market/task-info-panel"
import { TaskRecordsPanel } from "@/components/ai-market/task-records-panel"
import { TaskProfitPanel } from "@/components/ai-market/task-profit-panel"
import { useAiMarketStore } from "@/stores/ai-market"
import { useAiMarketIndicatorStore } from "@/stores/ai-market-indicator"
import { useAppStore, migrateStaleContract } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import {ForecastKline} from '@/components/ai-trading/forecast-chart'
import {isForecast} from '@/lib/ai-forecast'

/**
 * AI 看盘行情 —— 行情页的任务化变体
 *
 * 左：任务列表（AI任务/量化任务两组，选中驱动全局合约）
 * 中：K线/技术指标 + 任务交易标记 + 挂单/持仓价格线（与行情页一致，
 *     含任务持仓成本线）；底部为「任务总收益」柱面板
 * 右：上任务详情（含买卖价），下任务记录（交易/分析/运行日志三 Tab）
 */
export default function AiMarketPage(): React.JSX.Element {
  const marks = useAiMarketStore((s) => s.marks)
  const tasks = useAiMarketStore((s) => s.tasks)
  const selectedTaskId = useAiMarketStore((s) => s.selectedTaskId)
  const forecastTask=tasks.find(t=>t.id===selectedTaskId&&isForecast(t))

  // 页面合约隔离：行情页切过合约后回到本页时，重新断言本页选中任务
  // 对应的合约（任务选择本身已持久化于 ai-market-selected-task）。
  // 任务 symbol 若为出厂默认/已下市（过期合约）→ 迁移到品种主力
  useEffect(() => {
    if (!selectedTaskId) return
    const task = tasks.find((t) => t.id === selectedTaskId)
    if (task) {
      const tree = useMarketStore.getState().codeTree
      useAppStore
        .getState()
        .setActiveContract(migrateStaleContract(task.symbol, tree))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左栏：任务列表 */}
      <div className="w-[200px] shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)]">
        <TaskWatchList />
      </div>

      {/* 中栏：新闻滚动条 + K线（含任务交易标记） + 任务总收益 */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        <NewsTicker />

        <div className="flex-1 min-h-0">
          {forecastTask?<ForecastKline task={forecastTask}/>:<KlineChart
            forecastTasks={tasks}
            tradeMarks={marks}
            userTradeLines="all"
            indicatorStore={useAiMarketIndicatorStore}
          />}
        </div>

        <div className="h-[240px] shrink-0 border-t border-[var(--border)]">
          <Tabs defaultValue="profit" className="flex h-full flex-col">
            <TabsList className="mx-2 mt-1 shrink-0">
              <TabsTrigger value="profit" className="text-xs">
                任务总收益
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="profit"
              className="mt-0 min-h-0 flex-1 overflow-hidden"
            >
              <TaskProfitPanel />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* 右栏：任务详情在上（含买卖价），任务记录在下 */}
      <aside className="hidden w-[296px] shrink-0 flex-col border-l border-[var(--border)] xl:flex">
        <div className="h-[360px] shrink-0 border-b border-[var(--border)]">
          <TaskInfoPanel />
        </div>
        <div className="min-h-0 flex-1">
          <TaskRecordsPanel />
        </div>
      </aside>

      <NewsViewerDialog />
    </div>
  )
}
