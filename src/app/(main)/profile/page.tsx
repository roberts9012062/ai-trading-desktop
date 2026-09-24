"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { User, Shield, Sliders, Bell, Wallet, Edit3, Type, Volume2 } from "lucide-react"
import { VirtualFundsPanel } from "@/components/portfolio/virtual-funds-panel"
import { TradeSettingsPanel } from "@/components/portfolio/trade-settings-panel"
import { SecurityPanel } from "@/components/profile/security-panel"
import { AlertSettingsPanel } from "@/components/profile/alert-settings-panel"
import { DisplaySettingsPanel } from "@/components/profile/display-settings-panel"
import { VoiceBroadcastPanel } from "@/components/profile/voice-broadcast-panel"

/** 个人中心页面 —— 左右分栏 + Tab 切换 */
export default function ProfilePage(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState("info")

  return (
    <div className="flex h-full overflow-auto">
      {/* 左侧 Tab 导航 */}
      <div className="w-[180px] shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-1">
        <p className="text-xs text-[var(--text-muted)] mb-3 px-2">个人中心</p>
        {[
          { value: "info", icon: User, label: "个人信息" },
          { value: "display", icon: Type, label: "显示设置" },
          { value: "funds", icon: Wallet, label: "虚拟资金" },
          { value: "security", icon: Shield, label: "安全设置" },
          { value: "trading", icon: Sliders, label: "交易设置" },
          { value: "alerts", icon: Bell, label: "提醒设置" },
          { value: "voice", icon: Volume2, label: "语音播报" },
        ].map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer",
              activeTab === tab.value
                ? "bg-[var(--primary)]/20 text-[var(--primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* 右侧内容 */}
      <div className="flex-1 p-6 overflow-auto">
        {activeTab === "info" && <PersonalInfoPanel />}
        {activeTab === "display" && <DisplaySettingsPanel />}
        {activeTab === "funds" && <VirtualFundsPanel />}
        {activeTab === "security" && <SecurityPanel />}
        {activeTab === "trading" && <TradeSettingsPanel />}
        {activeTab === "alerts" && <AlertSettingsPanel />}
        {activeTab === "voice" && <VoiceBroadcastPanel />}
      </div>
    </div>
  )
}

/** 个人信息面板 */
function PersonalInfoPanel(): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [username, setUsername] = useState("quant_trader_01")
  const [email, setEmail] = useState("trader@example.com")

  return (
    <div className="max-w-xl space-y-6">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">个人信息</h2>

      {/* 头像 */}
      <Card>
        <CardContent className="flex items-center gap-4 p-4">
          <div className="w-16 h-16 rounded-full bg-[var(--primary)] flex items-center justify-center text-white text-xl font-bold shrink-0">
            Q
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-[var(--text-primary)]">{username}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">ID: USR20250101</p>
          </div>
          <Button variant="outline" size="sm">更换头像</Button>
        </CardContent>
      </Card>

      {/* 信息编辑 */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-[var(--text-primary)]">基本信息</p>
            <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)} className="gap-1">
              <Edit3 className="w-3.5 h-3.5" />
              {editing ? "取消" : "编辑"}
            </Button>
          </div>
          <Separator />

          <InfoField label="用户名" value={username} editing={editing} onChange={setUsername} />
          <InfoField label="手机号" value="138****8888" editing={false} />
          <InfoField label="邮箱" value={email} editing={editing} onChange={setEmail} />

          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-[var(--text-secondary)]">实名认证</span>
            <Badge variant="up">已认证</Badge>
          </div>

          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-[var(--text-secondary)]">注册时间</span>
            <span className="text-sm font-num text-[var(--text-muted)]">2025-01-15 10:30:00</span>
          </div>

          {editing && (
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>取消</Button>
              <Button size="sm" onClick={() => setEditing(false)}>保存</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}


/** 信息展示/编辑字段 */
function InfoField(props: { label: string; value: string; editing: boolean; onChange?: (v: string) => void }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-[var(--text-secondary)]">{props.label}</span>
      {props.editing && props.onChange ? (
        <Input value={props.value} onChange={(e) => props.onChange!(e.target.value)} className="h-7 text-sm w-56" />
      ) : (
        <span className="text-sm font-num text-[var(--text-primary)]">{props.value}</span>
      )}
    </div>
  )
}

/** 开关行组件 */
function ToggleRow(props: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm text-[var(--text-secondary)]">{props.label}</p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">{props.description}</p>
      </div>
      <button
        onClick={() => props.onChange(!props.checked)}
        className={cn(
          "w-8 h-4 rounded-full transition-colors relative cursor-pointer",
          props.checked ? "bg-[var(--primary)]" : "bg-[var(--bg-tertiary)]"
        )}
      >
        <span className={cn(
          "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform",
          props.checked ? "left-[18px]" : "left-0.5"
        )} />
      </button>
    </div>
  )
}
