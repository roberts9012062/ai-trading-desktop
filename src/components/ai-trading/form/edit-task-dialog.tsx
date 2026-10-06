"use client"

import { desktopTokensToServerV3 } from "@/lib/factor-access"
import { useEffect, useState } from "react"
import {
  FundingSourceBadge,
  MarginLeverageFields,
  useFundingSource,
} from "@/components/ai-trading/form/margin-leverage-fields"
import { useMarketStore } from "@/stores/market"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getAIModels } from "@/lib/api"
import { chatModelsOnly, decisionModelsOnly } from "@/lib/decision-model"
import type { AIModel } from "@/types"
import type { AITradingTask, UpdateTaskPayload } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import {
  CreateTaskRules,
  buildBottomPayload,
  buildCloseRulesPayload,
  rulesFromTask,
  type RuleFormState,
} from "@/components/ai-trading/form/create-task-rules"
import {
  AiFundStyleFields,
  DEFAULT_AI_FUND_STYLE,
  maxHoldDaysForTimeframe,
  type AiFundStyleState,
  type RiskStyle,
} from "@/components/ai-trading/form/ai-fund-style-fields"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { IconPicker } from "@/components/ai-trading/form/icon-picker"
import { AiFactorMount } from "@/components/ai-trading/form/ai-factor-mount"
import {
  AiQuantRefPicker,
  type QuantRefStrategy,
} from "@/components/ai-trading/form/ai-quant-ref-picker"
import {
  DEFAULT_QUANT_PARAMS,
  QUANT_KIND_OPTIONS,
  buildStrategyParams,
  paramsToQuantState,
  type QuantKind,
  type QuantParamsState,
} from "@/lib/quant-strategy"
import { KindParams } from "@/components/ai-trading/form/create-quant-params"
import {DEFAULT_FORECAST,forecastConfig,isForecast,type ForecastConfig} from '@/lib/ai-forecast'
import {ForecastOptions} from './forecast-options'

/** K 线周期 → 分钟（分析间隔上限） */
const TF_MINUTES: Record<string, number> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "240m": 240, "1d": 1440,
}
/** 秒 → 友好文案（间隔档显示用） */
function secLabel(v: number): string {
  if (v >= 86400) return "1天"
  if (v >= 3600) return v % 3600 === 0 ? `${v / 3600}小时` : `${v}秒`
  if (v >= 60) return v % 60 === 0 ? `${v / 60}分钟` : `${v}秒`
  return `${v}秒`
}

/** 快捷间隔档（秒，最低 3 秒），渲染时过滤 ≤ 周期上限 */
const INTERVAL_CHIPS = [3, 5, 10, 15, 30, 60, 120, 300, 900, 1800, 3600, 7200, 14400, 86400]

/** 全部量化策略类型集合（与 quant-strategy.ts 同源，避免重复维护漏判） */
const QUANT_STRATEGY_SET = new Set<string>(QUANT_KIND_OPTIONS.map((o) => o.value))
import { SymbolPicker } from "@/components/ai-trading/form/symbol-picker"

interface EditTaskDialogProps {
  open: boolean
  task: AITradingTask | null
  onClose: () => void
}

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "60m", "240m", "1d"] as const

/** 是否为量化策略任务（覆盖全部 QuantKind，含 factor 子类）。
 * 与 quant-strategy.ts 的 QUANT_KIND_OPTIONS 同源，避免新增策略时重复维护漏判。 */
function isQuantStrategy(strategyType: string | null | undefined): boolean {
  if (!strategyType) return false
  return QUANT_STRATEGY_SET.has(String(strategyType).toLowerCase())
}

/** 因子策略：量化口径（无 AI 模型/资金风格），但需挂载 factor_tokens。
 * 它是量化任务的一个特殊子类，因此 quantMode 为 true，同时 factorMode 也为 true。
 * 修复历史 BUG：原 isQuantStrategy 漏判 factor，导致因子任务编辑时被当成 AI 任务渲染。 */
function isFactorStrategy(strategyType: string | null | undefined): boolean {
  return strategyType === "factor"
}

