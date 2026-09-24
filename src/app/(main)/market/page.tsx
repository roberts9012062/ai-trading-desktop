"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ContractList } from "@/components/market/contract-list"
import {
  KlineWorkspace,
  type KlineSplitMode,
} from "@/components/market/kline-workspace"
import { TradeDetails } from "@/components/market/trade-details"
import { OrderPanel } from "@/components/trading/order-form"
import { OrderList } from "@/components/trading/order-list"
import { PositionDetailTable } from "@/components/trading/position-list"
import { NewsTicker } from "@/components/market/news-ticker"
import { ContractNews } from "@/components/market/contract-news"
import { NewsViewerDialog } from "@/components/market/news-viewer-dialog"
import { useAppStore, writeMarketViewContract } from "@/stores/app"
import { broadcastContractChange } from "@/hooks/sync"
import { MarketDepthPanel } from "@/components/market/market-depth-panel"
import { MarketDepthDialog } from "@/components/market/market-depth-dialog"
import { AiAnchorPanel } from "@/components/market/ai-anchor/ai-anchor-panel"
import { cn } from "@/lib/utils"

/** 布局偏好持久化 key（分屏数 + 右栏收起状态 + 右栏 tab；全屏不持久化） */
const LAYOUT_PREF_KEY = "qihuo-market-layout"

function isSplitMode(v: unknown): v is KlineSplitMode {
  return v === 1 || v === 2 || v === 3 || v === 4
}

function isRightTab(v: unknown): v is "market" | "trade" | "anchor" {
  return v === "market" || v === "trade" || v === "anchor"
}

/** 读取布局偏好（SSR 安全：仅客户端调用，异常/缺失回退默认） */
function loadLayoutPref(): {
  split: KlineSplitMode
  rightCollapsed: boolean
  rightTab: "market" | "trade" | "anchor"
} {
  if (typeof window === "undefined")
    return { split: 1, rightCollapsed: false, rightTab: "market" }
  try {
    const raw = localStorage.getItem(LAYOUT_PREF_KEY)
    if (!raw) return { split: 1, rightCollapsed: false, rightTab: "market" }
    const pref = JSON.parse(raw) as Record<string, unknown>
    return {
      split: isSplitMode(pref.split) ? pref.split : 1,
      rightCollapsed: pref.rightCollapsed === true,
      rightTab: isRightTab(pref.rightTab) ? pref.rightTab : "market",
    }
  } catch {
    return { split: 1, rightCollapsed: false, rightTab: "market" }
  }
}

/** 读取 URL ?symbol= 并切换全局活跃合约 */
function SymbolFromQuery(): null {
  const searchParams = useSearchParams()
  const setActiveContract = useAppStore((s) => s.setActiveContract)

  useEffect(() => {
    const symbol = searchParams.get("symbol")?.trim()
    if (!symbol) return
    setActiveContract(symbol)
    // 深链优先于行情页合约记忆：同步写记忆并广播，
    // 否则 ContractList 挂载恢复时会把旧记忆合约覆盖回来（筛选页跳转定位失效）
    writeMarketViewContract(symbol)
    broadcastContractChange(symbol)
  }, [searchParams, setActiveContract])

  return null
}

