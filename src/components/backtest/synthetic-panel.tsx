"use client"

/**
 * AI 生成 K 线 · 生成配置面板
 *
 * 用户选择：策略/因子 + AI 模型（生成剧本用）+ K 线周期 + 生成天数（默认填满周期上限）+
 * 目标品种（决定价格量级）+ 回放速度。点击「生成 K 线」后回调 onGenerated。
 */

import { NumericInput } from "@/components/ui/numeric-input"
import { useEffect, useState } from "react"
import { Sparkles, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { SymbolPicker } from "@/components/ai-trading/form/symbol-picker"
import { StrategySection } from "@/components/backtest/backtest-form-fields"
import {
  AiFundStyleFields,
  DEFAULT_AI_FUND_STYLE,
  type AiFundStyleState,
} from "@/components/ai-trading/form/ai-fund-style-fields"
import { getAIModels } from "@/lib/api"
import { chatModelsOnly, decisionModelsOnly } from "@/lib/decision-model"
import {
  DEFAULT_QUANT_PARAMS,
  buildStrategyParams,
  type QuantParamsState,
} from "@/lib/quant-strategy"
import { TIMEFRAME_MAX_DAYS } from "@/components/backtest/timeframe-limits"
import type { AIModel } from "@/types"
import {
  generateKlineApi,
  type SyntheticGenerateResponse,
} from "@/lib/backtest-api"

/** K 线周期每交易日的根数（与后端 BARS_PER_DAY 一致） */
const BARS_PER_DAY: Record<string, number> = {
  "1d": 1,
  "240m": 6,
  "60m": 4,
  "30m": 8,
  "15m": 16,
  "5m": 48,
  "1m": 240,
}

const TIMEFRAMES = ["1d", "240m", "60m", "30m", "15m", "5m", "1m"] as const

/** 从面板收集的回放所需全部配置 */
export interface SyntheticReplayConfig {
  generated: SyntheticGenerateResponse
  strategyType:
    | "ai"
    | "ma_cross"
    | "n_breakout"
    | "macd_cross"
    | "kdj_cross"
    | "band_swing"
    | "swing_pivot"
    | "factor"
  strategyParams: Record<string, unknown> | null
  modelRowId: string | null
  symbol: string
  symbolName: string
  timeframe: string
  sideMode: string
  fixedQty: number
  initialCash: number
  riskStyle: string
  customPromptEnabled: boolean
  customPrompt: string | null
  closeRules: Record<string, unknown>
  stopRules: Record<string, unknown>
  speedMs: number
  /** 决策模型（Jev）：策略信号作为参考输入，模型做最终投资判断 */
  decisionModelRowId: string | null
}

interface SyntheticPanelProps {
  onGenerated: (cfg: SyntheticReplayConfig) => void
  /** 是否有回放进行中（用于提示"重新生成会中断当前回放"） */
  busy?: boolean
}

export function SyntheticPanel({
  onGenerated,
  busy = false,
}: SyntheticPanelProps): React.JSX.Element {
  const [mode, setMode] = useState<"quant" | "ai">("quant")
  const [quant, setQuant] = useState<QuantParamsState>(DEFAULT_QUANT_PARAMS)
  const [models, setModels] = useState<AIModel[]>([])
  const [genModelId, setGenModelId] = useState("")
  // 决策模型（与生成剧本的 AI 模型独立）：策略信号喂给 Jev，模型做最终判断
  const [decisionEnabled, setDecisionEnabled] = useState(false)
  // 决策模型自主止损：默认开；关闭则拦截模型平仓（硬止损%仍生效）
  const [modelStop, setModelStop] = useState(true)
  const [decisionModels, setDecisionModels] = useState<AIModel[]>([])
  const [decisionModelId, setDecisionModelId] = useState("")
  const [symbol, setSymbol] = useState("")
  const [symbolName, setSymbolName] = useState("")
  const [timeframe, setTimeframe] = useState<string>("1d")
  const [sideMode, setSideMode] = useState("both")
  const [fixedQty, setFixedQty] = useState(1)
  const [initialCash, setInitialCash] = useState(1_000_000)
  const [speedMs, setSpeedMs] = useState(3000)
  const [lossPct, setLossPct] = useState("")
  const [pnlPct, setPnlPct] = useState("")
  const [fundStyle, setFundStyle] =
    useState<AiFundStyleState>(DEFAULT_AI_FUND_STYLE)
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  // 生成剧本的 AI 模型始终需要（与交易策略类型无关），进面板就加载
  useEffect(() => {
    void getAIModels()
      .then((list) => {
        const chat = chatModelsOnly(list)
        setModels(chat)
        if (chat.length && !genModelId) setGenModelId(chat[0].id)
        const decision = decisionModelsOnly(list)
        setDecisionModels(decision)
        if (decision.length && !decisionModelId) setDecisionModelId(decision[0].id)
      })
      .catch(() => setModels([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 生成天数默认 = 当前周期允许的最大值
  const maxDays = TIMEFRAME_MAX_DAYS[timeframe] ?? 30
  const [numDays, setNumDays] = useState(maxDays)

  // 切换周期：天数同步重置为新周期上限
  function changeTimeframe(tf: string): void {
    setTimeframe(tf)
    setNumDays(TIMEFRAME_MAX_DAYS[tf] ?? 30)
  }

  const barsPerDay = BARS_PER_DAY[timeframe] ?? 1
  const estBars = numDays * barsPerDay

  async function handleGenerate(): Promise<void> {
    setError(null)
    if (!genModelId) {
      setError("请选择用于生成剧本的 AI 模型")
      return
    }
    setGenerating(true)
    try {
      const generated = await generateKlineApi({
        model_row_id: genModelId,
        symbol: symbol.trim().toLowerCase(),
        symbol_name: symbolName,
        timeframe,
        num_days: numDays,
      })
      if (mode === "quant" && decisionEnabled && !decisionModelId) {
        setError("请选择决策模型")
        return
      }
      const strategyType = (mode === "ai" ? "ai" : quant.quantKind) as SyntheticReplayConfig["strategyType"]
      const strategyParams = mode === "ai" ? null : buildStrategyParams(quant)
      onGenerated({
        generated,
        strategyType,
        strategyParams,
        modelRowId: mode === "ai" ? genModelId : null,
        symbol: symbol.trim().toLowerCase(),
        symbolName,
        timeframe,
        sideMode,
        fixedQty,
        initialCash,
        riskStyle: mode === "ai" ? fundStyle.riskStyle : "balanced",
        customPromptEnabled:
          mode === "ai" ? fundStyle.customPromptEnabled : false,
        customPrompt:
          mode === "ai" && fundStyle.customPromptEnabled
            ? fundStyle.customPrompt.trim()
            : null,
        closeRules: {
          pnl_pct: pnlPct ? Number(pnlPct) : null,
          session_close: false,
        },
        stopRules: {
          loss_pct: lossPct ? Number(lossPct) : null,
          ...(decisionEnabled ? { ai_auto: modelStop } : {}),
        },
        speedMs,
        decisionModelRowId: mode === "quant" && decisionEnabled ? decisionModelId : null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败")
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 0) 生成剧本的 AI 模型（始终需要，与策略类型独立） */}
      <div className="space-y-2">
        <Label>AI 模型（生成剧本用）</Label>
        <select
          className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
          value={genModelId}
          onChange={(e) => setGenModelId(e.target.value)}
        >
          {models.length === 0 && <option value="">暂无可用模型</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name || m.model_id}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-[var(--text-muted)]">
          AI 只负责设计市场剧本（趋势/波动率），K 线由后端随机过程生成
        </p>
      </div>

      {/* 1) 策略/因子选择（与历史回测共用） */}
      <StrategySection
        mode={mode}
        onMode={setMode}
        timeframe={timeframe}
        quant={quant}
        onQuant={setQuant}
        models={models}
        modelRowId={genModelId}
        onModel={setGenModelId}
        symbol={symbol}
        onApplyFactorMeta={(sym, tf) => {
          if (sym && sym.trim()) {
            setSymbol(sym.trim().toLowerCase())
            setSymbolName("")
          }
          if (tf && tf.trim()) changeTimeframe(tf.trim())
        }}
      />

      {/* 1.5) 决策模型（仅量化策略：策略信号喂给 Jev，模型做最终投资判断） */}
      {mode === "quant" && (
        <div className="space-y-2 rounded-md border border-[var(--border)] p-2.5">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={decisionEnabled}
              onChange={(e) => setDecisionEnabled(e.target.checked)}
            />
            <span className="text-sm">决策模型</span>
            <span className="text-[10px] text-[var(--text-muted)]">
              量化策略给决策模型喂信号，模型做最终投资判断
            </span>
          </label>
          {decisionEnabled && (
            <div className="space-y-1">
              <Label>决策模型</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={decisionModelId}
                onChange={(e) => setDecisionModelId(e.target.value)}
              >
                {decisionModels.length === 0 && (
                  <option value="">未找到决策模型（需先在 AI 设置添加 Jev 渠道模型）</option>
                )}
                {decisionModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name || m.model_id} ({m.provider_name})
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-[var(--text-muted)]">
                只显示决策模型（TypeSafe Jev 渠道）。调用频率与「回放速度」一致：速度设多少秒，就多少秒调用一次（限 2-5 秒）；不足间隔的 K 线自动降级用策略信号。
              </p>
            </div>
          )}
        </div>
      )}

      {/* 2) 目标品种（决定价格量级） */}
      <SymbolPicker
        symbol={symbol}
        symbolName={symbolName}
        onChange={(sym, n) => {
          setSymbol(sym)
          setSymbolName(n)
        }}
      />

      {/* 3) 周期 + 生成天数 */}
      <div className="space-y-2">
        <Label>K 线周期</Label>
        <select
          className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
          value={timeframe}
          onChange={(e) => changeTimeframe(e.target.value)}
        >
          {TIMEFRAMES.map((t) => (
            <option key={t} value={t}>
              {t === "240m" ? "4小时" : t}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>生成天数</Label>
          <span className="text-[11px] text-[var(--text-muted)]">
            上限 {maxDays} 天 · 将生成约 {estBars.toLocaleString()} 根 K 线
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={maxDays}
          value={numDays}
          onChange={(e) => setNumDays(Number(e.target.value))}
          className="w-full accent-sky-500"
        />
      </div>

      {/* 4) 方向 + 手数 + 初始资金 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>方向</Label>
          <select
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
            value={sideMode}
            onChange={(e) => setSideMode(e.target.value)}
          >
            <option value="both">多空</option>
            <option value="long_only">仅多</option>
            <option value="short_only">仅空</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label>手数</Label>
          <NumericInput
            type="number"
            min={1}
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
            value={fixedQty}
            onChange={(e) => setFixedQty(Number(e.target.value || 1))}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>初始资金</Label>
        <NumericInput
          type="number"
          min={10000}
          step={10000}
          className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
          value={initialCash}
          onChange={(e) => setInitialCash(Number(e.target.value || 10000))}
        />
      </div>

      {/* 5) 回放速度 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>回放速度</Label>
          <span className="text-[11px] text-[var(--text-muted)]">
            {(speedMs / 1000).toFixed(1)} 秒/根
          </span>
        </div>
        <input
          type="range"
          min={2000}
          max={5000}
          step={500}
          value={speedMs}
          onChange={(e) => setSpeedMs(Number(e.target.value))}
          className="w-full accent-sky-500"
        />
      </div>

      {/* 6) AI 策略的资金风格 */}
      {mode === "ai" && (
        <AiFundStyleFields
          value={{ ...fundStyle, allocatedCapital: initialCash }}
          onChange={(next) => setFundStyle(next)}
          timeframe={timeframe}
        />
      )}

      {/* 6.5) 决策模型自主止损 */}
      {mode === "quant" && decisionEnabled && (
        <label className="flex items-center gap-2 rounded-md border border-[var(--border)] p-2.5 text-xs">
          <input
            type="checkbox"
            checked={modelStop}
            onChange={(e) => setModelStop(e.target.checked)}
          />
          决策模型自主止损
          <span className="text-[10px] text-[var(--text-muted)]">
            （模型依据持仓浮盈亏%自主判断止损；关闭则拦截模型平仓，下方固定止损%仍生效）
          </span>
        </label>
      )}

      {/* 7) 止损/止盈 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>止损 %（可选）</Label>
          <input
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
            value={lossPct}
            placeholder="留空不启用百分比止损"
            onChange={(e) => setLossPct(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>止盈 %（可选）</Label>
          <input
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
            value={pnlPct}
            placeholder="如 5"
            onChange={(e) => setPnlPct(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div className="text-sm text-[var(--accent-danger)]">{error}</div>
      )}

      <Button validateNumbers className="w-full" disabled={generating} onClick={() => void handleGenerate()}>
        {generating ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            正在让 AI 设计剧本…
          </>
        ) : busy ? (
          <>
            <Sparkles className="w-4 h-4 mr-2" />
            重新生成新 K 线
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4 mr-2" />
            生成 K 线
          </>
        )}
      </Button>

      {busy && (
        <p className="text-[11px] text-amber-400/80 leading-relaxed">
          重新生成会用新参数创建全新序列，中断当前回放。
        </p>
      )}
      {!busy && (
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          AI 只设计市场剧本（趋势/波动率/事件），后端用随机过程生成具体 K 线。
          每次重新生成都是全新序列，无历史依赖，最适合做策略过拟合测试。
        </p>
      )}
    </div>
  )
}
