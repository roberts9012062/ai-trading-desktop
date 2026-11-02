/**
 * 路由表 —— 由 Next App Router 目录机械映射而来:
 * - 桌面端无宣传落地页:/ 与未匹配路径一律重定向到 /login
 * - app/(auth)/login/page.tsx        → /login
 * - app/(main)/layout.tsx + page     → 嵌套路由,布局作为父 Route(以 <Outlet/> 为 children)
 * - app/admin/layout.tsx + page      → 同上,/admin 无索引页,重定向到 /admin/dashboard
 * - app/api/**(Route Handler)       → 不迁移:桌面端直连后端,dev 由 vite proxy 承担长超时代理
 * - app/page.tsx + components/landing/ + lib/showcase-api.ts → 已删除(Web 端宣传页,桌面端不需要)
 */
import { Navigate, Outlet, Route, Routes } from "react-router-dom"
import { lazy, Suspense, useSyncExternalStore } from 'react'
import { useAuthStore } from "@/stores/auth"
import { desktopLoginRequired, onDesktopLoginChange } from '@/lib/desktop-login-session'
import { DesktopSessionGate } from '@/components/common/desktop-session-gate'
import LoginPage from "./app/(auth)/login/page"
const RegisterPage = lazy(() => import("./app/(auth)/register/page"))

const MainLayout = lazy(() => import("./app/(main)/layout"))
const AiMarketPage = lazy(() => import("./app/(main)/ai-market/page"))
const AiSettingsPage = lazy(() => import("./app/(main)/ai-settings/page"))
const AiTradingPage = lazy(() => import("./app/(main)/ai-trading/page"))
const AssetsPage = lazy(() => import("./app/(main)/assets/page"))
const BacktestPage = lazy(() => import("./app/(main)/backtest/page"))
const DashboardPage = lazy(() => import("./app/(main)/dashboard/page"))
const FactorLabPage = lazy(() => import("./app/(main)/factor-lab/page"))
const ShortlineLabPage = lazy(() => import("./app/(main)/factor-lab/shortline/page"))
const FactorEvolutionPage = lazy(() => import("./app/(main)/factor-lab/evolution/page"))
const HistoryPage = lazy(() => import("./app/(main)/history/page"))
const MallPage = lazy(() => import("./app/(main)/mall/page"))
const MarketPage = lazy(() => import("./app/(main)/market/page"))
const MarketScreenerPage = lazy(() => import("./app/(main)/market/screener/page"))
const MessagesPage = lazy(() => import("./app/(main)/messages/page"))
const OrdersPage = lazy(() => import("./app/(main)/orders/page"))
const PositionsPage = lazy(() => import("./app/(main)/positions/page"))
const ProfilePage = lazy(() => import("./app/(main)/profile/page"))
const ManualPage = lazy(() => import("./app/(main)/manual/page"))
const StrategyFavoritesPage = lazy(() => import("./app/(main)/strategy-favorites/page"))
const TradingPage = lazy(() => import("./app/(main)/trading/page"))

const AdminLayout = lazy(() => import("./app/admin/layout"))
const AdminAiPage = lazy(() => import("./app/admin/ai/page"))
const AdminApiKeysPage = lazy(() => import("./app/admin/api-keys/page"))
const AdminChannelsPage = lazy(() => import("./app/admin/channels/page"))
const AdminDashboardPage = lazy(() => import("./app/admin/dashboard/page"))
const AdminFinancePage = lazy(() => import("./app/admin/finance/page"))
const AdminRefreshIntervalPage = lazy(() => import("./app/admin/refresh-interval/page"))
const AdminRiskControlPage = lazy(() => import("./app/admin/risk-control/page"))
const AdminSettingsPage = lazy(() => import("./app/admin/settings/page"))
const AdminTradingConfigPage = lazy(() => import("./app/admin/trading-config/page"))
const AdminUsersPage = lazy(() => import("./app/admin/users/page"))
const AdminVipPage = lazy(() => import("./app/admin/vip/page"))
const AdminAnnouncementsPage = lazy(() => import("./app/admin/announcements/page"))
const AdminDonationsPage = lazy(() => import("./app/admin/donations/page"))
const AdminUserDetailPage = lazy(() => import("./app/admin/users/[id]/page"))

/** Saved credentials alone never skip this application's startup login. */
function RootRedirect(): React.JSX.Element {
  const token = useAuthStore(state => state.accessToken)
  const required = useSyncExternalStore(onDesktopLoginChange, desktopLoginRequired, () => true)
  return <Navigate to={!required && token ? "/dashboard" : "/login"} replace />
}

export function AppRoutes() {
  return (
    <Suspense fallback={<div role="status" className="p-6 text-sm text-[var(--text-muted)]">页面加载中…</div>}><Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route element={<DesktopSessionGate><MainLayout><Outlet /></MainLayout></DesktopSessionGate>}>
        <Route path="/ai-market" element={<AiMarketPage />} />
        <Route path="/ai-market/volume-profile" element={<Navigate to="/ai-market" replace />} />
        <Route path="/ai-settings" element={<AiSettingsPage />} />
        <Route path="/ai-trading" element={<AiTradingPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/backtest" element={<BacktestPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/factor-lab" element={<FactorLabPage />} />
        <Route path="/factor-lab/shortline" element={<ShortlineLabPage />} />
        <Route path="/factor-lab/evolution" element={<FactorEvolutionPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/mall" element={<MallPage />} />
        <Route path="/market" element={<MarketPage />} />
        <Route path="/market/screener" element={<MarketScreenerPage />} />
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/positions" element={<PositionsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/manual" element={<ManualPage />} />
        <Route path="/strategy-favorites" element={<StrategyFavoritesPage />} />
        <Route path="/trading" element={<TradingPage />} />
      </Route>

      <Route path="/admin" element={<DesktopSessionGate><AdminLayout><Outlet /></AdminLayout></DesktopSessionGate>}>
        <Route index element={<Navigate to="/admin/dashboard" replace />} />
        <Route path="ai" element={<AdminAiPage />} />
        <Route path="api-keys" element={<AdminApiKeysPage />} />
        <Route path="channels" element={<AdminChannelsPage />} />
        <Route path="dashboard" element={<AdminDashboardPage />} />
        <Route path="finance" element={<AdminFinancePage />} />
        <Route path="refresh-interval" element={<AdminRefreshIntervalPage />} />
        <Route path="risk-control" element={<AdminRiskControlPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="trading-config" element={<AdminTradingConfigPage />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="vip" element={<AdminVipPage />} />
        <Route path="donations" element={<AdminDonationsPage />} />
        <Route path="announcements" element={<AdminAnnouncementsPage />} />
        <Route path="users/:id" element={<AdminUserDetailPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes></Suspense>
  )
}
