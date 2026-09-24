"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  getAdminSettingsApi,
  getVenuesApi,
  updateAdminSettingsApi,
} from "@/lib/admin-api"

const DEFAULT_INTERVAL = 2
const MIN_INTERVAL = 1
const MAX_INTERVAL = 10

// 可配置的行情交易所（对应三所适配器；主所生效，备所容灾同频）
const CHANNELS = [
  { key: "okx", label: "OKX", hint: "官方限频宽松，默认 2 秒" },
  { key: "binance", label: "Binance 币安", hint: "受限网络下自动容灾，间隔同样生效" },
  { key: "gate", label: "Gate 芝麻开门", hint: "官方限频宽松，默认 2 秒" },
] as const

/** 刷新节奏 —— 按当前生效行情渠道自动应用对应间隔 */
export default function AdminRefreshIntervalPage(): React.JSX.Element {
  const [defaultSec, setDefaultSec] = useState<number>(DEFAULT_INTERVAL)
  // per-channel 输入：空串=用默认；数字=覆盖
  const [channelSec, setChannelSec] = useState<Record<string, string>>({})
  const [activeChannel, setActiveChannel] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [s, vs] = await Promise.all([
          getAdminSettingsApi(),
          getVenuesApi().catch(() => null),
        ])
        if (cancelled) return
        setDefaultSec(
          Number(s.market_refresh_interval_sec) || DEFAULT_INTERVAL,
        )
        const map: Record<string, string> = {}
        for (const ch of CHANNELS) {
          const v = s.market_refresh_intervals?.[ch.key]
          map[ch.key] = v != null ? String(v) : ""
        }
        setChannelSec(map)
        setActiveChannel(vs?.active || "okx")
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载失败")
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

  async function handleSave(): Promise<void> {
    const d = Math.max(
      MIN_INTERVAL,
      Math.min(MAX_INTERVAL, Number(defaultSec) || DEFAULT_INTERVAL),
    )
    const map: Record<string, number> = {}
    for (const ch of CHANNELS) {
      const raw = channelSec[ch.key]
      if (raw !== "" && raw != null) {
        map[ch.key] = Math.max(
          MIN_INTERVAL,
          Math.min(MAX_INTERVAL, Number(raw) || DEFAULT_INTERVAL),
        )
      }
    }
    setSaving(true)
    setMessage("")
    setError("")
    try {
      const saved = await updateAdminSettingsApi({
        market_refresh_interval_sec: d,
        market_refresh_intervals: map,
      })
      setDefaultSec(
        Number(saved.market_refresh_interval_sec) || DEFAULT_INTERVAL,
      )
      const m: Record<string, string> = {}
      for (const ch of CHANNELS) {
        const v = saved.market_refresh_intervals?.[ch.key]
        m[ch.key] = v != null ? String(v) : ""
      }
      setChannelSec(m)
      setMessage("已保存")
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 text-sm text-[var(--text-muted)]">加载…</div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">
          刷新节奏
        </h1>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          交易时段行情拉取、K 线、WS 推送的间隔，按当前生效渠道自动应用。
          {activeChannel && (
            <>
              {" "}当前生效渠道：
              <span className="text-[var(--primary)] font-medium">
                {activeChannel}
              </span>
            </>
          )}
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

      <Card>
        <CardHeader>
          <CardTitle>默认间隔</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>默认间隔（秒）</Label>
          <Input
            type="number"
            min={MIN_INTERVAL}
            max={MAX_INTERVAL}
            step={1}
            value={defaultSec}
            onChange={(e) => setDefaultSec(Number(e.target.value) || 0)}
          />
          <p className="text-xs text-[var(--text-muted)]">
            未单独配置的渠道用此值。范围 {MIN_INTERVAL}–{MAX_INTERVAL}，默认 1。
            休市时段固定 60 秒，不受此项影响。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>按渠道覆盖</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-[var(--text-muted)]">
            留空 = 用默认。当前生效渠道会标记。
          </p>
          {CHANNELS.map((ch) => {
            const isActive = activeChannel === ch.key
            return (
              <div
                key={ch.key}
                className={`space-y-2 p-3 rounded-md ${
                  isActive ? "bg-[var(--primary)]/10" : ""
                }`}
              >
                <Label>
                  {ch.label}
                  {isActive && (
                    <span className="ml-2 text-xs text-[var(--primary)]">
                      · 当前生效
                    </span>
                  )}
                </Label>
                <Input
                  type="number"
                  min={MIN_INTERVAL}
                  max={MAX_INTERVAL}
                  step={1}
                  value={channelSec[ch.key] ?? ""}
                  placeholder={`用默认（${defaultSec}）`}
                  onChange={(e) =>
                    setChannelSec((prev) => ({
                      ...prev,
                      [ch.key]: e.target.value,
                    }))
                  }
                />
                <p className="text-xs text-[var(--text-muted)]">{ch.hint}</p>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  )
}