/** 行情中心 —— 左合约 / 中 K线工作区（分屏+全屏）与底部持仓委托/新闻；右盘口+成交+交易下单 */
export default function MarketPage(): React.JSX.Element {
  const activeContract = useAppStore((s) => s.activeContract)
  // 行情页自己的合约记忆：本页挂载期间的合约变化（本页点击/URL 深链）
  // 都记到专属 key；AI 看盘等页面切合约时本页未挂载，不会写进来。
  // 首次渲染跳过——避免把别的页面留下的全局值误存为行情页记忆。
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    writeMarketViewContract(activeContract)
  }, [activeContract])

  // K 线工作区状态：分屏数 / 全屏 / 右栏收起 / 右栏 tab（布局偏好持久化，全屏不持久化）
  const [splitMode, setSplitMode] = useState<KlineSplitMode>(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [rightTab, setRightTab] = useState<"market" | "trade" | "anchor">("market")
  // 最新布局镜像 + 回调内保存：避免挂载恢复首帧用默认值回写偏好
  const layoutRef = useRef<{
    split: KlineSplitMode
    rightCollapsed: boolean
    rightTab: "market" | "trade" | "anchor"
  }>({
    split: 1,
    rightCollapsed: false,
    rightTab: "market",
  })

  const persistLayout = useCallback(
    (patch: Partial<{ split: KlineSplitMode; rightCollapsed: boolean; rightTab: "market" | "trade" | "anchor" }>) => {
      const next = { ...layoutRef.current, ...patch }
      layoutRef.current = next
      try {
        localStorage.setItem(LAYOUT_PREF_KEY, JSON.stringify(next))
      } catch {
        // localStorage 不可用时静默忽略
      }
    },
    [],
  )

  // 挂载后恢复布局偏好（避免 SSR 水合不一致：首帧一律默认值）
  useEffect(() => {
    const pref = loadLayoutPref()
    layoutRef.current = pref
    setSplitMode(pref.split)
    setRightCollapsed(pref.rightCollapsed)
    setRightTab(pref.rightTab)
  }, [])

  // 全屏时 ESC 退出（弹窗/下拉打开时让给它们先关闭，不重复退全屏）
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (document.querySelector('[data-state="open"]')) return
      setFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen])

  const toggleFullscreen = useCallback(() => {
    setFullscreen((v) => !v)
  }, [])
  const changeSplit = useCallback(
    (split: KlineSplitMode) => {
      setSplitMode(split)
      persistLayout({ split })
    },
    [persistLayout],
  )
  const toggleRightPanel = useCallback(() => {
    setRightCollapsed((v) => {
      const next = !v
      persistLayout({ rightCollapsed: next })
      return next
    })
  }, [persistLayout])
  const changeRightTab = useCallback(
    (tab: "market" | "trade" | "anchor") => {
      setRightTab(tab)
      persistLayout({ rightTab: tab })
    },
    [persistLayout],
  )

  return (
    <div className="flex h-full overflow-hidden">
      <Suspense fallback={null}>
        <SymbolFromQuery />
      </Suspense>

      <div className="w-[200px] shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)]">
        <ContractList />
      </div>

      <div className="flex-1 flex flex-col min-w-0 relative">
        <NewsTicker />

        {/* 全屏时该容器提升为 fixed 覆盖层盖住整页（z-[45]：低于弹窗 z-50，高于其余）。
            底部大单/新闻等保持挂载，仅被覆盖，退出全屏零恢复成本。 */}
        <div
          className={cn(
            "flex-1 min-h-0",
            fullscreen &&
              "fixed inset-0 z-[45] bg-[var(--bg-primary)]",
          )}
        >
          <KlineWorkspace
            splitMode={splitMode}
            onSplitModeChange={changeSplit}
            fullscreen={fullscreen}
            onToggleFullscreen={toggleFullscreen}
            rightPanelCollapsed={rightCollapsed}
            onToggleRightPanel={toggleRightPanel}
          />
        </div>

        <div className="h-[240px] shrink-0 border-t border-[var(--border)]">
          <Tabs defaultValue="trade" className="flex h-full flex-col">
            <TabsList className="mx-2 mt-1 shrink-0">
              <TabsTrigger value="trade" className="text-xs">
                持仓/委托
              </TabsTrigger>
              <TabsTrigger value="news" className="text-xs">
                新闻
              </TabsTrigger>
            </TabsList>
            <TabsContent value="trade" className="mt-0 min-h-0 flex-1 overflow-hidden">
              <Tabs defaultValue="orders" className="flex h-full flex-col">
                <TabsList className="mx-2 mt-0.5 shrink-0">
                  <TabsTrigger value="orders" className="text-xs">
                    委托
                  </TabsTrigger>
                  <TabsTrigger value="positions" className="text-xs">
                    持仓
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="orders" className="mt-0 min-h-0 overflow-auto max-h-[176px]">
                  <OrderList />
                </TabsContent>
                <TabsContent value="positions" className="mt-0 min-h-0 overflow-auto max-h-[176px]">
                  <PositionDetailTable />
                </TabsContent>
              </Tabs>
            </TabsContent>
            <TabsContent value="news" className="mt-0 min-h-0 flex-1 overflow-hidden">
              <ContractNews />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* 右栏：tab 切换「行情」（盘口+成交）与「AI主播」；可收起（K 线工具条按钮切换） */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-l border-[var(--border)] transition-[width] duration-150 xl:flex",
          rightCollapsed ? "w-0 overflow-hidden border-l-0" : "w-[296px]",
        )}
      >
        <Tabs
          value={rightTab}
          onValueChange={(v) => changeRightTab(isRightTab(v) ? v : "market")}
          className="flex h-full flex-col"
        >
          <TabsList className="mx-2 mt-1 shrink-0">
            <TabsTrigger value="market" className="text-xs">
              行情
            </TabsTrigger>
            <TabsTrigger value="trade" className="text-xs">
              交易
            </TabsTrigger>
            <TabsTrigger value="anchor" className="text-xs">
              AI主播
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="market"
            className="mt-0 min-h-0 flex-1 flex flex-col overflow-hidden"
          >
            <div className="h-[360px] shrink-0 border-b border-[var(--border)]">
              <MarketDepthPanel />
            </div>
            <div className="min-h-0 flex-1">
              <TradeDetails listClassName="max-h-none h-full" />
            </div>
          </TabsContent>
          <TabsContent
            value="trade"
            className="mt-0 min-h-0 flex-1 overflow-y-auto"
          >
            <OrderPanel />
          </TabsContent>
          <TabsContent
            value="anchor"
            className="mt-0 min-h-0 flex-1 overflow-hidden"
          >
            <AiAnchorPanel />
          </TabsContent>
        </Tabs>
      </aside>
      <MarketDepthDialog className="fixed bottom-4 right-4 z-40 xl:hidden" />

      <NewsViewerDialog />
    </div>
  )
}
