"use client"

/**
 * AI 看盘主播运行视图 —— 状态/倒计时/最新结论/播报历史/控制/语音设置/K线图解
 *
 * 右栏仅 296px：头部按行堆叠（状态行/摘要行/模型行/按钮行），杜绝挤压换行。
 */

import { useEffect, useMemo, useState } from "react"
import {
  CandlestickChart,
  Megaphone,
  MessageCircle,
  Pause,
  Play,
  Settings2,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useAiAnchorStore } from "@/stores/ai-anchor"
import type { AnchorHorizon, AnchorStrategy, AnchorTask } from "@/lib/ai-anchor-api"
import type { AnchorDraft } from "@/lib/ai-anchor-persist"
import { useAISettingsStore } from "@/stores/ai-settings"
import { speakAnchor } from "@/lib/speech"
import { AnchorBroadcastCard, AnchorBroadcastRow } from "./anchor-broadcast-card"
import { AnchorChatDialog } from "./anchor-chat-dialog"
import { AnchorConfigForm } from "./anchor-config-form"
import { AnchorChartDialog } from "./anchor-chart-dialog"
import { AnchorPositionCard } from "./anchor-position-card"
import { AnchorVoiceSettings } from "./anchor-voice-settings"

/** 操盘策略选项（运行中随时切换，下一轮播报生效） */
const STRATEGIES: Array<{ value: AnchorStrategy; label: string; hint: string }> = [
  { value: "aggressive", label: "激进", hint: "信号初现即做单，快进快出" },
  { value: "balanced", label: "稳健", hint: "双重确认再进，重视盈亏比" },
  { value: "conservative", label: "保守", hint: "多信号共振才做，重在风控" },
]

/** 交易风格选项（持仓周期维度，与操盘策略正交；随时切换，下一轮播报生效） */
const HORIZONS: Array<{ value: AnchorHorizon; label: string; hint: string }> = [
  { value: "short", label: "短线", hint: "分钟级节奏快进快出，持仓数分钟到数小时" },
  { value: "mid", label: "中线", hint: "波段思路，持仓数小时到数天" },
  { value: "long", label: "长线", hint: "趋势大结构，持仓数天到数周" },
]

/** 任务配置 → 编辑草稿（暂停调参弹窗用；不写 localStorage） */
function draftFromTask(task: AnchorTask): AnchorDraft {
  return {
    modelRowId: task.model_row_id,
    symbol: task.symbol,
    timeframes: task.timeframes.length > 0 ? task.timeframes : [task.timeframe],
    directionMode: task.direction_mode,
    barCount: task.bar_count,
    intervalMinutes: task.interval_minutes,
    indicators: task.indicators,
    horizon: task.horizon,
  }
}