/** 修改 AI/量化交易任务（仅 can_edit） */
/** factor 策略参数里的 token 是桌面谱系编码 —— 提交服务器前转 v3（幂等） */
function withServerFactorTokens(params: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(params?.factor_tokens)) {
    return { ...params, factor_tokens: desktopTokensToServerV3(params.factor_tokens as number[]) }
  }
  return params
}

export function EditTaskDialog({
  open,
  task,
  onClose,
}: EditTaskDialogProps): React.JSX.Element {
  const updateTask = useAITradingStore((s) => s.updateTask)
  const prediction=Boolean(task&&isForecast(task))
  const [forecast,setForecast]=useState<ForecastConfig>(DEFAULT_FORECAST)
  useEffect(()=>{if(task&&isForecast(task))setForecast(forecastConfig(task))},[task])
  const [models, setModels] = useState<AIModel[]>([])
  const [modelRowId, setModelRowId] = useState("")
  const [symbol, setSymbol] = useState("")
  const [symbolName, setSymbolName] = useState("")
  const [timeframe, setTimeframe] = useState("5m")
  const [extraTfs, setExtraTfs] = useState<string[]>([])
  const [barsLimit, setBarsLimit] = useState<string>("40")
  const [maxHoldDays, setMaxHoldDays] = useState<string>("")
  const [sideMode, setSideMode] = useState("both")
  const [positionMode, setPositionMode] = useState("fixed_margin")
  // r20：每笔保证金 USDT + 杠杆
  const [marginModel, setMarginModel] = useState<{ marginPerTrade: number; leverage: number; marginMode: "cross" | "isolated" }>({ marginPerTrade: 100, leverage: 10, marginMode: "cross" })
  // 量化策略参数（停止后可改再继续）：strategy_params ↔ 表单
  const [quantParams, setQuantParams] = useState<QuantParamsState>(DEFAULT_QUANT_PARAMS)
  // 量化分析间隔（秒）：3 ~ K 线周期秒；默认=周期（每根收盘分析一次）
  const [evalIntervalSec, setEvalIntervalSec] = useState(900)
  const tfMinutes = TF_MINUTES[timeframe] ?? 15
  const funding = useFundingSource(open)
  const lastPrice = useMarketStore(
    (s) => Number(s.quotes[symbol]?.last_price) || 0,
  )
  const [fixedQty, setFixedQty] = useState(1)
  const [qtyMin, setQtyMin] = useState(1)
  const [qtyMax, setQtyMax] = useState(1)
  const [capitalUsageMin, setCapitalUsageMin] = useState(0)
  const [capitalUsageMax, setCapitalUsageMax] = useState(100)
  const [name, setName] = useState("")
  const [icon, setIcon] = useState<string | null>(null)
  const [factorTokens, setFactorTokens] = useState<number[] | null>(null)
  const [refStrategies, setRefStrategies] = useState<QuantRefStrategy[]>([])
  const [fundStyle, setFundStyle] =
    useState<AiFundStyleState>(DEFAULT_AI_FUND_STYLE)
  const [rules, setRules] = useState<RuleFormState>(rulesFromTask({
    close_rules: {
      pnl_pct: null,
      total_pnl_pct: null,
      session_close: false,
      ai_auto: true,
    },
    stop_rules: { loss_pct: null, loss_amount: null, ai_auto: true },
    close_on_stop: true,
  } as AITradingTask))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const quantMode = isQuantStrategy(task?.strategy_type)
  const factorMode = isFactorStrategy(task?.strategy_type)
  const decisionMode =
    String(task?.strategy_type ?? "").toLowerCase() === "decision"
  const [decisionModels, setDecisionModels] = useState<AIModel[]>([])
  const [decisionModelRowId, setDecisionModelRowId] = useState("")
  const [decisionIntervalSec, setDecisionIntervalSec] = useState(60)

  useEffect(() => {
    if (!open || !task) return
    setName(task.name || "")
    setIcon(task.icon ?? null)
    const ftParam = (task.strategy_params ?? {}) as Record<string, unknown>
    setFactorTokens(
      Array.isArray(ftParam.factor_tokens)
        ? (ftParam.factor_tokens as number[])
        : null,
    )
    setRefStrategies(
      Array.isArray(ftParam.ref_strategies)
        ? (ftParam.ref_strategies as QuantRefStrategy[])
        : [],
    )
    setModelRowId(task.model_row_id || "")
    setSymbol(task.symbol)
    setSymbolName(task.symbol_name || "")
    setTimeframe(task.timeframe || "5m")
    const tfMin0 = TF_MINUTES[task.timeframe || "5m"] ?? 15
    const ivSec = Number(task.eval_interval_sec || 0)
    setEvalIntervalSec(ivSec > 0 ? Math.max(3, Math.min(tfMin0 * 60, ivSec)) : tfMin0 * 60)
    setExtraTfs(
      Array.isArray(task.extra_timeframes)
        ? task.extra_timeframes.filter((x) => x && x !== (task.timeframe || "5m"))
        : [],
    )
    setBarsLimit(String(task.ai_bars_limit ?? 40))
    setMaxHoldDays(String(task.max_hold_days ?? maxHoldDaysForTimeframe(task.timeframe || "5m")))
    setSideMode(task.side_mode || "both")
    const rawMode = task.position_mode || "fixed_margin"
    const useMin0 = Number(task.capital_usage_min_pct ?? 0)
    const useMax0 = Number(task.capital_usage_max_pct ?? 100)
    // 资金使用范围模式：full + 非默认使用比例
    const isCapitalMode =
      rawMode === "full" && (useMin0 > 0 || useMax0 < 100)
    setPositionMode(
      isCapitalMode
        ? "capital_pct"
        : rawMode === "fixed_qty"
          ? "fixed_margin"
          : rawMode,
    )
    setMarginModel({
      marginPerTrade: Number(task.margin_per_trade) > 0 ? Number(task.margin_per_trade) : 100,
      marginMode: task.margin_mode === "isolated" ? "isolated" as const : "cross" as const,
      leverage: Math.max(1, Math.min(100, Number(task.leverage) || 10)),
    })
    // 量化策略参数回填：decision 任务取 decision_strategy 内层，factor 走独立因子挂载
    const _rawSp = (task.strategy_params ?? {}) as Record<string, unknown>
    const _kindSrc = String(task.strategy_type || "")
    const _inner =
      _kindSrc === "decision"
        ? ((_rawSp.decision_strategy as { kind?: string; params?: Record<string, unknown> })?.params ?? {})
        : _rawSp
    const _kind = (
      _kindSrc === "decision"
        ? (_rawSp.decision_strategy as { kind?: string })?.kind
        : _kindSrc
    ) as QuantKind | undefined
    if (_kind && QUANT_KIND_OPTIONS.some((o) => o.value === _kind) && _kind !== "factor") {
      setQuantParams(paramsToQuantState(_kind, _inner))
    }
    setFixedQty(task.fixed_qty || 1)
    const qLo = Math.max(1, Number(task.qty_min ?? task.fixed_qty ?? 1))
    const qHi = Math.max(qLo, Number(task.qty_max ?? qLo))
    setQtyMin(qLo)
    setQtyMax(qHi)
    setCapitalUsageMin(useMin0)
    setCapitalUsageMax(useMax0)
    setFundStyle({
      allocatedCapital: Number(task.allocated_capital ?? 0),
      riskStyle: (task.risk_style as RiskStyle) || "balanced",
      customPromptEnabled: Boolean(task.custom_prompt_enabled),
      customPrompt: task.custom_prompt || "",
    })
    setRules(rulesFromTask(task))
    if (String(task.strategy_type ?? "").toLowerCase() === "decision") {
      setDecisionModelRowId(task.model_row_id || "")
      setDecisionIntervalSec(Number(task.decision_interval_sec ?? 60))
      void getAIModels()
        .then((list) => setDecisionModels(decisionModelsOnly(list)))
        .catch(() => setDecisionModels([]))
    } else if (!isQuantStrategy(task.strategy_type)) {
      void getAIModels()
        .then((list) => setModels(chatModelsOnly(list)))
        .catch(() => setModels([]))
    }
    setError(null)
  }, [open, task])

  async function handleSubmit(): Promise<void> {
    if (!task) return
    setError(null)
    const quant = isQuantStrategy(task.strategy_type)
    const factor = isFactorStrategy(task.strategy_type)
    const isDecision = decisionMode
    if (!quant && !isDecision && !modelRowId) {
      setError("请选择 AI 模型")
      return
    }
    if (isDecision && !decisionModelRowId) {
      setError("请选择决策模型")
      return
    }
    if (factor && (!factorTokens || factorTokens.length === 0)) {
      setError("因子策略必须挂载因子公式")
      return
    }
    if (!symbol.trim()) {
      setError("请选择合约品种")
      return
    }
    if (positionMode !== "capital_pct" && marginModel.marginPerTrade < 1) {
      setError("每笔保证金至少 1 USDT")
      return
    }
    if (
      !quant &&
      fundStyle.customPromptEnabled &&
      !fundStyle.customPrompt.trim()
    ) {
      setError("已启用用户提示词，请填写内容")
      return
    }
    const isQtyMode =
      positionMode === "fixed_margin" || positionMode === "scale_in"
    const isCapitalMode = positionMode === "capital_pct"
    let qLo = 1
    let qHi = 1
    let useMin = 0
    let useMax = 100
    let apiPositionMode = positionMode
    if (isQtyMode) {
      qLo = 1
      qHi = 1
    } else if (isCapitalMode) {
      apiPositionMode = "full"
      qLo = 1
      qHi = 10000
      useMin = Math.max(0, Math.min(100, capitalUsageMin))
      useMax = Math.max(0, Math.min(100, capitalUsageMax))
      if (useMax < useMin) {
        const t = useMin
        useMin = useMax
        useMax = t
      }
    } else {
      qLo = 1
      qHi = 10000
    }
    let bottom: ReturnType<typeof buildBottomPayload>
    try {
      bottom = buildBottomPayload(rules)
    } catch (err) {
      setError(err instanceof Error ? err.message : "兜底参数无效")
      return
    }
    const payload: UpdateTaskPayload = {
      name: name.trim(),
      icon,
      strategy_params: prediction ? {mode:'forecast',forecast:{...forecast,timeframes:[timeframe,...extraTfs],bar_count:Number(barsLimit),direction_mode:sideMode==='long_only'?'long':sideMode==='short_only'?'short':'any'}} : quantMode
        ? factorMode
          ? {
              ...(factorTokens && factorTokens.length
                ? { factor_tokens: desktopTokensToServerV3(factorTokens) }
                : {}),
              ...(refStrategies.length ? { ref_strategies: refStrategies } : {}),
            }
          : isDecision
            ? {
                decision_strategy: {
                  kind: quantParams.quantKind,
                  params: withServerFactorTokens(buildStrategyParams(quantParams)),
                },
                ...(refStrategies.length ? { ref_strategies: refStrategies } : {}),
              }
            : withServerFactorTokens(buildStrategyParams(quantParams))
        : refStrategies.length
          ? { ref_strategies: refStrategies }
          : undefined,
      model_row_id: isDecision
        ? decisionModelRowId
        : quant
          ? null
          : modelRowId,
      decision_interval_sec: isDecision ? decisionIntervalSec : undefined,
      eval_interval_sec:
        quant && !isDecision && evalIntervalSec < tfMinutes * 60
          ? evalIntervalSec
          : null,
      symbol: symbol.trim().toLowerCase(),
      symbol_name: symbolName,
      timeframe,
      // 多周期共振 + 每周期根数（量化任务传原值保持不变，仅 AI 策略生效）
      extra_timeframes: quant
        ? (task.extra_timeframes ?? [])
        : extraTfs,
      ai_bars_limit: quant
        ? (task.ai_bars_limit ?? 40)
        : Math.min(240, Math.max(10, Math.floor(Number(barsLimit) || 40))),
      side_mode: sideMode,
      position_mode: prediction?'fixed_margin':apiPositionMode,
      fixed_qty: qLo,
      qty_min: qLo,
      qty_max: qHi,
      // 所有模式统一保证金 sizing（旧手数路径会把小数数量截成 0）
      margin_per_trade: marginModel.marginPerTrade,
      leverage: prediction?Math.min(50,marginModel.leverage):marginModel.leverage,
      margin_mode: marginModel.marginMode,
      funding_source:
        funding.info && funding.info.source === "live" && funding.info.balance_usdt != null
          ? "live"
          : "site",
      capital_usage_min_pct: useMin,
      capital_usage_max_pct: useMax,
      risk_style: fundStyle.riskStyle,
      max_hold_days: maxHoldDays
        ? Math.min(365, Math.max(1, Math.floor(Number(maxHoldDays) || maxHoldDaysForTimeframe(timeframe))))
        : null,
      custom_prompt_enabled: quant ? false : fundStyle.customPromptEnabled,
      custom_prompt:
        quant || !fundStyle.customPromptEnabled
          ? null
          : fundStyle.customPrompt.trim(),
      close_rules: buildCloseRulesPayload(rules, decisionMode ? rules.modelExit : quant ? false : rules.closeAi),
      stop_rules: {
        loss_pct: rules.lossPct ? Number(rules.lossPct) : null,
        loss_amount: rules.lossAmount ? Number(rules.lossAmount) : null,
        ai_auto: decisionMode
          ? rules.modelStop
          : quant
            ? false
            : rules.stopAi,
      },
      ...bottom,
      close_on_stop: rules.closeOnStop,
    }
    setSubmitting(true)
    try {
      await updateTask(task.id, payload)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {decisionMode
              ? "修改决策模型任务"
              : factorMode
                ? "修改因子交易任务"
                : quantMode
                  ? "修改量化交易任务"
                  : "修改 AI 交易任务"}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-amber-400/90">
          仅已结束且（未下单或该品种已全部平仓）的任务可修改。保存后状态变为暂停，可再次开始。
        </p>

        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <IconPicker value={icon} onChange={setIcon}>
              <button
                type="button"
                className="rounded-full hover:ring-2 hover:ring-[var(--primary)]/50 transition"
              >
                <TaskIcon
                  icon={icon}
                  modelId={task?.model_id}
                  providerName={task?.provider_name}
                  displayName={task?.model_display_name || task?.name}
                  strategyType={task?.strategy_type}
                  size={36}
                />
              </button>
            </IconPicker>
            <div className="text-[11px] text-[var(--text-muted)] leading-tight">
              <div className="text-[var(--text-secondary)]">任务图标</div>
              <div>点头像更换</div>
            </div>
          </div>
          {prediction&&<ForecastOptions value={forecast} onChange={setForecast}/>}
          {(!quantMode || factorMode) && !decisionMode && !prediction && (
            <AiFactorMount
              value={factorTokens}
              onChange={setFactorTokens}
              symbol={symbol}
            />
          )}
          {!quantMode && !factorMode && !decisionMode && !prediction && (
            <AiQuantRefPicker
              value={refStrategies}
              onChange={setRefStrategies}
            />
          )}
          {decisionMode && (
            <div className="space-y-2 rounded-md border border-[var(--border)] p-2.5">
              <div className="space-y-1">
                <Label>决策模型</Label>
                <select
                  className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                  value={decisionModelRowId}
                  onChange={(e) => setDecisionModelRowId(e.target.value)}
                >
                  {decisionModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name} ({m.provider_name})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label>响应频率</Label>
                <select
                  className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                  value={decisionIntervalSec}
                  onChange={(e) => setDecisionIntervalSec(Number(e.target.value))}
                >
                  <option value={60}>1 分钟（最快）</option>
                  <option value={120}>2 分钟</option>
                  <option value={180}>3 分钟</option>
                  <option value={240}>4 分钟</option>
                  <option value={300}>5 分钟（最慢）</option>
                </select>
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label>任务名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {!quantMode && !decisionMode && (
            <div className="space-y-1">
              <Label>AI 模型</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={modelRowId}
                onChange={(e) => setModelRowId(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name} ({m.provider_name})
                  </option>
                ))}
              </select>
            </div>
          )}

          <SymbolPicker
            symbol={symbol}
            symbolName={symbolName}
            onChange={(sym, n) => {
              setSymbol(sym)
              setSymbolName(n)
            }}
          />

          {quantMode && !factorMode && (
            <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
              <div className="text-xs font-medium text-[var(--text-secondary)]">
                策略参数（{QUANT_KIND_OPTIONS.find((o) => o.value === quantParams.quantKind)?.label ?? quantParams.quantKind}）
              </div>
              <KindParams
                quant={quantParams}
                onQuant={setQuantParams}
                symbol={symbol}
                timeframe={timeframe}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>K 线周期</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={timeframe}
                onChange={(e) => {
                  const tf = e.target.value
                  setTimeframe(tf)
                  setMaxHoldDays(String(maxHoldDaysForTimeframe(tf)))
                  // 主周期切换：附加周期中与新主周期相同的自动剔除
                  setExtraTfs((prev) => prev.filter((x) => x !== tf))
                }}
              >
                {TIMEFRAMES.filter(t=>!prediction||t!=='1d').map((t) => (
                  <option key={t} value={t}>
                    {t === "240m" ? "4小时" : t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label>多空标准</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={sideMode}
                onChange={(e) => setSideMode(e.target.value)}
              >
                <option value="both">多空都做</option>
                <option value="long_only">只做多</option>
                <option value="short_only">只做空</option>
              </select>
            </div>
          </div>

          {!quantMode && (
            <>
              <div className="space-y-1.5">
                <Label>多周期共振（最多选 3 个附加周期）</Label>
                <div className="flex flex-wrap gap-1.5">
                  {TIMEFRAMES.filter((t) => t !== timeframe&&(!prediction||t!=='1d')).map((t) => {
                    const active = extraTfs.includes(t)
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() =>
                          setExtraTfs((prev) =>
                            prev.includes(t)
                              ? prev.filter((x) => x !== t)
                              : prev.length >= (prediction?2:3)
                                ? prev
                                : [...prev, t],
                          )
                        }
                        className={`px-2.5 py-1 rounded text-xs border transition-colors ${
                          active
                            ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                            : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        } ${!active && extraTfs.length >= 3 ? "opacity-40" : ""}`}
                      >
                        {t === "240m" ? "4小时" : t}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-[var(--text-muted)]">
                  AI 决策同时参考主周期与所选周期的 K 线，方向共振才出手；不选则仅看主周期。
                </p>
              </div>

              <div className="space-y-1">
                <Label>{prediction?'预测 K 线根数（30-100）':'AI 每周期 K 线根数（10-240，默认 40）'}</Label>
                <Input required
                  type="number"
                  min={prediction?30:10}
                  max={prediction?100:240}
                  value={barsLimit}
                  onChange={(e) => setBarsLimit(e.target.value)}
                  className="h-9 text-sm"
                  placeholder="40"
                />
                <p className="text-[11px] text-[var(--text-muted)]">
                  每个周期提供给 AI 的最近 K 线数量；根数越多上下文越全，token 消耗也越大。
                </p>
              </div>
            </>
          )}

          {quantMode && !decisionMode && (
            <div className="space-y-1.5 rounded-md border border-[var(--border)] p-2.5">
              <div className="flex items-center justify-between">
                <Label>分析间隔</Label>
                <span className="font-num text-xs text-[var(--primary)] font-semibold">
                  {evalIntervalSec >= tfMinutes * 60
                    ? `每根K线收盘（${secLabel(tfMinutes * 60)}）`
                    : `每 ${secLabel(evalIntervalSec)}`}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={3}
                  max={tfMinutes * 60}
                  value={evalIntervalSec}
                  onChange={(e) =>
                    setEvalIntervalSec(
                      Math.max(3, Math.min(tfMinutes * 60, Math.floor(Number(e.target.value) || 3))),
                    )
                  }
                  className="font-num h-8 text-sm w-24"
                />
                {INTERVAL_CHIPS.filter((v) => v <= tfMinutes * 60 && v >= 3).slice(-4).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setEvalIntervalSec(v)}
                    className={
                      "px-1.5 h-7 text-[10px] rounded border transition-colors shrink-0 " +
                      (evalIntervalSec === v
                        ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]")
                    }
                  >
                    {secLabel(v)}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">
                最小 3 秒，最大为 K 线周期（{tfMinutes >= 1440 ? "1 天" : tfMinutes + " 分钟"}）。
                {quantParams.quantKind === "swing_pivot"
                  ? "此间隔控制常规分析；新的枢轴进场指标首次出现时立即评估下单，不等待间隔或下一根 K 线。预确认根数包含当前未收盘 K 线。"
                  : "默认每根 K 线收盘分析一次；决策模型任务由其响应频率控制。"}
              </p>
            </div>
          )}

          <div className="space-y-1">
            <Label>交易周期 / 持仓天数（1-365，到期自动平仓）</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={maxHoldDays}
              onChange={(e) => setMaxHoldDays(e.target.value)}
              className="h-9 text-sm"
              placeholder={`默认 ${maxHoldDaysForTimeframe(timeframe)} 天`}
            />
            {task && isForecast(task) && <p className="text-[11px] text-[var(--text-muted)]">预测任务在周期内连续运行，换轮不重置倒计时，到期撤单、平仓并停止。</p>}
          </div>

          {!quantMode && (
            <AiFundStyleFields
              value={fundStyle}
              onChange={setFundStyle}
              timeframe={timeframe}
            />
          )}

          <div className="space-y-1">
            <Label>仓位管理</Label>
            <select
              className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={positionMode}
              onChange={(e) => {
                const mode = e.target.value
                setPositionMode(mode)
                if (mode === "fixed_margin" || mode === "scale_in") {
                  setCapitalUsageMin(0)
                  setCapitalUsageMax(100)
                } else if (mode === "capital_pct") {
                  setCapitalUsageMin(10)
                  setCapitalUsageMax(50)
                } else {
                  setCapitalUsageMin(0)
                  setCapitalUsageMax(100)
                }
              }}
            >
              <option value="fixed_margin">指定每笔保证金</option>
              <option value="capital_pct">资金使用范围</option>
              <option value="half">半仓（预算一半）</option>
              <option value="full">全仓（全部预算）</option>
              <option value="scale_in">滚仓（盈利加层）</option>
            </select>
            <p className="text-[11px] text-[var(--text-muted)]">
              数量 = 每笔保证金 × 杠杆 ÷ 价格（USDT 口径，小数）；交易按现有账户与保证金设置执行。
            </p>
          </div>
          <FundingSourceBadge info={funding.info} onReload={funding.reload} />
          <div className="rounded-md border border-[var(--border)] p-2.5">
            <MarginLeverageFields
              maxLeverage={prediction?50:100}
              value={marginModel}
              onChange={setMarginModel}
              lastPrice={lastPrice}
              scaleIn={positionMode === "scale_in"}
              budgetOnly={
                positionMode === "half" ||
                positionMode === "full" ||
                positionMode === "capital_pct"
              }
            />
          </div>
          {positionMode === "capital_pct" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>资金使用下限 %</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={capitalUsageMin}
                  onChange={(e) =>
                    setCapitalUsageMin(
                      Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                    )
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>资金使用上限 %</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={capitalUsageMax}
                  onChange={(e) =>
                    setCapitalUsageMax(
                      Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                    )
                  }
                />
              </div>
            </div>
          )}
          {positionMode === "scale_in" && (
            <p className="text-[11px] text-[var(--text-muted)] -mt-1">
              滚仓：首仓按每层保证金开仓；浮盈时可同向再加一层，最多 3
              层；浮亏不加仓；反向须先平仓。
            </p>
          )}

          <CreateTaskRules
            value={rules}
            showModelExit={decisionMode}
            showModelStop={decisionMode}
            onChange={setRules}
            showAiOptions={!quantMode && !decisionMode}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button validateNumbers onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "保存中…" : "保存修改"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
