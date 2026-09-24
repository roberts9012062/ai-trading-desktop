"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  ALL_CHANNEL_OPTIONS,
  REALTIME_CHANNEL_OPTIONS,
  getAdminSettingsApi,
  getChannelStatusApi,
  getKlineSourceStatusApi,
  getKlineSyncStatusApi,
  restartChannelApi,
  updateAdminSettingsApi,
  type ChannelStatusResponse,
  type KlineSourceStatusResponse,
  type KlineSyncStatusResponse,
  type SystemSettings,
} from "@/lib/admin-api"

/** 渠道状态色：绿=正常 橙=不稳定 红=不能用（红涨绿跌主题色） */
const STATUS_COLOR: Record<string, string> = {
  green: "var(--accent-down)",
  orange: "var(--accent-warn)",
  red: "var(--accent-danger)",
}
const STATUS_LABEL: Record<string, string> = {
  green: "正常",
  orange: "不稳定",
  red: "不能用",
}

/** K 线历史数据源选项 */
const KLINE_SOURCE_OPTIONS = [
  { value: "sina", label: "新浪财经" },
  { value: "tqsdk", label: "天勤 TqSdk" },
  { value: "eastmoney", label: "东方财富" },
  { value: "simnow", label: "SimNow（本地自产）" },
  { value: "vvtr", label: "VVTR（需在 VVTR 页配置密钥）" },
]

/** 下拉菜单深色样式（select + option 在深色主题下强制深色背景） */
const SELECT_CLASS =
  "bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-1.5 text-sm text-[var(--text-primary)]"
const OPTION_STYLE = { backgroundColor: "var(--bg-secondary)", color: "var(--text-primary)" } as const

