"use client"

import { useEffect, useState } from "react"
import { TopNavbar } from "@/components/layout/top-navbar"
import { Sidebar } from "@/components/layout/sidebar"
import { ContractSearchDialog } from "@/components/market/contract-search-dialog"
import { FloatingAssistant } from "@/components/ai/floating-assistant"
import { AnnouncementPopup } from "@/components/notifications/announcement-popup"
import { MessagePopup } from "@/components/notifications/message-popup"
import { BigOrderToastPopup } from "@/components/notifications/big-order-toast"
import { startVoiceBroadcastEngine } from "@/lib/voice-broadcast-engine"
import { TaskAlertToastPopup } from "@/components/notifications/task-alert-toast"
import { GlobalDialog } from "@/components/global-dialog"
import { HunterRuntime } from "@/components/hunter/runtime"
import { LiveTradingRuntime } from '@/components/trading/live-trading-runtime'
import { useKeyboardShortcuts } from "@/hooks/keyboard"
import { useTabSync } from "@/hooks/sync"
import { useAuthGuard } from "@/hooks/auth"
import { getNotifySettingsApi } from "@/lib/api"
import { setNotifySoundSettings } from "@/lib/sound"
import { setSpeechSettings } from "@/lib/speech"
import { ensureContractNames } from "@/lib/contract-names"
import { useNotificationsStore } from "@/stores/notifications"
import { useBigOrderStore } from "@/stores/big-order"
import { useTaskAlertStore } from "@/stores/task-alert"
import { useAuthStore } from "@/stores/auth"
import { useMarketStore } from "@/stores/market"
import { useAppStore, migrateStaleContract, readActiveContract } from "@/stores/app"
import { broadcastContractChange } from "@/hooks/sync"

/** 用户端布局 Shell（顶部导航 + 侧边栏 + 主内容区） */
export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // 拉取通知设置 → 初始化提示音开关；同时拉未读数；加载大单预警/任务预警设置
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [s] = await Promise.all([
          getNotifySettingsApi(),
          useNotificationsStore.getState().fetchUnread(),
          useBigOrderStore.getState().loadFromServer(),
          useTaskAlertStore.getState().loadFromServer(),
          ensureContractNames(),
        ])
        if (!cancelled) {
          setNotifySoundSettings({ notify_sound_enabled: s.notify_sound_enabled })
          setSpeechSettings({
            voice_enabled: useBigOrderStore.getState().settings.voice_enabled,
          })
        }
      } catch {
        // 未登录或失败静默：保持默认开启
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 大单设置变化时同步语音开关到 speech 模块
  const voiceEnabled = useBigOrderStore((s) => s.settings.voice_enabled)
  useEffect(() => {
    setSpeechSettings({ voice_enabled: voiceEnabled })
  }, [voiceEnabled])

  // 语音播报引擎：全局常驻（整分对齐调度 + 排队播报），设置见个人中心
  useEffect(() => {
    startVoiceBroadcastEngine()
  }, [])

  useKeyboardShortcuts()
  useTabSync()
  useAuthGuard()

  // 全局行情连接：登录拿到 token 后接入 /ws/market，让持仓、历史、订单等
  // 所有子页都能拿到实时现价（浮动盈亏由前端用 last_price 客户端计算）。
  // initWebSocket 幂等，token 缺失时 connect() 会跳过，登录后再次触发即建连。
  const accessToken = useAuthStore((s) => s.accessToken)
  const initWebSocket = useMarketStore((s) => s.initWebSocket)
  useEffect(() => {
    if (accessToken) initWebSocket()
  }, [accessToken, initWebSocket])

  // 全局合约记忆恢复 + 过期迁移：持久化此前只写不读，刷新即落回出厂默认
  // rb2610（主力换月后即「过期合约」）。恢复记忆后与合约树比对：出厂
  // 默认/已下市 → 品种主力；用户主动选择的有效合约（次主力/远月）保留。
  useEffect(() => {
    const saved = readActiveContract()
    if (saved) useAppStore.getState().setActiveContract(saved)
    void useMarketStore.getState().fetchCodeTree().then(() => {
      const tree = useMarketStore.getState().codeTree
      const current = useAppStore.getState().activeContract
      const migrated = migrateStaleContract(current, tree)
      if (migrated !== current) {
        useAppStore.getState().setActiveContract(migrated)
        broadcastContractChange(migrated)
      }
    })
  }, [])

  if (!mounted) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-[var(--bg-primary)]">
        <div className="h-[56px] border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0" />
        <div className="flex flex-1 overflow-hidden">
          <aside className="w-[192px] border-r border-[var(--border)] bg-[var(--bg-secondary)]" />
          <main className="flex-1 overflow-auto" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[var(--bg-primary)]">
      <TopNavbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
      <ContractSearchDialog />
      {/* 全局 AI 交易助手：浮空按钮 / 可缩放浮窗 */}
      <FloatingAssistant />
      {/* 消息弹窗：右下角，WS 推送新消息时滑入 */}
      <MessagePopup />
      <AnnouncementPopup />
      {/* 大单预警弹窗：右下角堆叠，命中阈值时显示 10 秒（不入库） */}
      <BigOrderToastPopup />
      {/* 任务预警弹窗：任务下单/平仓成交时滑入（不入库） */}
      <TaskAlertToastPopup />
      {/* 全局美化弹窗：showAlert / showConfirm 的渲染器 */}
      <GlobalDialog />
      <HunterRuntime />
      <LiveTradingRuntime />
    </div>
  )
}
