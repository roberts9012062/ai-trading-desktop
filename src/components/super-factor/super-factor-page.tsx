"use client"

/**
 * 超级因子挖掘主页面 —— 长程后台因子挖掘
 * 左：配置表单 + 任务列表；右：选中任务的进度/冠军结果
 */

import { useEffect, useState } from "react"
import { Loader2, Pause, Play, Plus, Square, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { ChampionTable } from "@/components/factor-lab/champion-table"
import { PortfolioCard } from "@/components/factor-lab/portfolio-card"
import { addFactorFavorite, listFactorFavorites } from "@/lib/factor-lab-api"
import type { Champion } from "@/lib/factor-lab-api"
import { isLocalOnly } from "@/components/factor-lab/hooks/factor-helpers"
import { showAlert } from "@/stores/dialog"
import {
  fetchSupported,
  type SupportedInfo,
  type SupportedTimeframe,
} from "@/lib/super-factor-api"
import type { DeviceKind, MiningTask, RunnerKind } from "@/lib/mining/types"
import { MiningSymbolCombobox } from "./mining-symbol-combobox"
import { DataChannelSelect } from "@/components/common/data-channel-select"
import { DEFAULT_KLINE_CHANNEL } from "@/lib/kline-channels"
import { PresetPicker, type MiningPreset } from "./mining-presets"
import { useMiningTasks, useTaskChampions } from "./use-mining-tasks"

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-yellow-500/15 text-yellow-500",
  running: "bg-blue-500/15 text-blue-500",
  paused: "bg-gray-500/15 text-gray-400",
  completed: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-red-500/15 text-red-500",
  cancelled: "bg-gray-500/15 text-gray-400",
}
const STATUS_LABEL: Record<string, string> = {
  pending: "待运行",
  running: "运行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

function fmtDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "-"
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${sec % 60}秒`
  const hr = Math.floor(min / 60)
  return `${hr}时${min % 60}分`
}

/** 任务计时:本机用累计计算用时(不含暂停),服务端用 started_at 墙钟(含排队/暂停,粗略) */
function taskTiming(t: MiningTask): {
  elapsed?: number
  elapsedLabel: string
  perGen?: number
  eta?: number
} {
  const active = t.status === "running" || t.status === "pending"
  const remaining = Math.max(0, t.generations - t.current_generation)
  const wall = t.started_at ? Date.now() - Date.parse(t.started_at) : undefined
  const elapsed = t.elapsed_ms ?? wall
  const perGen =
    t.current_generation > 0 && elapsed != null ? elapsed / t.current_generation : undefined
  return {
    elapsed,
    elapsedLabel: t.elapsed_ms != null ? "计算用时" : "用时(含暂停)",
    perGen,
    eta: active && perGen != null ? perGen * remaining : undefined,
  }
}

export function SuperFactorPage(): React.JSX.Element {
  const {
    tasks,
    loading,
    error,
    createTask,
    pauseTask,
    resumeTask,
    cancelTask,
    removeTask,
  } = useMiningTasks()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [supported, setSupported] = useState<SupportedInfo | null>(null)

  // 本机有运行/排队任务时拦截窗口关闭(Tauri onCloseRequested;浏览器 dev 回退
  // beforeunload)。关闭后任务自动转暂停,重开应用可恢复继续。
  useEffect(() => {
    const localActive = tasks.some(
      (t) => t.origin === "local" && (t.status === "running" || t.status === "pending"),
    )
    if (!localActive) return
    let cleanup: () => void = () => {}
    let disposed = false
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        const unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          const ok = window.confirm(
            "有本机挖掘任务正在运行或排队，关闭窗口后任务将自动暂停（重新打开应用可恢复继续）。确定关闭吗？",
          )
          if (!ok) await event.preventDefault()
        })
        if (disposed) unlisten()
        else cleanup = unlisten
      } catch {
        // 非 Tauri 环境(dev 浏览器)或无窗口权限:退回 beforeunload
        const handler = (e: BeforeUnloadEvent) => {
          e.preventDefault()
          e.returnValue = ""
        }
        window.addEventListener("beforeunload", handler)
        cleanup = () => window.removeEventListener("beforeunload", handler)
      }
    })()
    return () => {
      disposed = true
      cleanup()
    }
  }, [tasks])

  useEffect(() => {
    void (async () => {
      try {
        const info = await fetchSupported()
        setSupported(info)
      } catch {
        // 忽略，表单仍可用
      }
    })()
  }, [])

  return (
    <div className="p-4 space-y-4 max-w-[1400px] mx-auto">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">
          超级因子挖掘
        </h1>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          超长历史因子挖掘。服务器任务后台长程运行、关闭软件也继续；本地任务
          在本机运行（GPU 粗排 + 内核精算或纯 CPU，免配额），关闭软件自动暂停。
          恢复时以历史最优因子作为种子进入新种群继续搜索。
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* 左侧：配置 + 任务列表 */}
        <div className="lg:col-span-2 space-y-4">
          <MiningConfigForm
            supported={supported}
            disabled={loading}
            onSubmit={async (p) => {
              try {
                await createTask(
                  {
                    symbol: p.symbol,
                    timeframe: p.timeframe,
                    population: p.population,
                    generations: p.generations,
                    max_depth: p.max_depth,
                    train_ratio: p.train_ratio,
                    walk_forward_folds: p.walk_forward_folds,
                    ...(p.origin === "local" && p.islands > 1 ? { islands: p.islands } : {}),
                    ...(p.llmSeedTokens?.length ? { seed_tokens: p.llmSeedTokens } : {}),
                    ...(p.crossPeers?.length ? { cross_peers: p.crossPeers } : {}),
                    // 本地增强仅本地任务(服务端 CreateTaskPayload 不含这些字段)
                    ...(p.origin === "local" && p.enhanced
                      ? { selection_v2: true, evolve_v2: true }
                      : {}),
                    ...(p.origin === "local" && p.liveGate ? { live_entry_gate: LIVE_GATE_ENTRY } : {}),
                    data_channel: p.data_channel,
                  },
                  { device: p.device, name: p.name },
                  p.origin,
                )
              } catch {
                /* hook 已 setError */
              }
            }}
          />
          {error && (
            <div className="text-xs text-red-500 px-2">{error}</div>
          )}
          <TaskListPanel
            tasks={tasks}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onPause={pauseTask}
            onResume={resumeTask}
            onCancel={cancelTask}
            onDelete={removeTask}
          />
        </div>

        {/* 右侧：选中任务详情 */}
        <div className="lg:col-span-3">
          {selectedId ? (
            <TaskDetailPanel
              taskId={selectedId}
              tasks={tasks}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)] h-full flex items-center justify-center">
              从左侧选择任务查看进度与结果
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 配置表单 ──────────────────────────────────────────────

interface ConfigFormProps {
  supported: SupportedInfo | null
  disabled: boolean
  onSubmit: (p: {
    symbol: string
    timeframe: string
    population: number
    generations: number
    max_depth: number
    train_ratio: number
    walk_forward_folds: number
    islands: number
    origin: RunnerKind
    device: DeviceKind
    name: string
    /** LLM 生成的种子候选(表单提交前已生成并校验) */
    llmSeedTokens?: number[][]
    /** 跨币种验证伙伴(表单提交前已预加载):[[币种代码, bars], ...] */
    crossPeers?: Array<[string, Array<Record<string, unknown>>]>
    /** 增强挖掘(selection_v2 + evolve_v2,仅本地) */
    enhanced: boolean
    /** 实盘开仓口径验证(live_entry_gate,仅本地) */
    liveGate: boolean
    /** 数据渠道(okx/binance_spot/gate_spot;bars 快照与跨币种伙伴同渠道) */
    data_channel: string
  }) => Promise<void>
}

/** 实盘开仓口径门槛:与实盘因子策略默认开仓阈值一致 */
const LIVE_GATE_ENTRY = 0.3

function MiningConfigForm(props: ConfigFormProps): React.JSX.Element {
  const { supported, disabled, onSubmit } = props
  const [symbol, setSymbol] = useState("")
  const [dataChannel, setDataChannel] = useState<string>(DEFAULT_KLINE_CHANNEL)
  const [timeframe, setTimeframe] = useState("1d")
  // 执行位置:服务器计算机 / 本地计算机;本地再选算力(自动/CPU/GPU)
  const [origin, setOrigin] = useState<RunnerKind>("remote")
  const [device, setDevice] = useState<DeviceKind>("auto")
  // GPU 可用性探测(置灰 GPU 选项并给出原因)
  const [gpuAvailable, setGpuAvailable] = useState<boolean | null>(null)
  const [gpuReason, setGpuReason] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void import("@/lib/mining/device")
      .then(({ probeGpu }) => probeGpu())
      .then((r) => {
        if (cancelled) return
        setGpuAvailable(r.available)
        setGpuReason(r.reason ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  // 数字输入用 string 存原始文本，让用户能自由编辑（清空、临时非法值）；
  // onBlur 和提交时才解析+clamp 到合法范围。避免输入过程中被立即 clamp 的卡顿。
  const [population, setPopulation] = useState("40")
  const [generations, setGenerations] = useState("30")
  const [maxDepth, setMaxDepth] = useState("4")
  const [trainRatio, setTrainRatio] = useState("0.7")
  const [walkForwardFolds, setWalkForwardFolds] = useState("3")
  const [islands, setIslands] = useState("1")
  // LLM 种子(路线 B 本地化,M5):本地直连 LLM 生成候选注入种群头部
  const [useLlmSeed, setUseLlmSeed] = useState(false)
  const [llmHint, setLlmHint] = useState("")
  const [llmError, setLlmError] = useState<string | null>(null)
  const [llmReady, setLlmReady] = useState<boolean | null>(null)
  // 跨币种验证(深挖强化):同板块 1-4 个伙伴币种联合验证冠军
  const [useCrossValidate, setUseCrossValidate] = useState(false)
  const [crossCount, setCrossCount] = useState(4)
  const [crossError, setCrossError] = useState<string | null>(null)
  const [crossStatus, setCrossStatus] = useState<string | null>(null)
  // 本地增强挖掘(默认开:基准评测封存期表现优于原版)/实盘开仓口径验证(默认关)
  const [enhanced, setEnhanced] = useState(true)
  const [liveGate, setLiveGate] = useState(false)
  // 当前命中的搜索力度预设;手动改参数后置 null(自定义)
  const [presetId, setPresetId] = useState<string | null>("standard")
  const [submitting, setSubmitting] = useState(false)

  // 本地直连可用性(未配置则置灰开关并提示入口)
  useEffect(() => {
    let cancelled = false
    void import("@/lib/local-ai").then(({ getActiveLocalAi }) => {
      if (!cancelled) setLlmReady(getActiveLocalAi() != null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** 应用预设:一键填入种群/代数/树深/岛数 */
  function applyPreset(p: MiningPreset): void {
    setPopulation(String(p.population))
    setGenerations(String(p.generations))
    setMaxDepth(String(p.maxDepth))
    setIslands(String(p.islands))
    setPresetId(p.id)
  }

  const tfs: SupportedTimeframe[] = supported?.timeframes ?? [
    { value: "1d", label: "日线", long_history: true, note: "" },
  ]
  const curTf = tfs.find((t) => t.value === timeframe)

  /** 解析输入框值为整数并 clamp 到 [lo,hi]；空/非法返回 def */
  function clampInt(s: string, lo: number, hi: number, def: number): number {
    const n = parseInt(s, 10)
    if (Number.isNaN(n)) return def
    return Math.max(lo, Math.min(hi, n))
  }
  /** 解析输入框值为浮点并 clamp 到 [lo,hi]；空/非法返回 def */
  function clampFloat(s: string, lo: number, hi: number, def: number): number {
    const n = parseFloat(s)
    if (Number.isNaN(n)) return def
    return Math.max(lo, Math.min(hi, n))
  }

  const [symbolError, setSymbolError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!symbol.trim()) {
      setSymbolError("请先选择币种")
      return
    }
    setSymbolError(null)
    setSubmitting(true)
    try {
      // LLM 种子生成(提交前完成,失败中止创建——用户明确要种子,静默降级会误导)
      let llmSeedTokens: number[][] | undefined
      if (origin === "local" && useLlmSeed) {
        setLlmError(null)
        try {
          const { localLlmGenerateFactors } = await import("@/lib/llm-factor-seed")
          const seed = await localLlmGenerateFactors({
            symbol: symbol.trim().toLowerCase(),
            timeframe,
            ...(llmHint.trim() ? { hint: llmHint.trim() } : {}),
          })
          if (seed.tokens.length === 0) {
            throw new Error("模型未给出合法公式候选（token 校验全被过滤）")
          }
          llmSeedTokens = seed.tokens
        } catch (e) {
          setLlmError(`LLM 种子生成失败：${e instanceof Error ? e.message : String(e)}`)
          return
        }
      }
      // 跨币种验证:提交前预加载同板块伙伴 K 线(失败中止,用户明确开启了开关)
      let crossPeers: Array<[string, Array<Record<string, unknown>>]> | undefined
      if (origin === "local" && useCrossValidate) {
        setCrossError(null)
        setCrossStatus("正在准备跨币种验证…")
        try {
          const { loadCrossPeers } = await import("./cross-validate")
          const bundle = await loadCrossPeers({
            symbol: symbol.trim().toLowerCase(),
            timeframe,
            count: crossCount,
            channel: dataChannel,
            onProgress: (msg) => setCrossStatus(msg),
          })
          crossPeers = bundle.peers
          setCrossStatus(`${bundle.note}（${bundle.peers.length} 个伙伴已就绪）`)
        } catch (e) {
          setCrossStatus(null)
          setCrossError(e instanceof Error ? e.message : String(e))
          return
        }
      }
      await onSubmit({
        symbol: symbol.trim().toLowerCase(),
        timeframe,
        population: clampInt(population, 10, 30000, 40),
        generations: clampInt(generations, 3, 1000, 30),
        max_depth: clampInt(maxDepth, 2, 6, 4),
        train_ratio: clampFloat(trainRatio, 0, 0.9, 0.7),
        walk_forward_folds: clampInt(walkForwardFolds, 0, 6, 3),
        islands: clampInt(islands, 1, 8, 1),
        origin,
        device: origin === "local" ? device : "cpu",
        name: origin === "local" ? `本挖·${symbol}·${timeframe}` : `超挖·${symbol}·${timeframe}`,
        ...(llmSeedTokens?.length ? { llmSeedTokens } : {}),
        ...(crossPeers?.length ? { crossPeers } : {}),
        enhanced,
        liveGate,
        data_channel: dataChannel,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3"
    >
      <div className="text-sm font-medium text-[var(--text-secondary)]">
        新建挖掘任务
      </div>

      <div className="space-y-1.5">
        <Label>币种</Label>
        <MiningSymbolCombobox
          value={symbol}
          onChange={(v) => {
            setSymbol(v)
            if (v.trim()) setSymbolError(null)
          }}
        />
        {symbolError && <p className="text-[11px] text-down">{symbolError}</p>}
      </div>

      <div className="space-y-1.5">
        <Label>数据渠道</Label>
        <DataChannelSelect
          value={dataChannel}
          onChange={(v) => setDataChannel(v)}
          symbol={symbol.trim().toLowerCase() || null}
          timeframe={timeframe}
        />
      </div>

      <div className="space-y-1">
        <Label>周期</Label>
        <div className="flex flex-wrap gap-1">
          {tfs.map((tf) => (
            <button
              key={tf.value}
              type="button"
              onClick={() => setTimeframe(tf.value)}
              className={cn(
                "px-2 py-1 rounded text-[11px] border transition-colors",
                timeframe === tf.value
                  ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
              title={tf.note}
            >
              {tf.label}
              {tf.long_history && (
                <span className="ml-1 text-[9px] text-emerald-500">超长</span>
              )}
            </button>
          ))}
        </div>
        {curTf && !curTf.long_history && (
          <p className="text-[10px] text-amber-500">{curTf.note}</p>
        )}
      </div>

      {/* 执行位置:本地算力组(自动/CPU/GPU)仅在本地时出现;M3 本地仅 CPU,
          GPU 属 M4,不渲染选项。服务端挖掘一律 CPU(产品范围约束)。 */}
      <div className="space-y-1">
        <Label>执行位置</Label>
        <div className="flex flex-wrap gap-1">
          {(
            [
              { value: "remote", label: "服务器计算机" },
              { value: "local", label: "本地计算机" },
            ] as const
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setOrigin(o.value)}
              className={cn(
                "px-2 py-1 rounded text-[11px] border transition-colors",
                origin === o.value
                  ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          {origin === "remote"
            ? "服务器长程运行，关闭软件也继续；受配额限制，可用超长历史。"
            : "本机运行，免配额；本机同时只跑 1 个任务，其余排队。关闭软件自动暂停，可恢复继续（以历史最优因子为种子进入新种群）。历史 K 线同样从服务器拉取。"}
        </p>
      </div>

      {/* 本地算力组:仅在执行位置=本地时出现(服务端一律 CPU,不渲染该组)。
          GPU = WebGPU 粗排 + 本地内核精算;不可用时置灰并提示原因。 */}
      {origin === "local" && (
        <div className="space-y-1">
          <Label>本地算力</Label>
          <div className="flex flex-wrap gap-1">
            {(
              [
                { value: "auto", label: "自动" },
                { value: "cpu", label: "CPU" },
                { value: "gpu", label: "GPU" },
              ] as const
            ).map((o) => {
              const on = device === o.value
              const disabled = o.value === "gpu" && gpuAvailable === false
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => setDevice(o.value)}
                  title={
                    o.value === "gpu"
                      ? disabled
                        ? `GPU 不可用：${gpuReason ?? "未探测到 WebGPU"}`
                        : "WebGPU(f32)粗排 + 本地内核(f64)精算；冠军指标与 CPU 口径一致"
                      : o.value === "auto"
                        ? "自动选择：GPU 可用则用 GPU，否则 CPU"
                        : "单 Pyodide worker，与服务端内核逐位一致"
                  }
                  className={cn(
                    "px-2 py-1 rounded text-[11px] border transition-colors",
                    on
                      ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--text-muted)]",
                  )}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 搜索力度预设:一键填入参数组合,手动改动后显示「自定义」 */}
      <PresetPicker value={presetId} onPick={applyPreset} />

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>种群（10-30000）</Label>
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            每一代同时尝试多少个因子公式。本地 GPU 大种群一批粗排(强显卡可上万),建议按预设填。
          </p>
          <input
            type="number"
            inputMode="numeric"
            value={population}
            onChange={(e) => {
              setPopulation(e.target.value)
              setPresetId(null)
            }}
            onBlur={() => setPopulation(String(clampInt(population, 10, 30000, 40)))}
            placeholder="40"
            className="w-full h-9 px-3 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
          />
        </div>
        <div className="space-y-1">
          <Label>代数（3-1000）</Label>
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            迭代多少轮。每轮保留好因子再衍生新公式,越多越易找到优解;长跑可随时暂停续挖。
          </p>
          <input
            type="number"
            inputMode="numeric"
            value={generations}
            onChange={(e) => {
              setGenerations(e.target.value)
              setPresetId(null)
            }}
            onBlur={() => setGenerations(String(clampInt(generations, 3, 1000, 30)))}
            placeholder="30"
            className="w-full h-9 px-3 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label>树深（2-6）</Label>
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            因子公式最复杂能到几层嵌套。越深越灵活但越易过拟合，建议 4。
          </p>
          <input
            type="number"
            inputMode="numeric"
            value={maxDepth}
            onChange={(e) => {
              setMaxDepth(e.target.value)
              setPresetId(null)
            }}
            onBlur={() => setMaxDepth(String(clampInt(maxDepth, 2, 6, 4)))}
            placeholder="4"
            className="w-full h-9 px-3 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
          />
        </div>
        <div className="space-y-1">
          <Label>训练比例（0-0.9）</Label>
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            历史数据按多大比例做训练，剩下留作验证。0.7 = 前70%训练、后30%验证，建议 0.7。
          </p>
          <input
            type="number"
            inputMode="decimal"
            step={0.05}
            value={trainRatio}
            onChange={(e) => setTrainRatio(e.target.value)}
            onBlur={() => setTrainRatio(String(clampFloat(trainRatio, 0, 0.9, 0.7)))}
            placeholder="0.7"
            className="w-full h-9 px-3 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
          />
        </div>
        <div className="space-y-1">
          <Label>WF折数（0-6）</Label>
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            把历史切几段滚动验证，要求每段都赚钱才算数，越严越不易过拟合。0=关闭，建议 3。
          </p>
          <input
            type="number"
            inputMode="numeric"
            value={walkForwardFolds}
            onChange={(e) => setWalkForwardFolds(e.target.value)}
            onBlur={() =>
              setWalkForwardFolds(String(clampInt(walkForwardFolds, 0, 6, 3)))
            }
            placeholder="3"
            className="w-full h-9 px-3 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
          />
        </div>
      </div>

      {/* 岛数:分岛并行进化提高多样性(环状迁移);仅本地 GPU 路径生效,
          CPU(与服务端逐位一致)与服务器任务忽略该参数 */}
      {origin === "local" && (
        <div className="space-y-1">
          <Label>岛数（1-8，GPU 深挖用）</Label>
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            种群分成 N 个岛独立进化、定期交换好因子，显著提高多样性、降低早熟。
            仅本地 GPU 生效；本地 CPU 与服务器任务自动忽略。
          </p>
          <input
            type="number"
            inputMode="numeric"
            value={islands}
            onChange={(e) => {
              setIslands(e.target.value)
              setPresetId(null)
            }}
            onBlur={() => setIslands(String(clampInt(islands, 1, 8, 1)))}
            placeholder="1"
            className="w-full h-9 px-3 text-xs font-num rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
          />
        </div>
      )}

      {/* LLM 种子(路线 B 本地化,M5):本地直连 LLM 生成候选注入种群头部,
          「LLM 直觉 + GPU 暴力」混合搜索;未配置本地直连时置灰 */}
      {origin === "local" && (
        <div className="space-y-1">
          <Label>LLM 种子（可选）</Label>
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={useLlmSeed}
              disabled={llmReady !== true}
              onChange={(e) => {
                setUseLlmSeed(e.target.checked)
                setLlmError(null)
              }}
            />
            用本地直连大模型生成候选公式，注入种群当种子
          </label>
          {llmReady !== true && (
            <p className="text-[10px] text-amber-500">
              本地直连未配置：在 AI 聊天面板开启「本地直连」并填好 Key/模型后可用。
            </p>
          )}
          {useLlmSeed && (
            <input
              type="text"
              value={llmHint}
              onChange={(e) => setLlmHint(e.target.value)}
              placeholder="挖掘思路提示（可选），如「关注夜盘持仓变化」"
              className="w-full h-9 px-3 text-xs rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary)]"
            />
          )}
          {llmError && <p className="text-[10px] text-down">{llmError}</p>}
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            提交时先由大模型给出 6-10 条候选公式（token 严格校验，非法自动丢弃），
            与随机种群一起进入进化——模型直觉提供多样化起点，GPU 负责大规模精炼。
          </p>
        </div>
      )}

      {/* 跨币种验证(深挖强化):开启后冠军须通过同板块 1-4 个伙伴币种的
          样本外联合验证(≥⌈K/2⌉ 个 sortino>0),过拟合因子在兄弟币种上现形 */}
      {origin === "local" && (
        <div className="space-y-1">
          <Label>跨币种验证（可选）</Label>
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={useCrossValidate}
              onChange={(e) => {
                setUseCrossValidate(e.target.checked)
                setCrossError(null)
              }}
            />
            冠军须通过同板块伙伴币种的联合验证
          </label>
          {useCrossValidate && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--text-muted)]">伙伴数量</span>
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setCrossCount(n)}
                  className={cn(
                    "w-6 h-6 rounded text-[11px] border transition-colors font-num",
                    crossCount === n
                      ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          {crossError && <p className="text-[10px] text-down">{crossError}</p>}
          {crossStatus && !crossError && (
            <p className="text-[10px] text-[var(--primary)]">{crossStatus}</p>
          )}
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            自动选取同板块流动性前 N 个币种（提交时拉取其 K 线，数据不足的自动跳过）。
            要求至少一半伙伴币种上因子不亏——只在单一币种上灵的公式大概率是巧合，
            联合验证显著压低过拟合，但冠军数也会减少。
          </p>
        </div>
      )}

      {/* 增强挖掘(本地专属):遴选先按行为去重、测试段切出封存段只评估一次、
          进化加点/收缩变异与克隆降权。关闭时与服务端内核逐位一致 */}
      {origin === "local" && (
        <div className="space-y-1">
          <Label>增强挖掘（本地）</Label>
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={enhanced}
              onChange={(e) => setEnhanced(e.target.checked)}
            />
            启用增强遴选与进化（推荐）
          </label>
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            先把同一因子的不同写法去重，再做样本外筛选；测试段后半封存，冠军选定后才评估一次（冠军表「封存Sortino」列）；
            进化加入点变异/收缩变异、克隆降权与停滞重启。关闭则与服务器挖掘结果逐位一致。
          </p>
          <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={liveGate}
              onChange={(e) => setLiveGate(e.target.checked)}
            />
            按实盘开仓口径验证（阈值 {LIVE_GATE_ENTRY}）
          </label>
          <p className="text-[10px] text-[var(--text-muted)] leading-tight">
            实盘按 ±1 手、信号超阈值才开仓；开启后冠军须在验证段按此口径也赚钱，排除「模拟赚钱、实盘不开仓」的弱信号因子。
          </p>
        </div>
      )}

      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed bg-[var(--bg-tertiary)] rounded-md p-2">
        💡 不知道怎么填？用「标准」预设即可。想挖更优：本地 GPU + 深度/极限预设
        （试验数放大 15~120 倍，长跑可随时暂停续挖）。超长历史（几千根）建议
        先关 WF（设0）避免计算过重。
      </p>

      <Button type="submit" disabled={disabled || submitting} className="w-full">
        {submitting ? (
          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
        ) : (
          <Plus className="w-4 h-4 mr-1" />
        )}
        开始挖掘
      </Button>
    </form>
  )
}

// ── 任务列表 ──────────────────────────────────────────────

interface TaskListProps {
  tasks: MiningTask[]
  selectedId: string | null
  onSelect: (id: string) => void
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  onDelete: (id: string) => void
}

function TaskListPanel(props: TaskListProps): React.JSX.Element {
  const { tasks, selectedId, onSelect, onPause, onResume, onCancel, onDelete } =
    props
  if (tasks.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-xs text-[var(--text-muted)]">
        暂无挖掘任务
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] divide-y divide-[var(--border)] overflow-hidden">
      {tasks.map((t) => {
        const on = selectedId === t.id
        const active = t.status === "running" || t.status === "pending"
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={cn(
              "p-3 cursor-pointer transition-colors",
              on ? "bg-[var(--primary)]/10" : "hover:bg-[var(--bg-tertiary)]",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-[var(--text-primary)] truncate">
                  {t.name}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] font-num flex items-center gap-1 flex-wrap">
                  <span>{t.symbol} · {t.timeframe} · {t.bars_count}根</span>
                  <span className="px-1 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {t.origin === "local" ? "本机" : "服务器"}
                  </span>
                  {/* 服务器行恒为 CPU(服务端一律 CPU);本地行显示实际算力 */}
                  <span className="px-1 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {(t.effectiveDevice ?? "cpu").toUpperCase()}
                  </span>
                </div>
              </div>
              <span
                className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] shrink-0",
                  STATUS_STYLE[t.status],
                )}
              >
                {STATUS_LABEL[t.status]}
              </span>
            </div>
            {/* 进度条 */}
            <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
              <div
                className="h-full bg-[var(--primary)] transition-all"
                style={{ width: `${t.progress_pct}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--text-muted)] font-num">
              <span>
                代 {t.current_generation}/{t.generations}
              </span>
              <span>{t.progress_pct}%</span>
            </div>
            {/* 操作按钮 */}
            <div
              className="mt-2 flex gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              {active && (
                <button
                  type="button"
                  onClick={() => onPause(t.id)}
                  className="px-1.5 py-0.5 rounded text-[10px] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] flex items-center gap-0.5"
                >
                  <Pause className="w-2.5 h-2.5" /> 暂停
                </button>
              )}
              {t.status === "paused" && (
                <button
                  type="button"
                  onClick={() => onResume(t.id)}
                  title={/* 决策记录 D-1:如实措辞,不宣称精确续训 */
                    `从第 ${t.current_generation} 代继续，历史最优因子作为种子进入新种群`}
                  className="px-1.5 py-0.5 rounded text-[10px] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] flex items-center gap-0.5"
                >
                  <Play className="w-2.5 h-2.5" /> 恢复
                </button>
              )}
              {!["completed", "cancelled", "failed"].includes(t.status) && (
                <button
                  type="button"
                  onClick={() => onCancel(t.id)}
                  className="px-1.5 py-0.5 rounded text-[10px] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] flex items-center gap-0.5"
                >
                  <Square className="w-2.5 h-2.5" /> 取消
                </button>
              )}
              {!active && (
                <button
                  type="button"
                  onClick={() => onDelete(t.id)}
                  className="px-1.5 py-0.5 rounded text-[10px] border border-red-500/30 text-red-500 hover:bg-red-500/10 flex items-center gap-0.5"
                >
                  <Trash2 className="w-2.5 h-2.5" /> 删除
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 任务详情（进度 + 冠军结果） ──────────────────────────

interface DetailProps {
  taskId: string
  tasks: MiningTask[]
  onClose: () => void
}

function TaskDetailPanel(props: DetailProps): React.JSX.Element {
  const { taskId, tasks, onClose } = props
  const task = tasks.find((t) => t.id === taskId)
  const { champions } = useTaskChampions(
    task?.status === "completed" ? task : null,
  )

  // 已收藏 tokens_key 集合（冠军表行变灰、按钮禁用，避免重复收藏）
  const [favoritedKeys, setFavoritedKeys] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (task?.status !== "completed") {
      setFavoritedKeys(new Set())
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const favs = await listFactorFavorites(task.symbol)
        if (cancelled) return
        const set = new Set<string>()
        for (const f of favs) {
          if (f.tokens?.length) set.add(f.tokens.join(","))
        }
        setFavoritedKeys(set)
      } catch {
        // 收藏列表加载失败不阻塞查看冠军
      }
    })()
    return () => {
      cancelled = true
    }
  }, [task?.status, task?.symbol, taskId])

  // 收藏冠军因子（复用 factor_lab 收藏 API，两个页面因子库打通）
  async function handleFavorite(c: Champion): Promise<void> {
    if (!task) return
    // 本地专属特征公式服务端无法回放,禁止收藏同步(挂本地引擎任务不受影响)
    if (isLocalOnly(c.tokens, c.metrics)) {
      await showAlert({
        title: "不支持收藏",
        description: "该公式含本地专属特征，仅本机可执行，不支持收藏同步",
      })
      return
    }
    const key = c.tokens.join(",")
    // 本地立即置灰，避免重复点击
    setFavoritedKeys((prev) => new Set(prev).add(key))
    try {
      await addFactorFavorite({
        tokens: c.tokens,
        text: c.text,
        symbol: task.symbol,
        timeframe: task.timeframe,
        composite: c.composite,
        metrics: c.metrics,
        name: `超挖·${task.symbol}·${task.timeframe}`,
      })
      await showAlert({ title: "已收藏", description: "可在因子实验室收藏面板查看" })
    } catch (e) {
      // 失败回退本地置灰
      setFavoritedKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      await showAlert({
        title: "收藏失败",
        description: e instanceof Error ? e.message : "收藏失败",
        variant: "destructive",
      })
    }
  }

  if (!task) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
        任务不存在
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-[var(--text-primary)]">
            {task.name}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] font-num">
            {task.symbol} · {task.timeframe} · 数据 {task.data_range_from} ~{" "}
            {task.data_range_to} ({task.bars_count}根)
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 进度 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Stat label="状态" value={STATUS_LABEL[task.status]} />
        <Stat
          label="进度"
          value={`${task.current_generation}/${task.generations} 代 (${task.progress_pct}%)`}
        />
        <Stat
          label="当前最优分"
          value={task.best_composite.toFixed(2)}
        />
        <Stat label="冠军数" value={String(task.champions_count)} />
        {(() => {
          const tm = taskTiming(task)
          if (tm.elapsed == null) return null
          return (
            <>
              <Stat label={tm.elapsedLabel} value={fmtDuration(tm.elapsed)} />
              {tm.perGen != null && <Stat label="每代均耗" value={fmtDuration(tm.perGen)} />}
              {tm.eta != null && <Stat label="预计剩余" value={`约 ${fmtDuration(tm.eta)}`} />}
            </>
          )
        })()}
      </div>

      {/* 应用阶段耗时不是硬件利用率;缓存命中不计入 GPU 实际计算量。 */}
      {task.effectiveDevice === "gpu" && task.gpu_stats && (() => {
        const g = task.gpu_stats
        const perGen = task.current_generation > 0 && task.elapsed_ms != null
          ? task.elapsed_ms / task.current_generation
          : null
        return (
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] font-num flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-[var(--text-secondary)] font-medium">GPU 活动</span>
            <span title="唯一候选的提交与读回墙钟耗时,不是 GPU 硬件忙碌时间或利用率">
              GPU 实算 <span className="text-emerald-500">{g.gpuEvaluated ?? Math.max(0, g.evaluated - g.cacheHits)}</span> 条/代
              （缓存命中 {g.cacheHits}）· 提交及读回 {g.rankMs}ms
            </span>
            <span title="批缓冲(tile×栈层×T)估算;系统监控里的总显存还包括 WebView2 基础占用">
              显存 ~{g.gpuMemMB}MB
            </span>
            <span title="精算名单内的候选全部由内核 f64 重算;GPU 只负责排序选名单,其数字不出现在任何结果里">
              精算 内核 f64 验证{g.preciseMs != null ? ` ${g.preciseMs}ms` : ""}
            </span>
            {perGen != null && (
              <span>每代均耗 {perGen < 1000 ? `${Math.round(perGen)}ms` : `${(perGen / 1000).toFixed(2)}s`}</span>
            )}
          </div>
        )
      })()}

      {/* 错误信息 */}
      {task.error_msg && (
        <div className="text-xs text-red-500 bg-red-500/10 rounded p-2">
          {task.error_msg}
        </div>
      )}

      {/* 暂停原因(应用重启自动暂停 / 计算中断自动暂停) */}
      {task.pause_reason && (
        <div className="text-xs text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded p-2">
          {task.pause_reason}
        </div>
      )}

      {/* 冠军结果（仅完成时） */}
      {task.status === "completed" && (
        <div className="space-y-2">
          <div className="text-xs text-[var(--text-secondary)]">
            冠军因子（含训练/测试双指标）
          </div>
          {/* 组合推荐:等权/IC 加权 vs 最优单因子(完成时自动评估;M4) */}
          {task.portfolio && <PortfolioCard portfolio={task.portfolio} />}
          <ChampionTable champions={champions} selectedTokens={null} onSelect={() => {}} onFavorite={handleFavorite} favoritedKeys={favoritedKeys} />
        </div>
      )}

      {task.status !== "completed" && (
        <div className="text-xs text-[var(--text-muted)] text-center py-4">
          {task.status === "running" || task.status === "pending"
            ? "挖掘进行中，完成后显示冠军因子…"
            : task.status === "failed"
              ? "任务失败"
              : "任务已停止"}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--border)] p-2">
      <div className="text-[10px] text-[var(--text-muted)]">{label}</div>
      <div className="text-sm font-num text-[var(--text-primary)]">{value}</div>
    </div>
  )
}
