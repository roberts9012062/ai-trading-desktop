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

import LoginPage from "./app/(auth)/login/page"
import RegisterPage from "./app/(auth)/register/page"

import MainLayout from "./app/(main)/layout"
import AiMarketPage from "./app/(main)/ai-market/page"
import VolumeProfilePage from "./app/(main)/ai-market/volume-profile/page"
import AiSettingsPage from "./app/(main)/ai-settings/page"
import AiTradingPage from "./app/(main)/ai-trading/page"
import AiSkillsPage from "./app/(main)/ai/skills/page"
import AiSkillsInstalledPage from "./app/(main)/ai/skills/installed/page"
import AssetsPage from "./app/(main)/assets/page"
import BacktestPage from "./app/(main)/backtest/page"
import DashboardPage from "./app/(main)/dashboard/page"
import FactorLabPage from "./app/(main)/factor-lab/page"
import HistoryPage from "./app/(main)/history/page"
import MarketPage from "./app/(main)/market/page"
import MarketScreenerPage from "./app/(main)/market/screener/page"
import MessagesPage from "./app/(main)/messages/page"
import OrdersPage from "./app/(main)/orders/page"
import PositionsPage from "./app/(main)/positions/page"
import ProfilePage from "./app/(main)/profile/page"
import StrategyFavoritesPage from "./app/(main)/strategy-favorites/page"
import TradingPage from "./app/(main)/trading/page"

import AdminLayout from "./app/admin/layout"
import AdminAiPage from "./app/admin/ai/page"
import AdminApiKeysPage from "./app/admin/api-keys/page"
import AdminChannelsPage from "./app/admin/channels/page"
import AdminContractsPage from "./app/admin/contracts/page"
import AdminDashboardPage from "./app/admin/dashboard/page"
import AdminFinancePage from "./app/admin/finance/page"
import AdminLogsPage from "./app/admin/logs/page"
import AdminRefreshIntervalPage from "./app/admin/refresh-interval/page"
import AdminRiskControlPage from "./app/admin/risk-control/page"
import AdminSettingsPage from "./app/admin/settings/page"
import AdminTradingConfigPage from "./app/admin/trading-config/page"
import AdminUsersPage from "./app/admin/users/page"
import AdminUserDetailPage from "./app/admin/users/[id]/page"
import AdminVvtrPage from "./app/admin/vvtr/page"
import AdminKlineTasksPage from "./app/admin/kline-tasks/page"

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route element={<MainLayout><Outlet /></MainLayout>}>
        <Route path="/ai-market" element={<AiMarketPage />} />
        <Route path="/ai-market/volume-profile" element={<VolumeProfilePage />} />
        <Route path="/ai-settings" element={<AiSettingsPage />} />
        <Route path="/ai-trading" element={<AiTradingPage />} />
        <Route path="/ai/skills" element={<AiSkillsPage />} />
        <Route path="/ai/skills/installed" element={<AiSkillsInstalledPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/backtest" element={<BacktestPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/factor-lab" element={<FactorLabPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/market" element={<MarketPage />} />
        <Route path="/market/screener" element={<MarketScreenerPage />} />
        <Route path="/messages" element={<MessagesPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/positions" element={<PositionsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/strategy-favorites" element={<StrategyFavoritesPage />} />
        <Route path="/trading" element={<TradingPage />} />
      </Route>

      <Route path="/admin" element={<AdminLayout><Outlet /></AdminLayout>}>
        <Route index element={<Navigate to="/admin/dashboard" replace />} />
        <Route path="ai" element={<AdminAiPage />} />
        <Route path="api-keys" element={<AdminApiKeysPage />} />
        <Route path="channels" element={<AdminChannelsPage />} />
        <Route path="contracts" element={<AdminContractsPage />} />
        <Route path="dashboard" element={<AdminDashboardPage />} />
        <Route path="finance" element={<AdminFinancePage />} />
        <Route path="logs" element={<AdminLogsPage />} />
        <Route path="refresh-interval" element={<AdminRefreshIntervalPage />} />
        <Route path="risk-control" element={<AdminRiskControlPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="trading-config" element={<AdminTradingConfigPage />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="users/:id" element={<AdminUserDetailPage />} />
        <Route path="vvtr" element={<AdminVvtrPage />} />
        <Route path="kline-tasks" element={<AdminKlineTasksPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}
