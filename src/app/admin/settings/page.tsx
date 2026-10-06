"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  getAdminSettingsApi,
  updateAdminSettingsApi,
  type SystemSettings,
} from "@/lib/admin-api"

const DEFAULT_SETTINGS: SystemSettings = {
  registration_enabled: true,
  daily_register_limit: 100,
  register_reset_hour: 6,
  system_name: "期货交易模拟系统",
  kline_source_mode: false,
  kline_primary_source: "eastmoney",
  kline_sync_enabled: true,
  max_tasks_per_user: 5,
  factor_lab_daily_limit: 3,
  backtest_daily_limit: 2,
  mall_closed: false,
  free_max_tasks: 1,
  market_refresh_interval_sec: 1,
  market_refresh_intervals: {},
  updated_at: null,
}

/** 系统设置 —— 注册策略、商城与用量配额 */
export default function AdminSettingsPage(): React.JSX.Element {
  const [form, setForm] = useState<SystemSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [mallSwitchBusy, setMallSwitchBusy] = useState(false)
  const [mallSwitchMessage, setMallSwitchMessage] = useState("")

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const s = await getAdminSettingsApi()
        if (!cancelled) setForm(s)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载设置失败")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  function updateField<K extends keyof SystemSettings>(
    key: K,
    value: SystemSettings[K],
  ): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /** 商城开关：点击立即生效（单独保存，不依赖「保存设置」按钮） */
  async function toggleMallClosed(): Promise<void> {
    const next = !form.mall_closed
    setMallSwitchBusy(true)
    setMallSwitchMessage("")
    setError("")
    try {
      const saved = await updateAdminSettingsApi({ mall_closed: next })
      setForm(saved)
      setMallSwitchMessage(
        next ? "已开启商城（VIP 付费模式）" : "已关闭商城——全部 VIP 功能免费开放",
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "商城开关保存失败")
    } finally {
      setMallSwitchBusy(false)
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    setMessage("")
    setError("")
    try {
      const saved = await updateAdminSettingsApi({
        registration_enabled: form.registration_enabled,
        daily_register_limit: Number(form.daily_register_limit),
        register_reset_hour: Number(form.register_reset_hour),
        system_name: form.system_name,
        max_tasks_per_user: Number(form.max_tasks_per_user),
        factor_lab_daily_limit: Number(form.factor_lab_daily_limit),
        backtest_daily_limit: Number(form.backtest_daily_limit),
        mall_closed: Boolean(form.mall_closed),
        free_max_tasks: Number(form.free_max_tasks ?? 1),
      })
      setForm(saved)
      setMessage("设置已保存")
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 text-sm text-[var(--text-muted)]">加载设置…</div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">
        系统设置
      </h1>

      {error && (
        <div className="px-4 py-2 rounded-md bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] text-sm">
          {error}
        </div>
      )}
      {message && (
        <div className="px-4 py-2 rounded-md bg-[var(--primary)]/15 text-[var(--primary)] text-sm">
          {message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>基础信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>系统名称</Label>
            <Input
              value={form.system_name}
              onChange={(e) => updateField("system_name", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>注册策略</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-md bg-[var(--bg-tertiary)]">
            <div>
              <p className="text-sm text-[var(--text-primary)]">开放注册</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                关闭后新用户无法自助注册，管理员仍可后台创建
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.registration_enabled}
              onClick={() =>
                updateField("registration_enabled", !form.registration_enabled)
              }
              className={`relative w-12 h-7 rounded-full transition-colors ${
                form.registration_enabled
                  ? "bg-[var(--primary)]"
                  : "bg-[var(--border)]"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white transition-transform ${
                  form.registration_enabled ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>每日注册人数上限</Label>
              <Input
                type="number"
                min={0}
                value={form.daily_register_limit}
                onChange={(e) =>
                  updateField(
                    "daily_register_limit",
                    Number(e.target.value || 0),
                  )
                }
              />
              <p className="text-xs text-[var(--text-muted)]">
                0 表示不限制人数
              </p>
            </div>
            <div className="space-y-2">
              <Label>注册计数重置时间（小时）</Label>
              <Input
                type="number"
                min={0}
                max={23}
                value={form.register_reset_hour}
                onChange={(e) =>
                  updateField(
                    "register_reset_hour",
                    Number(e.target.value || 0),
                  )
                }
              />
              <p className="text-xs text-[var(--text-muted)]">
                上海时区 0–23，默认 6（早 6 点重置）
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>商城 / VIP</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-md bg-[var(--bg-tertiary)]">
            <div>
              <p className="text-sm text-[var(--text-primary)]">开放商城（VIP 付费）</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                点击立即生效（无需保存）：关闭后全部 VIP 专属功能（AI 交易等）
                对所有用户免费开放，商城入口隐藏、无法购买；
                存量会员到期前仍不受免费配额限制
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!form.mall_closed}
              disabled={mallSwitchBusy}
              onClick={() => void toggleMallClosed()}
              className={`relative w-12 h-7 rounded-full transition-colors ${
                !form.mall_closed
                  ? "bg-[var(--primary)]"
                  : "bg-[var(--border)]"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white transition-transform ${
                  !form.mall_closed ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>
          {mallSwitchMessage && (
            <p className="text-xs text-[var(--accent-up)]">{mallSwitchMessage}</p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>普通用户免费任务数</Label>
              <Input
                type="number"
                min={0}
                value={form.free_max_tasks ?? 1}
                onChange={(e) =>
                  updateField("free_max_tasks", Number(e.target.value || 0))
                }
              />
              <p className="text-xs text-[var(--text-muted)]">
                无 VIP 用户可创建的 AI 任务数，默认 1；0 表示不限（改动后点下方「保存设置」）
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>用量配额（全局默认）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            每用户默认配额；可在「用户详情」单独覆盖。管理员与 VIP 不限。0 表示不限。
            AI 任务数上限在上方「商城 / VIP」的免费任务数设置。
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>因子实验室/天</Label>
              <Input
                type="number"
                min={0}
                value={form.factor_lab_daily_limit}
                onChange={(e) =>
                  updateField(
                    "factor_lab_daily_limit",
                    Number(e.target.value || 0),
                  )
                }
              />
              <p className="text-xs text-[var(--text-muted)]">默认 3</p>
            </div>
            <div className="space-y-2">
              <Label>历史回测/天</Label>
              <Input
                type="number"
                min={0}
                value={form.backtest_daily_limit}
                onChange={(e) =>
                  updateField(
                    "backtest_daily_limit",
                    Number(e.target.value || 0),
                  )
                }
              />
              <p className="text-xs text-[var(--text-muted)]">默认 2</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-3">
        <Button validateNumbers onClick={() => void handleSave()} disabled={saving}>
          {saving ? "保存中…" : "保存设置"}
        </Button>
      </div>
    </div>
  )
}