/** 倒计时 mm:ss（负数视为已到期 → 分析中） */
function countdownText(nextRunAt: string | null, now: number): string {
  if (!nextRunAt) return "--:--"
  const remain = Math.floor((new Date(nextRunAt).getTime() - now) / 1000)
  if (remain <= 0) return "分析中…"
  const minutes = Math.floor(remain / 60)
  const seconds = remain % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

export function AnchorRunningView(): React.JSX.Element {
  const task = useAiAnchorStore((s) => s.task)
  const broadcasts = useAiAnchorStore((s) => s.broadcasts)
  const acting = useAiAnchorStore((s) => s.acting)
  const error = useAiAnchorStore((s) => s.error)
  const voiceEnabled = useAiAnchorStore((s) => s.voiceEnabled)
  const pause = useAiAnchorStore((s) => s.pause)
  const patchConfig = useAiAnchorStore((s) => s.patchConfig)
  const resume = useAiAnchorStore((s) => s.resume)
  const stop = useAiAnchorStore((s) => s.stop)
  const models = useAISettingsStore((s) => s.models)
  const [now, setNow] = useState(() => Date.now())
  const [showVoiceSettings, setShowVoiceSettings] = useState(false)
  const [chartOpen, setChartOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  // 每秒刷新倒计时
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (!task) return <div className="p-3 text-xs text-[var(--text-muted)]">加载中…</div>

  const modelName =
    models.find((m) => m.id === task.model_row_id)?.display_name ?? "已选模型"
  // 模型按渠道商分组（一级渠道商 → 二级模型），保持渠道首次出现顺序
  const modelGroups = useMemo(() => {
    const groups = new Map<string, typeof models>()
    for (const m of models) {
      const key = m.provider_name?.trim() || "其它渠道"
      const list = groups.get(key)
      if (list) list.push(m)
      else groups.set(key, [m])
    }
    return Array.from(groups.entries())
  }, [models])
  const running = task.status === "running"
  const marketClosed = !task.market_open
  const analyzing = running && !marketClosed && countdownText(task.next_run_at, now) === "分析中…"
  // 状态文案：运行中（细分 闭盘等待/分析中）或已暂停
  const statusText = !running
    ? "已暂停"
    : marketClosed
      ? "闭盘等待"
      : analyzing
        ? "分析中"
        : "运行中"
  const statusColor = !running ? "#f59e0b" : marketClosed ? "var(--text-secondary)" : "#22c55e"
  const directionText =
    task.direction_mode === "long"
      ? "只做多"
      : task.direction_mode === "short"
        ? "只做空"
        : "双向"
  const horizonLabel = HORIZONS.find((h) => h.value === task.horizon)?.label ?? "短线"
  const timeframesText = (
    task.timeframes.length > 0 ? task.timeframes : [task.timeframe]
  ).join("/")
  const latest = broadcasts[0]
  const history = broadcasts.slice(1)

  return (
    <div className="h-full flex flex-col">
      {/* 头部：分行堆叠，适配 296px 窄栏 */}
      <div className="shrink-0 px-3 pt-2.5 pb-2 border-b border-[var(--border)] space-y-2">
        {/* 行1：状态徽标 + 倒计时 | 语音按钮 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={"w-1.5 h-1.5 rounded-full shrink-0 " + (running ? "animate-pulse" : "")}
              style={{ backgroundColor: statusColor }}
            />
            <span className="text-xs font-bold shrink-0" style={{ color: statusColor }}>
              {statusText}
            </span>
            {running && !marketClosed && !analyzing && (
              <span className="text-[10px] font-num text-[var(--text-secondary)]">
                下次 {countdownText(task.next_run_at, now)}
              </span>
            )}
            {marketClosed && (
              <span className="text-[10px] text-[var(--text-muted)]">开盘自动恢复</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              title="重新播报最新结论"
              disabled={!latest}
              onClick={() =>
                latest &&
                speakAnchor(
                  {
                    symbol: latest.symbol,
                    direction: latest.direction,
                    action: latest.action,
                    commentary: latest.model_error ? "" : latest.commentary,
                  },
                  true,
                )
              }
              className="p-1.5 rounded cursor-pointer transition-colors text-[var(--text-secondary)] hover:text-[var(--primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-default"
            >
              <Megaphone className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="语音设置（音色/语速/开关）"
              onClick={() => setShowVoiceSettings((v) => !v)}
              className={
                "p-1.5 rounded cursor-pointer transition-colors shrink-0 " +
                (voiceEnabled
                  ? "text-[var(--primary)] hover:bg-[var(--bg-tertiary)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]")
              }
            >
              {voiceEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* 行2：品种/分时段/窗口/风格/方向 摘要（flex-wrap 防溢出） */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--text-secondary)]">
          <span className="font-bold font-num text-[var(--text-primary)]">
            {task.symbol.toUpperCase()}
          </span>
          <span>{timeframesText}</span>
          <span>{task.bar_count}根</span>
          <span>每{task.interval_minutes}分</span>
          <span>{horizonLabel}</span>
          <span>{directionText}</span>
          <span>已播{broadcasts.length}条</span>
        </div>

        {/* 行3：主播模型（运行中随时切换，下一轮播报生效）——
            两级菜单：一级渠道商(optgroup)，二级该渠道下的模型 */}
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
          <span className="shrink-0">模型</span>
          <select
            value={task.model_row_id}
            disabled={acting}
            onChange={(e) => {
              const value = e.target.value
              if (value && value !== task.model_row_id) void patchConfig({ modelRowId: value })
            }}
            className="flex-1 min-w-0 h-6 px-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-[10px] text-[var(--text-primary)] outline-none cursor-pointer disabled:opacity-50"
            title={`当前：${modelName}，切换后下一轮播报生效`}
          >
            {models.length === 0 && <option value={task.model_row_id}>{modelName}</option>}
            {modelGroups.map(([providerName, items]) => (
              <optgroup key={providerName} label={providerName}>
                {items.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* 行3b：操盘策略三档 + 交易风格三档（随时切换，下一轮播报生效） */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-[var(--text-muted)] shrink-0">策略</span>
          <div className="flex flex-1 gap-1">
            {STRATEGIES.map((item) => {
              const active = task.strategy === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  title={item.hint + "，切换后下一轮播报生效"}
                  disabled={acting}
                  onClick={() => {
                    if (!active) void patchConfig({ strategy: item.value })
                  }}
                  className={
                    "flex-1 h-6 rounded text-[10px] border cursor-pointer transition-colors disabled:opacity-50 " +
                    (active
                      ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10 font-medium"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
                  }
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-[var(--text-muted)] shrink-0">风格</span>
          <div className="flex flex-1 gap-1">
            {HORIZONS.map((item) => {
              const active = task.horizon === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  title={item.hint + "，切换后下一轮播报生效"}
                  disabled={acting}
                  onClick={() => {
                    if (!active) void patchConfig({ horizon: item.value })
                  }}
                  className={
                    "flex-1 h-6 rounded text-[10px] border cursor-pointer transition-colors disabled:opacity-50 " +
                    (active
                      ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10 font-medium"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
                  }
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* 行4：按钮组（暂停态突出"继续/调参"，运行态常规控制） */}
        {!running ? (
          <>
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={acting}
                onClick={() => void resume()}
                className="flex-[2] h-7 rounded text-[11px] bg-[var(--primary)] text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1 cursor-pointer"
              >
                <Play className="w-3 h-3" />
                继续播报
              </button>
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                title="暂停中可修改品种/分时段/根数/间隔/技术线/模型等全部参数，保存后恢复运行"
                className="flex-1 h-7 rounded text-[11px] border border-[var(--primary)]/50 text-[var(--primary)] hover:bg-[var(--primary)]/10 flex items-center justify-center gap-1 cursor-pointer"
              >
                <Settings2 className="w-3 h-3" />
                调整参数
              </button>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setChartOpen(true)}
                className="flex-1 h-7 rounded text-[11px] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center gap-1 cursor-pointer"
              >
                <CandlestickChart className="w-3 h-3" />
                K线图解
              </button>
              <button
                type="button"
                onClick={() => setChatOpen(true)}
                title="与AI对话：按需加载K线/大单/盘口/新闻做分析并画技术图"
                className="flex-1 h-7 rounded text-[11px] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center gap-1 cursor-pointer"
              >
                <MessageCircle className="w-3 h-3" />
                对话交互
              </button>
              <button
                type="button"
                disabled={acting}
                onClick={() => void stop()}
                className="flex-1 h-7 rounded text-[11px] border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50 flex items-center justify-center gap-1 cursor-pointer"
              >
                <Square className="w-3 h-3" />
                停止
              </button>
            </div>
          </>
        ) : (
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setChartOpen(true)}
              className="flex-1 h-7 rounded text-[11px] border border-[var(--primary)]/50 text-[var(--primary)] hover:bg-[var(--primary)]/10 flex items-center justify-center gap-1 cursor-pointer"
            >
              <CandlestickChart className="w-3 h-3" />
              K线图解
            </button>
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              title="与AI对话：按需加载K线/大单/盘口/新闻做分析并画技术图"
              className="flex-1 h-7 rounded text-[11px] border border-[var(--primary)]/50 text-[var(--primary)] hover:bg-[var(--primary)]/10 flex items-center justify-center gap-1 cursor-pointer"
            >
              <MessageCircle className="w-3 h-3" />
              对话交互
            </button>
            <button
              type="button"
              disabled={acting}
              onClick={() => void pause()}
              className="flex-1 h-7 rounded text-[11px] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 flex items-center justify-center gap-1 cursor-pointer"
            >
              <Pause className="w-3 h-3" />
              暂停
            </button>
            <button
              type="button"
              disabled={acting}
              onClick={() => void stop()}
              className="flex-1 h-7 rounded text-[11px] border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50 flex items-center justify-center gap-1 cursor-pointer"
            >
              <Square className="w-3 h-3" />
              停止
            </button>
          </div>
        )}

        {showVoiceSettings && <AnchorVoiceSettings />}
        {error && <div className="text-[10px] text-red-400">{error}</div>}
      </div>

      {/* 持仓录入（填写后播报持仓状态与操作建议） */}
      <div className="shrink-0 px-3 pt-2">
        <AnchorPositionCard />
      </div>

      {/* 最新结论（点击打开K线图解）；播报文案过长时限高内部滚动，不撑爆视口 */}
      <div className="shrink-0 px-3 py-2 max-h-[45%] overflow-y-auto">
        {latest ? (
          <AnchorBroadcastCard broadcast={latest} />
        ) : (
          <div className="rounded-lg border border-dashed border-[var(--border)] p-4 text-center text-[11px] text-[var(--text-muted)]">
            {marketClosed
              ? "当前闭盘，开盘后自动开始播报"
              : running
                ? "首轮分析中，稍候即可看到播报…"
                : "已暂停"}
          </div>
        )}
      </div>

      {/* 播报历史 */}
      <div className="min-h-0 flex-1 flex flex-col">
        <div className="px-3 pb-1 text-[10px] text-[var(--text-muted)] shrink-0">
          播报历史
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--border)]">
          {history.length === 0 ? (
            <div className="p-3 text-[10px] text-[var(--text-muted)]">暂无更多播报</div>
          ) : (
            history.map((item) => <AnchorBroadcastRow key={item.id} broadcast={item} />)
          )}
        </div>
      </div>

      <AnchorChartDialog open={chartOpen} onOpenChange={setChartOpen} />
      <AnchorChatDialog open={chatOpen} onOpenChange={setChatOpen} />

      {/* 暂停调参弹窗：编辑模式配置表单，保存并继续 = upsert 后立即恢复运行 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md w-[92vw] h-[80vh] p-0 flex flex-col gap-0">
          <DialogTitle className="px-3 pt-3 pb-2 text-sm font-bold shrink-0">
            调整主播参数
          </DialogTitle>
          <div className="min-h-0 flex-1">
            <AnchorConfigForm
              initialDraft={draftFromTask(task)}
              submitLabel="保存并继续"
              onDone={() => setEditOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
