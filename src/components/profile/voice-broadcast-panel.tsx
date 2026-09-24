"use client"

/**
 * 语音播报设置面板 —— 个人中心新 Tab
 *
 * 最多 4 个品种、周期 1/5/10/15/30/60 分钟；同刻到点按配置顺序排队
 * 播报、间隔 1 秒（引擎见 lib/voice-broadcast-engine）。
 * 音色为微软云端自然人声（云希/晓晓/晓伊等，服务器 edge-tts 代理合成，
 * 任何浏览器可用；失败自动回退本地系统语音）。语速 0.5~1.5。
 * 配置存本设备 localStorage，播报全局常驻（不限于本页面）。
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Volume2, Plus, Trash2, PlayCircle } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"
import { MAX_ITEMS, ALLOWED_INTERVALS } from "@/lib/voice-broadcast-core.mjs"
import { useVoiceBroadcastStore } from "@/stores/voice-broadcast"
import { speakBroadcastTest, type TestSpeakResult } from "@/lib/voice-broadcast-engine"
import { getAnchorVoicesApi, type AnchorCloudVoice } from "@/lib/ai-anchor-api"

const INTERVAL_LABEL: Record<number, string> = {
  1: "1 分钟",
  5: "5 分钟",
  10: "10 分钟",
  15: "15 分钟",
  30: "30 分钟",
  60: "1 小时",
}

const RESULT_HINT: Record<TestSpeakResult, string> = {
  ok: "",
  "no-voice": "语音播放失败（云端不可用且本机无语音）",
  "no-data": "暂无该品种行情数据，稍后再试",
}

/** 云端音色兜底列表（后端 /voices 为准，拉取失败时用） */
const FALLBACK_VOICES: AnchorCloudVoice[] = [
  { id: "zh-CN-YunxiNeural", name: "云希", desc: "男 · 阳光沉稳" },
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", desc: "女 · 温暖亲切" },
  { id: "zh-CN-YunjianNeural", name: "云健", desc: "男 · 浑厚磁性" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", desc: "女 · 甜美活泼" },
  { id: "zh-CN-YunyangNeural", name: "云扬", desc: "男 · 新闻播报" },
  { id: "zh-CN-XiaochenNeural", name: "晓辰", desc: "女 · 沉稳干练" },
]

const selectCls =
  "h-8 px-2 text-xs rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"

export function VoiceBroadcastPanel(): React.JSX.Element {
  const settings = useVoiceBroadcastStore((s) => s.settings)
  const hydrate = useVoiceBroadcastStore((s) => s.hydrate)
  const setEnabled = useVoiceBroadcastStore((s) => s.setEnabled)
  const addItem = useVoiceBroadcastStore((s) => s.addItem)
  const removeItem = useVoiceBroadcastStore((s) => s.removeItem)
  const setIntervalMin = useVoiceBroadcastStore((s) => s.setIntervalMin)
  const setItemEnabled = useVoiceBroadcastStore((s) => s.setItemEnabled)
  const setVoiceId = useVoiceBroadcastStore((s) => s.setVoiceId)
  const setRate = useVoiceBroadcastStore((s) => s.setRate)

  const [products, setProducts] = useState<{ code: string; name: string }[]>([])
  const [voices, setVoices] = useState<AnchorCloudVoice[]>(FALLBACK_VOICES)
  const [pickCode, setPickCode] = useState("")
  const [pickInterval, setPickInterval] = useState<number>(5)
  const [testing, setTesting] = useState<string | null>(null)
  const [testHint, setTestHint] = useState<{ code: string; msg: string } | null>(
    null,
  )

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const loadProducts = useCallback(async () => {
    try {
      const { getContractsByCodeApi } = await import("@/lib/api")
      const tree = await getContractsByCodeApi()
      const list = Object.values(tree || {})
        .map((n) => ({ code: String(n.code || ""), name: String(n.name || "") }))
        .filter((p) => p.code && p.name)
        .sort((a, b) => a.code.localeCompare(b.code))
      setProducts(list)
    } catch {
      // 品种清单加载失败：保留空（仍可管理已有条目）
    }
  }, [])

  useEffect(() => {
    void loadProducts()
  }, [loadProducts])

  const loadVoices = useCallback(async () => {
    try {
      const list = await getAnchorVoicesApi()
      if (Array.isArray(list) && list.length > 0) setVoices(list)
    } catch {
      // 云端音色清单拉取失败：用兜底列表（合成接口仍可用）
    }
  }, [])

  useEffect(() => {
    void loadVoices()
  }, [loadVoices])

  const productOptions = useMemo(() => {
    const chosen = new Set(settings.items.map((it) => it.code))
    return products.filter((p) => !chosen.has(p.code))
  }, [products, settings.items])

  const canAdd = settings.items.length < MAX_ITEMS

  function handleAdd(): void {
    if (!pickCode || !canAdd) return
    const p = products.find((x) => x.code === pickCode)
    if (addItem(pickCode, p?.name || pickCode, pickInterval)) {
      setPickCode("")
    }
  }

  async function handleTest(code: string, name: string): Promise<void> {
    setTesting(code)
    setTestHint(null)
    try {
      const result = await speakBroadcastTest(code, name)
      const msg = RESULT_HINT[result]
      if (msg) setTestHint({ code, msg })
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-[var(--primary)]" />
              <span className="text-sm font-medium">语音播报</span>
              <Badge variant="secondary">
                {settings.items.length}/{MAX_ITEMS}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--text-muted)]">
                {settings.enabled ? "已开启" : "已关闭"}
              </span>
              <Toggle
                checked={settings.enabled}
                onChange={setEnabled}
                aria-label="语音播报总开关"
              />
            </div>
          </div>
          <p className="text-xs text-[var(--text-muted)] leading-5">
            按周期播报所选品种的最新价与涨跌幅。周期按整分对齐（如 5 分钟在
            每小时 :00/:05/:10…），多个品种同一时刻到点时按下方顺序排队播报，
            每条间隔 1 秒。播报在应用内全局生效，不限于本页面；配置保存在本设备。
          </p>
          <Separator />

          {/* 音色与语速 */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-[var(--text-secondary)] shrink-0">播报音色</span>
            <select
              className={cn(selectCls, "min-w-[220px]")}
              value={settings.voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              aria-label="播报音色"
            >
              <option value="">自动（云端 · 云希）</option>
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {`${v.name}（${v.desc || v.id}）`}
                </option>
              ))}
              <option value="local">本地系统语音（机械声兜底）</option>
            </select>
            <span className="text-xs text-[var(--text-secondary)] shrink-0 ml-2">
              语速
            </span>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.1}
              value={settings.rate}
              onChange={(e) => setRate(Number(e.target.value))}
              className="w-28 accent-[var(--primary)]"
              aria-label="播报语速"
            />
            <span className="text-xs font-num text-[var(--text-secondary)] w-9">
              {settings.rate.toFixed(1)}x
            </span>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            自然人声由服务器合成（微软神经网络音色），任何浏览器/客户端都可用；
            服务器或网络不可用时自动回退本地系统语音。
          </p>
          <Separator />

          {/* 已配置条目（顺序即同刻排队播报顺序） */}
          <div className="space-y-2">
            {settings.items.length === 0 && (
              <p className="text-xs text-[var(--text-muted)] py-2">
                暂未配置品种，从下方添加。
              </p>
            )}
            {settings.items.map((it, idx) => (
              <div
                key={it.code}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]",
                  !it.enabled && "opacity-60",
                )}
              >
                <span className="text-xs text-[var(--text-muted)] w-4 text-right">
                  {idx + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">
                    {it.name}
                    <span className="ml-1.5 text-xs text-[var(--text-muted)] font-num">
                      {it.code}
                    </span>
                  </p>
                  {testHint?.code === it.code && (
                    <p className="text-xs text-amber-500 mt-0.5">{testHint.msg}</p>
                  )}
                </div>
                <select
                  className={selectCls}
                  value={it.intervalMin}
                  onChange={(e) => setIntervalMin(it.code, Number(e.target.value))}
                  aria-label={`${it.name}播报周期`}
                >
                  {ALLOWED_INTERVALS.map((m) => (
                    <option key={m} value={m}>
                      {INTERVAL_LABEL[m] ?? `${m} 分钟`}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={testing === it.code}
                  onClick={() => void handleTest(it.code, it.name)}
                  aria-label={`试听${it.name}`}
                >
                  <PlayCircle className="w-3.5 h-3.5" />
                  {testing === it.code ? "试听中…" : "试听"}
                </Button>
                <Toggle
                  checked={it.enabled}
                  onChange={(v) => setItemEnabled(it.code, v)}
                  aria-label={`${it.name}开关`}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-red-400 hover:text-red-500"
                  onClick={() => removeItem(it.code)}
                  aria-label={`删除${it.name}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <Separator />

          {/* 添加新品种 */}
          <div className="flex items-center gap-2">
            <select
              className={cn(selectCls, "flex-1 min-w-0")}
              value={pickCode}
              onChange={(e) => setPickCode(e.target.value)}
              disabled={!canAdd}
              aria-label="选择品种"
            >
              <option value="">
                {canAdd ? "选择品种…" : `已达上限 ${MAX_ITEMS} 个`}
              </option>
              {productOptions.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}（{p.code}）
                </option>
              ))}
            </select>
            <select
              className={selectCls}
              value={pickInterval}
              onChange={(e) => setPickInterval(Number(e.target.value))}
              disabled={!canAdd}
              aria-label="播报周期"
            >
              {ALLOWED_INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {INTERVAL_LABEL[m] ?? `${m} 分钟`}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={!pickCode || !canAdd}
              onClick={handleAdd}
            >
              <Plus className="w-3.5 h-3.5" />
              添加
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