/** 解析逗号分隔的备用渠道列表 */
function parseBackupSources(order: string | undefined): string[] {
  if (!order) return ["sina", "tqsdk"]
  return order
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** 行情渠道监控 —— 主备配置 + 全渠道状态（红绿橙）+ 手动重启 */
export default function AdminChannelsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<SystemSettings | null>(null)
  const [status, setStatus] = useState<ChannelStatusResponse | null>(null)
  const [klineStatus, setKlineStatus] =
    useState<KlineSourceStatusResponse | null>(null)
  const [syncStatus, setSyncStatus] = useState<KlineSyncStatusResponse | null>(
    null,
  )
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState<string | null>(null)

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await getAdminSettingsApi())
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载设置失败")
    }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getChannelStatusApi())
    } catch {
      // 轮询静默
    }
  }, [])

  const loadKlineStatus = useCallback(async () => {
    try {
      setKlineStatus(await getKlineSourceStatusApi())
    } catch {
      // 轮询静默
    }
  }, [])

  const loadSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await getKlineSyncStatusApi())
    } catch {
      // 轮询静默
    }
  }, [])

  useEffect(() => {
    void loadSettings()
    void loadStatus()
    void loadKlineStatus()
    void loadSyncStatus()
    const t = setInterval(() => {
      void loadStatus()
      void loadKlineStatus()
      void loadSyncStatus()
    }, 5000)
    return () => clearInterval(t)
  }, [loadSettings, loadStatus, loadKlineStatus, loadSyncStatus])

  async function saveChannel(
    field: "backup_channel" | "market_data_channel",
    value: string,
  ): Promise<void> {
    setSaving(true)
    try {
      setSettings(
        await updateAdminSettingsApi({
          [field]: value,
        } as Partial<SystemSettings>),
      )
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function toggleAuto(value: boolean): Promise<void> {
    setSaving(true)
    try {
      setSettings(
        await updateAdminSettingsApi({
          channel_auto_switch: value,
        } as Partial<SystemSettings>),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  /** 切换 K 线主渠道 */
  async function changeKlinePrimary(source: string): Promise<void> {
    setSaving(true)
    try {
      // 若新主渠道当前在备用列表中，先从备用移除（后端也会校验，这里前端先处理避免闪烁）
      const backups = parseBackupSources(settings?.kline_backup_sources)
      const newBackups = backups.filter((s) => s !== source)
      const patch: Partial<SystemSettings> = {
        kline_primary_source: source as SystemSettings["kline_primary_source"],
      }
      if (newBackups.length !== backups.length) {
        patch.kline_backup_sources = newBackups.join(",")
      }
      setSettings(await updateAdminSettingsApi(patch))
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  /** K 线备用渠道勾选变化：重算列表保存（主渠道自动排除） */
  async function toggleKlineBackup(source: string, checked: boolean): Promise<void> {
    const primary = settings?.kline_primary_source ?? "eastmoney"
    const current = parseBackupSources(settings?.kline_backup_sources).filter(
      (s) => s !== primary,
    )
    const next = checked ? [...current, source] : current.filter((s) => s !== source)
    if (next.length < 1) {
      setError("K 线备用渠道至少保留 1 个")
      return
    }
    setSaving(true)
    try {
      setSettings(
        await updateAdminSettingsApi({
          kline_backup_sources: next.join(","),
        } as Partial<SystemSettings>),
      )
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  /** 切换 K线修正开关 */
  async function updateSyncEnabled(value: boolean): Promise<void> {
    setSaving(true)
    try {
      setSettings(
        await updateAdminSettingsApi({
          kline_sync_enabled: value,
        } as Partial<SystemSettings>),
      )
      setError("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function restart(channel: string): Promise<void> {
    setRestarting(channel)
    try {
      await restartChannelApi(channel)
      await loadStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : "重启失败")
    } finally {
      setRestarting(null)
    }
  }

  const channels = status ? Object.entries(status.channels) : []

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">
        行情渠道监控
      </h1>

      {error && (
        <div className="px-4 py-2 rounded-md bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] text-sm">
          {error}
        </div>
      )}

      {/* 当前生效渠道 */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-4">
          <div>
            <p className="text-xs text-[var(--text-muted)]">当前生效渠道</p>
            <p className="text-xl font-semibold mt-1">{status?.active ?? "-"}</p>
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            主渠道：{status?.primary ?? "-"} · 备用：{status?.backup ?? "-"} ·
            自动切换：{status?.auto_switch ? "开" : "关"}
          </div>
        </CardContent>
      </Card>

      {/* 主备配置 */}
      <Card>
        <CardHeader>
          <CardTitle>主备渠道配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm w-24">主渠道</label>
            <select
              className={SELECT_CLASS}
              value={settings?.market_data_channel ?? "sina"}
              onChange={(e) => void saveChannel("market_data_channel", e.target.value)}
              disabled={saving}
            >
              {ALL_CHANNEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} style={OPTION_STYLE}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm w-24">备用渠道</label>
            <select
              className={SELECT_CLASS}
              value={settings?.backup_channel ?? "sina"}
              onChange={(e) => void saveChannel("backup_channel", e.target.value)}
              disabled={saving}
            >
              {REALTIME_CHANNEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} style={OPTION_STYLE}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-[var(--text-muted)]">
              仅非 7×24 真实数据渠道
            </span>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm w-24">自动切换</label>
            <input
              type="checkbox"
              checked={settings?.channel_auto_switch ?? true}
              onChange={(e) => void toggleAuto(e.target.checked)}
              disabled={saving}
            />
            <span className="text-xs text-[var(--text-muted)]">
              主故障自动切备，恢复自动回切主；每天 09:20 开盘前自检并重启异常 bridge
            </span>
          </div>
        </CardContent>
      </Card>

      {/* K 线历史数据源（主渠道 + 备用渠道） */}
      <Card>
        <CardHeader>
          <CardTitle>K 线历史数据源</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm w-24">主渠道</span>
            <select
              className={SELECT_CLASS}
              value={settings?.kline_primary_source ?? "eastmoney"}
              onChange={(e) => void changeKlinePrimary(e.target.value)}
              disabled={saving}
            >
              {KLINE_SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} style={OPTION_STYLE}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-[var(--text-muted)]">
              K 线全部走主渠道；主渠道故障自动切换备用渠道
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm w-24">备用渠道</span>
            <div className="flex flex-wrap items-center gap-4">
              {KLINE_SOURCE_OPTIONS.map((o) => {
                const primary = settings?.kline_primary_source ?? "eastmoney"
                // 主渠道项在备用列表中禁用（避免主备重复）
                const isPrimary = o.value === primary
                const enabled = parseBackupSources(
                  settings?.kline_backup_sources,
                ).includes(o.value)
                return (
                  <label
                    key={o.value}
                    className={`flex items-center gap-1.5 text-sm ${
                      isPrimary
                        ? "text-[var(--text-muted)] cursor-not-allowed"
                        : "cursor-pointer"
                    }`}
                    title={isPrimary ? "当前主渠道，不可同时作为备用" : ""}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) =>
                        void toggleKlineBackup(o.value, e.target.checked)
                      }
                      disabled={saving || isPrimary}
                    />
                    {o.label}
                  </label>
                )
              })}
            </div>
            <span className="text-xs text-[var(--text-muted)]">
              主渠道故障时按列表顺序降级；至少保留 1 个
            </span>
          </div>
          {/* K 线源状态（每 30s 探测） */}
          <div className="border-t border-[var(--border)] pt-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">K 线源状态</span>
              <span className="text-xs text-[var(--text-muted)]">
                每 30s 探测（后台 8s 后启动）
              </span>
            </div>
            {klineStatus && Object.keys(klineStatus.sources).length > 0 ? (
              <div className="space-y-1.5">
                {Object.entries(klineStatus.sources).map(([src, h]) => {
                  const label =
                    KLINE_SOURCE_OPTIONS.find((o) => o.value === src)?.label ??
                    src
                  const isPrimary = klineStatus.primary === src
                  return (
                    <div
                      key={src}
                      className="flex items-center gap-2 text-xs flex-wrap"
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                        style={{
                          backgroundColor: STATUS_COLOR[h.status] ?? "transparent",
                        }}
                      />
                      <span className="font-medium">
                        {label}
                        {isPrimary && (
                          <span className="ml-1 text-[10px] px-1 rounded bg-[var(--primary)]/20 text-[var(--primary)]">
                            主
                          </span>
                        )}
                      </span>
                      <span style={{ color: STATUS_COLOR[h.status] }}>
                        {STATUS_LABEL[h.status] ?? "-"}
                      </span>
                      <span className="text-[var(--text-muted)]">
                        {h.latency_ms != null ? `${h.latency_ms}ms` : "-"}
                        {" · "}
                        {h.has_data ? `数据 ${h.last_bar_date ?? "-"}` : "无数据"}
                        {h.fails > 0 ? ` · 失败 ${h.fails}次` : ""}
                        {h.in_cooldown ? " · 冷却中" : ""}
                        {h.reason ? ` · ${h.reason}` : ""}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">
                暂无探测数据（backend 启动后约 30s 生成）
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* K 线修正日志 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>K 线修正日志（每天 02:00 + 15:30 自动修正，读 pg-tickdata）</CardTitle>
            <label className="flex items-center gap-1.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={settings?.kline_sync_enabled ?? true}
                onChange={(e) => void updateSyncEnabled(e.target.checked)}
                disabled={saving}
              />
              <span className={settings?.kline_sync_enabled === false ? "text-[var(--accent-danger)]" : ""}>
                {settings?.kline_sync_enabled === false ? "已关闭" : "自动修正"}
              </span>
            </label>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {syncStatus?.status && syncStatus.status.last_run ? (
            <>
              {/* 汇总状态 */}
              <div className="text-sm space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full inline-block"
                    style={{
                      backgroundColor:
                        syncStatus.status.status === "running"
                          ? "var(--accent-warn)"
                          : syncStatus.status.status === "completed"
                            ? "var(--accent-down)"
                            : "var(--accent-danger)",
                    }}
                  />
                  <span className="font-medium">
                    {syncStatus.status.status === "running"
                      ? "修正中..."
                      : syncStatus.status.status === "completed"
                        ? "已完成"
                        : syncStatus.status.status === "completed_with_errors"
                          ? "已完成（有错误）"
                          : "失败"}
                  </span>
                  <span className="text-[var(--text-muted)]">
                    触发：
                    {syncStatus.status.trigger === "scheduled_0200"
                      ? "凌晨 02:00"
                      : syncStatus.status.trigger === "scheduled_1530"
                        ? "闭盘后 15:30"
                        : syncStatus.status.trigger === "manual"
                          ? "手动"
                          : (syncStatus.status.trigger ?? "-")}
                  </span>
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  进度：{syncStatus.status.processed}/{syncStatus.status.total_codes} 品种
                  {syncStatus.status.duration_sec != null
                    ? ` · 耗时 ${Math.round(syncStatus.status.duration_sec)}s`
                    : ""}
                  {(syncStatus.status.errors?.length ?? 0) > 0
                    ? ` · 错误 ${syncStatus.status.errors.length} 个`
                    : ""}
                </div>
                {syncStatus.status.stats &&
                  Object.keys(syncStatus.status.stats).length > 0 && (
                  <div className="text-xs text-[var(--text-muted)]">
                    写入：{Object.entries(syncStatus.status.stats)
                      .filter(([, n]) => n > 0)
                      .map(([p, n]) => `${p}=${n}`)
                      .join(" · ") || "无"}
                  </div>
                )}
              </div>

              {/* 品种级日志 */}
              {syncStatus.logs.length > 0 && (
                <div className="border-t border-[var(--border)] pt-2">
                  <p className="text-xs text-[var(--text-muted)] mb-1.5">
                    最近修正的品种（{syncStatus.logs.length} 条）
                  </p>
                  <div className="max-h-64 overflow-y-auto space-y-1">
                    {syncStatus.logs.slice(0, 50).map((log, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-xs flex-wrap"
                      >
                        <span
                          className="w-2 h-2 rounded-full inline-block shrink-0"
                          style={{
                            backgroundColor:
                              log.status === "ok"
                                ? "var(--accent-down)"
                                : "var(--accent-danger)",
                          }}
                        />
                        <span className="font-medium w-20 shrink-0">
                          {log.symbol}
                        </span>
                        <span className="text-[var(--text-muted)]">
                          {log.ts.slice(11, 19)}
                          {" · "}
                          {log.elapsed_sec}s
                          {" · "}
                          {Object.entries(log.periods)
                            .filter(([, p]) => p.written > 0)
                            .map(([period, p]) => `${period}:${p.written}`)
                            .join(" ") || "无写入"}
                          {log.errors?.length
                            ? ` · ⚠ ${log.errors.join(";")}`
                            : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">
              暂无修正记录（每天 02:00 和 15:30 自动执行）
            </p>
          )}
        </CardContent>
      </Card>

      {/* 渠道状态 */}
      <Card>
        <CardHeader>
          <CardTitle>渠道状态（每 5s 刷新）</CardTitle>
        </CardHeader>
        <CardContent>
          {channels.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              暂无探测数据（backend 启动后约 10s 生成）
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {channels.map(([ch, h]) => (
                <div
                  key={ch}
                  className="border border-[var(--border)] rounded-md p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: STATUS_COLOR[h.status] }}
                      />
                      <span className="font-medium">{ch}</span>
                      {status?.active === ch && (
                        <span className="text-[10px] px-1 rounded bg-[var(--primary)]/20 text-[var(--primary)]">
                          生效中
                        </span>
                      )}
                    </div>
                    <span
                      className="text-xs"
                      style={{ color: STATUS_COLOR[h.status] }}
                    >
                      {STATUS_LABEL[h.status]}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--text-muted)] space-y-0.5">
                    <div>
                      最新价：{h.last_price ?? "-"} · 日期：{h.trade_date ?? "-"}
                    </div>
                    <div>
                      心跳 age：
                      {h.age_sec != null ? `${h.age_sec}s` : "-"}
                      {h.reason ? ` · ${h.reason}` : ""}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full h-7 text-xs"
                    onClick={() => void restart(ch)}
                    disabled={restarting === ch}
                  >
                    {restarting === ch ? "重启中…" : "手动重启 bridge"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
