"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Toggle } from "@/components/ui/toggle"
import {
  getAdminSettingsApi,
  testVvtrConnectionApi,
  updateVvtrSettingsApi,
  type SystemSettings,
  type VvtrTestResult,
} from "@/lib/admin-api"

const DEFAULTS = {
  vvtr_enabled: false,
  vvtr_api_key_masked: "",
  vvtr_api_key_set: false,
  vvtr_mobile: "",
  vvtr_base_url: "https://rest.vvtr.com/v1",
  vvtr_ws_url: "wss://rest.vvtr.com/v2/connect",
  vvtr_quotes_enabled: true,
  vvtr_ws_enabled: true,
  vvtr_kline_enabled: false,
}

type VvtrForm = typeof DEFAULTS

/** VVTR 数据源配置 —— 密钥填写 + 接口开关 + 连接测试 */
export default function AdminVvtrPage(): React.JSX.Element {
  const [form, setForm] = useState<VvtrForm>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  // 新密钥输入（留空=不修改已存密钥）
  const [newKey, setNewKey] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<VvtrTestResult | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const s: SystemSettings = await getAdminSettingsApi()
        if (!cancelled) {
          setForm({
            vvtr_enabled: s.vvtr_enabled ?? false,
            vvtr_api_key_masked: s.vvtr_api_key_masked ?? "",
            vvtr_api_key_set: s.vvtr_api_key_set ?? false,
            vvtr_mobile: s.vvtr_mobile ?? "",
            vvtr_base_url: s.vvtr_base_url ?? DEFAULTS.vvtr_base_url,
            vvtr_ws_url: s.vvtr_ws_url ?? DEFAULTS.vvtr_ws_url,
            vvtr_quotes_enabled: s.vvtr_quotes_enabled ?? true,
            vvtr_ws_enabled: s.vvtr_ws_enabled ?? true,
            vvtr_kline_enabled: s.vvtr_kline_enabled ?? false,
          })
        }
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

  function updateField<K extends keyof VvtrForm>(
    key: K,
    value: VvtrForm[K],
  ): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    setMessage("")
    setError("")
    try {
      const saved = await updateVvtrSettingsApi({
        vvtr_enabled: form.vvtr_enabled,
        vvtr_mobile: form.vvtr_mobile,
        vvtr_base_url: form.vvtr_base_url,
        vvtr_ws_url: form.vvtr_ws_url,
        vvtr_quotes_enabled: form.vvtr_quotes_enabled,
        vvtr_ws_enabled: form.vvtr_ws_enabled,
        vvtr_kline_enabled: form.vvtr_kline_enabled,
        ...(newKey.trim() ? { vvtr_api_key: newKey.trim() } : {}),
      })
      setForm({
        vvtr_enabled: saved.vvtr_enabled ?? false,
        vvtr_api_key_masked: saved.vvtr_api_key_masked ?? "",
        vvtr_api_key_set: saved.vvtr_api_key_set ?? false,
        vvtr_mobile: saved.vvtr_mobile ?? "",
        vvtr_base_url: saved.vvtr_base_url ?? DEFAULTS.vvtr_base_url,
        vvtr_ws_url: saved.vvtr_ws_url ?? DEFAULTS.vvtr_ws_url,
        vvtr_quotes_enabled: saved.vvtr_quotes_enabled ?? true,
        vvtr_ws_enabled: saved.vvtr_ws_enabled ?? true,
        vvtr_kline_enabled: saved.vvtr_kline_enabled ?? false,
      })
      setNewKey("")
      setMessage("设置已保存（行情桥将在 10 秒内自动应用新配置）")
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    setError("")
    try {
      const result = await testVvtrConnectionApi({
        ...(newKey.trim() ? { api_key: newKey.trim() } : {}),
        mobile: form.vvtr_mobile,
      })
      setTestResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接测试失败")
    } finally {
      setTesting(false)
    }
  }

  async function handleClearKey(): Promise<void> {
    setSaving(true)
    setError("")
    setMessage("")
    try {
      const saved = await updateVvtrSettingsApi({ vvtr_api_key_clear: true })
      setForm((prev) => ({
        ...prev,
        vvtr_api_key_masked: saved.vvtr_api_key_masked ?? "",
        vvtr_api_key_set: saved.vvtr_api_key_set ?? false,
      }))
      setMessage("已清除存储的 apiKey")
    } catch (err) {
      setError(err instanceof Error ? err.message : "清除失败")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-[var(--text-muted)]">加载设置…</div>
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">
          VVTR 数据源
        </h1>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          长尾猴量化 API（doc.vvtr.com）—— WS v2 深度行情（国内期货 250~500ms
          推送，5 档盘口），未启用或无密钥时自动回落新浪渠道
        </p>
      </div>

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

      {/* 对接参数 */}
      <Card>
        <CardHeader>
          <CardTitle>对接参数</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>API Key</Label>
            <div className="flex items-center gap-2">
              <Input
                type="password"
                placeholder={
                  form.vvtr_api_key_set
                    ? `已配置（${form.vvtr_api_key_masked}），留空则不修改`
                    : "粘贴 VVTR apiKey"
                }
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                autoComplete="off"
              />
              {form.vvtr_api_key_set && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleClearKey()}
                  disabled={saving}
                >
                  清除
                </Button>
              )}
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              密钥 AES-256-GCM 加密存储，接口仅回显脱敏值，不会出现在日志中
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>账号手机号</Label>
              <Input
                placeholder="权限查询用（可选）"
                value={form.vvtr_mobile}
                onChange={(e) => updateField("vvtr_mobile", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>REST 基础 URL</Label>
              <Input
                value={form.vvtr_base_url}
                onChange={(e) => updateField("vvtr_base_url", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>深度行情 WS 地址</Label>
            <Input
              value={form.vvtr_ws_url}
              onChange={(e) => updateField("vvtr_ws_url", e.target.value)}
            />
            <p className="text-xs text-[var(--text-muted)]">
              v2 为深度行情（250~500ms 实时推送）；v1 仅 3 秒 L1，不建议
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 开关 */}
      <Card>
        <CardHeader>
          <CardTitle>数据对接开关</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-md bg-[var(--bg-tertiary)]">
            <div>
              <p className="text-sm text-[var(--text-primary)]">启用 VVTR 数据源</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                总开关：关闭后行情桥休眠，实时渠道自动回落新浪
              </p>
            </div>
            <Toggle
              checked={form.vvtr_enabled}
              onChange={(v) => updateField("vvtr_enabled", v)}
              disabled={saving}
              aria-label="启用 VVTR"
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-md bg-[var(--bg-tertiary)]">
            <div>
              <p className="text-sm text-[var(--text-primary)]">
                实时行情（报价 / 盘口 / 成交）
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                WS 深度推送：最新价、五档买卖盘、逐笔成交秒级更新；
                需在「渠道监控」把实盘渠道切为 vvtr 后才作为主源
              </p>
            </div>
            <Toggle
              checked={form.vvtr_quotes_enabled}
              onChange={(v) => updateField("vvtr_quotes_enabled", v)}
              disabled={saving || !form.vvtr_enabled}
              aria-label="VVTR 实时行情开关"
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-md bg-[var(--bg-tertiary)]">
            <div>
              <p className="text-sm text-[var(--text-primary)]">
                WSS 推送通道（v2 深度 / v1 L1）
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                开：自动尝试 WSS 推送（每 10 分钟重试，不可用时 HTTP 兜底）；
                关：仅 HTTP 快照轮询（3 秒/轮）——WSS 推送问题解决前建议关闭
              </p>
            </div>
            <Toggle
              checked={form.vvtr_ws_enabled}
              onChange={(v) => updateField("vvtr_ws_enabled", v)}
              disabled={
                saving || !form.vvtr_enabled || !form.vvtr_quotes_enabled
              }
              aria-label="VVTR WSS 推送开关"
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-md bg-[var(--bg-tertiary)]">
            <div>
              <p className="text-sm text-[var(--text-primary)]">历史 K 线源</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                注册为 K 线可选数据源（主/备渠道在「渠道监控」配置）；
                注意 15m 以下周期仅支持近 6 个月数据
              </p>
            </div>
            <Toggle
              checked={form.vvtr_kline_enabled}
              onChange={(v) => updateField("vvtr_kline_enabled", v)}
              disabled={saving || !form.vvtr_enabled}
              aria-label="VVTR 历史K线开关"
            />
          </div>
        </CardContent>
      </Card>

      {/* 连接测试 */}
      <Card>
        <CardHeader>
          <CardTitle>连接测试</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-[var(--text-muted)]">
            调用 VVTR /my/permissions 校验密钥（输入框有新密钥时优先用新密钥试连，可不保存先测）
          </p>
          <Button
            onClick={() => void handleTest()}
            disabled={testing || (!newKey.trim() && !form.vvtr_api_key_set)}
          >
            {testing ? "测试中…" : "测试连接"}
          </Button>

          {testResult && (
            <div className="space-y-3">
              <div
                className={`px-4 py-2 rounded-md text-sm ${
                  testResult.ok
                    ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                    : "bg-[var(--accent-danger)]/15 text-[var(--accent-danger)]"
                }`}
              >
                {testResult.ok ? "连接成功" : "连接失败"}：{testResult.msg}
                {testResult.code != null && `（code=${testResult.code}）`}
              </div>

              {testResult.packages.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">生效套餐</p>
                  <div className="space-y-1">
                    {testResult.packages.map((p, i) => (
                      <div
                        key={`${p.market_code}-${i}`}
                        className="flex items-center justify-between px-3 py-2 rounded-md bg-[var(--bg-tertiary)] text-sm"
                      >
                        <span>
                          {p.market_name ?? p.name ?? p.market_code}
                          <span className="text-xs text-[var(--text-muted)] ml-2">
                            单次提交上限 {p.limit ?? "-"} symbols
                          </span>
                        </span>
                        <span className="text-xs text-[var(--text-muted)]">
                          {p.days_left != null
                            ? `剩余 ${p.days_left} 天`
                            : (p.expire_time ?? "")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {testResult.ok && testResult.apis.length > 0 && (
                <details className="text-xs text-[var(--text-muted)]">
                  <summary className="cursor-pointer">
                    可调用接口（{testResult.apis.length} 个）
                  </summary>
                  <div className="mt-1 max-h-40 overflow-y-auto px-3 py-2 rounded-md bg-[var(--bg-tertiary)]">
                    {testResult.apis.map((api) => (
                      <div key={api}>{api}</div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? "保存中…" : "保存设置"}
        </Button>
      </div>
    </div>
  )
}
