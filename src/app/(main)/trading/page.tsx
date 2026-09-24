"use client"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { KlineChart } from "@/components/market/kline-chart"
import { OrderPanel } from "@/components/trading/order-form"
import { OrderList } from "@/components/trading/order-list"
import { PositionDetailTable } from "@/components/trading/position-list"
import { PositionContractList } from "@/components/trading/position-contract-list"
import { TradingHeader } from "@/components/trading/trading-header"
import { MarketDepthPanel } from "@/components/market/market-depth-panel"
import { MarketDepthDialog } from "@/components/market/market-depth-dialog"
import { TradeDetails } from "@/components/market/trade-details"
import { useAppStore } from "@/stores/app"

/**
 * 交易面板 —— 专注下单
 *
 * 布局：顶栏合约信息 | 左侧 持仓合约（成交即入列，空仓为空状态） |
 * 中部 K 线+委托/持仓 | 右侧 盘口+成交+下单
 * 切换合约用左侧持仓列表、顶栏「切换合约」或 Ctrl+K。
 */
export default function TradingPage(): React.JSX.Element {
  const selectLimitPrice = useAppStore((s) => s.selectLimitPrice)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <TradingHeader />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* 左侧：持仓合约列表（买单成交后出现；无持仓为空状态） */}
        <div className="w-[200px] shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)] hidden lg:block">
          <PositionContractList />
        </div>

        {/* 主区：K线 + 委托/持仓 */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0">
            <KlineChart />
          </div>

          <div className="h-[220px] shrink-0 border-t border-[var(--border)]">
            <Tabs defaultValue="orders">
              <TabsList className="mx-2 mt-1">
                <TabsTrigger value="orders" className="text-xs">
                  委托
                </TabsTrigger>
                <TabsTrigger value="positions" className="text-xs">
                  持仓
                </TabsTrigger>
              </TabsList>
              <TabsContent
                value="orders"
                className="mt-0 overflow-auto max-h-[180px]"
              >
                <OrderList />
              </TabsContent>
              <TabsContent
                value="positions"
                className="mt-0 overflow-auto max-h-[180px]"
              >
                <PositionDetailTable />
              </TabsContent>
            </Tabs>
          </div>
        </div>

        {/* 右侧：盘口 + 成交 + 下单 */}
        <div className="flex w-[280px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-secondary)] xl:w-[320px]">
          <div className="hidden h-[300px] shrink-0 border-b border-[var(--border)] xl:block">
            <MarketDepthPanel onPriceSelect={selectLimitPrice} />
          </div>
          <div className="hidden h-[180px] shrink-0 border-b border-[var(--border)] xl:block">
            <TradeDetails listClassName="max-h-[140px]" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <OrderPanel />
          </div>
        </div>
        <MarketDepthDialog
          className="fixed bottom-4 right-[296px] z-40 xl:hidden"
          onPriceSelect={selectLimitPrice}
        />
      </div>
    </div>
  )
}
