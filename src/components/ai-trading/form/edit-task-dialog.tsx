"use client"

import { useEffect, useState } from "react"
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
import { QUANT_KIND_OPTIONS } from "@/lib/quant-strategy"
import {
  quantIntervalLabel,
  quantIntervalMinuteOptions,
  timeframeMinutes,
} from "@/lib/quant-strategy"

/** 全部量化策略类型集合（与 quant-strategy.ts 同源，避免重复维护漏判） */
const QUANT_STRATEGY_SET = new Set<string>(QUANT_KIND_OPTIONS.map((o) => o.value))
import { SymbolPicker } from "@/components/ai-trading/form/symbol-picker"

interface EditTaskDialogProps {
  open: boolean
  task: AITradingTask | null
  onClose: () => void
}

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "60m", "1d"] as const

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
export function EditTaskDialog({
  open,
  task,
  onClose,
}: EditTaskDialogProps): React.JSX.Element {
  const updateTask = useAITradingStore((s) => s.updateTask)
  const [models, setModels] = useState<AIModel[]>([])
  const [modelRowId, setModelRowId] = useState("")
  const [symbol, setSymbol] = useState("")
  const [symbolName, setSymbolName] = useState("")
  const [timeframe, setTimeframe] = useState("5m")
  const [extraTfs, setExtraTfs] = useState<string[]>([])
  const [barsLimit, setBarsLimit] = useState<string>("40")
  const [maxHoldDays, setMaxHoldDays] = useState<string>("")
  const [sideMode, setSideMode] = useState("both")
  const [positionMode, setPositionMode] = useState("fixed_qty")
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
  // 量化任务分析间隔（秒）：0=按K线收盘；60~K线周期秒数
  const [quantIntervalSec, setQuantIntervalSec] = useState(0)

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
    setExtraTfs(
      Array.isArray(task.extra_timeframes)
        ? task.extra_timeframes.filter((x) => x && x !== (task.timeframe || "5m"))
        : [],
    )
    setBarsLimit(String(task.ai_bars_limit ?? 40))
    setMaxHoldDays(String(task.max_hold_days ?? maxHoldDaysForTimeframe(task.timeframe || "5m")))
    setSideMode(task.side_mode || "both")
    const rawMode = task.position_mode || "fixed_qty"
    const useMin0 = Number(task.capital_usage_min_pct ?? 0)
    const useMax0 = Number(task.capital_usage_max_pct ?? 100)
    // 资金使用范围模式：full + 非默认使用比例
    const isCapitalMode =
      rawMode === "full" && (useMin0 > 0 || useMax0 < 100)
    setPositionMode(isCapitalMode ? "capital_pct" : rawMode)
    setFixedQty(task.fixed_qty || 1)
    const qLo = Math.max(1, Number(task.qty_min ?? task.fixed_qty ?? 1))
    const qHi = Math.max(qLo, Number(task.qty_max ?? qLo))
    setQtyMin(qLo)
    setQtyMax(qHi)
    setCapitalUsageMin(useMin0)
    setCapitalUsageMax(useMax0)
    setFundStyle({
      allocatedCapital: Number(task.allocated_capital || 100000),
      riskStyle: (task.risk_style as RiskStyle) || "balanced",
      customPromptEnabled: Boolean(task.custom_prompt_enabled),
      customPrompt: task.custom_prompt || "",
    })
    setRules(rulesFromTask(task))
    setQuantIntervalSec(Math.max(0, Math.floor(Number(task.quant_interval_sec ?? 0))))
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
    if (!quant && fundStyle.allocatedCapital < 1000) {
      setError("AI 资金仓至少 ¥1000")
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
      positionMode === "fixed_qty" || positionMode === "scale_in"
    const isCapitalMode = positionMode === "capital_pct"
    let qLo = 1
    let qHi = 1
    let useMin = 0
    let useMax = 100
    let apiPositionMode = positionMode
    if (isQtyMode) {
      qLo = Math.max(1, Math.min(qtyMin, qtyMax))
      qHi = Math.max(1, Math.max(qtyMin, qtyMax))
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
    const payload: UpdateTaskPayload = {
      name: name.trim(),
      icon,
      strategy_params:
        (factorMode && factorTokens && factorTokens.length) ||
        refStrategies.length
          ? {
              ...(factorMode && factorTokens && factorTokens.length
                ? { factor_tokens: factorTokens }
                : {}),
              ...(refStrategies.length
                ? { ref_strategies: refStrategies }
                : {}),
            }
          : undefined,
      model_row_id: isDecision
        ? decisionModelRowId
        : quant
          ? null
          : modelRowId,
      decision_interval_sec: isDecision ? decisionIntervalSec : undefined,
      quant_interval_sec: quant ? quantIntervalSec : undefined,
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
      position_mode: apiPositionMode,
      fixed_qty: qLo,
      qty_min: qLo,
      qty_max: qHi,
      allocated_capital: fundStyle.allocatedCapital,
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
      close_rules: {
        pnl_pct: rules.pnlPct ? Number(rules.pnlPct) : null,
        total_pnl_pct: rules.totalPnlPct ? Number(rules.totalPnlPct) : null,
        session_close: rules.sessionClose,
        ai_auto: decisionMode
          ? rules.modelExit
          : quant
            ? false
            : rules.closeAi,
        ...(decisionMode && rules.modelExit ? { model_exit: true } : {}),
      },
      stop_rules: {
        loss_pct: rules.lossPct ? Number(rules.lossPct) : null,
        loss_amount: rules.lossAmount ? Number(rules.lossAmount) : null,
        ai_auto: decisionMode
          ? rules.modelStop
          : quant
            ? false
            : rules.stopAi,
      },
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
          {(!quantMode || factorMode) && !decisionMode && (
            <AiFactorMount
              value={factorTokens}
              onChange={setFactorTokens}
              symbol={symbol}
            />
          )}
          {!quantMode && !factorMode && !decisionMode && (
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
                  // 周期改小后当前分析间隔可能越界，回退默认（跟随收盘）
                  if (quantIntervalSec > timeframeMinutes(tf) * 60) {
                    setQuantIntervalSec(0)
                  }
                }}
              >
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
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

          {/* 全部量化策略可设分析间隔；决策模型任务按其响应频率，不显示 */}
          {quantMode && !decisionMode && (
            <div className="space-y-1">
              <Label>分析间隔</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={quantIntervalSec}
                onChange={(e) => setQuantIntervalSec(Number(e.target.value))}
              >
                <option value={0}>跟随K线收盘（默认）</option>
                {quantIntervalMinuteOptions(timeframe).map((m) => (
                  <option key={m} value={m * 60}>
                    {quantIntervalLabel(m)}
                    {m === timeframeMinutes(timeframe) ? "（K线周期）" : ""}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-[var(--text-muted)]">
                每次分析记录的间隔：最快 1 分钟，最慢不超过 K
                线周期。间隔小于周期时，盘中按含未收盘 K
                线计算信号，反应更早但与回测口径有差异。
              </p>
            </div>
          )}

          {!quantMode && (
            <>
              <div className="space-y-1.5">
                <Label>多周期共振（最多选 3 个附加周期）</Label>
                <div className="flex flex-wrap gap-1.5">
                  {TIMEFRAMES.filter((t) => t !== timeframe).map((t) => {
                    const active = extraTfs.includes(t)
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() =>
                          setExtraTfs((prev) =>
                            prev.includes(t)
                              ? prev.filter((x) => x !== t)
                              : prev.length >= 3
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
                        {t}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-[var(--text-muted)]">
                  AI 决策同时参考主周期与所选周期的 K 线，方向共振才出手；不选则仅看主周期。
                </p>
              </div>

              <div className="space-y-1">
                <Label>AI 每周期 K 线根数（10-240，默认 40）</Label>
                <Input
                  type="number"
                  min={10}
                  max={240}
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
                if (mode === "fixed_qty" || mode === "scale_in") {
                  setCapitalUsageMin(0)
                  setCapitalUsageMax(100)
                } else if (mode === "capital_pct") {
                  setQtyMin(1)
                  setQtyMax(100)
                  setFixedQty(1)
                  setCapitalUsageMin(10)
                  setCapitalUsageMax(50)
                } else {
                  setQtyMin(1)
                  setQtyMax(1)
                  setFixedQty(1)
                  setCapitalUsageMin(0)
                  setCapitalUsageMax(100)
                }
              }}
            >
              <option value="fixed_qty">指定手数范围</option>
              <option value="capital_pct">资金使用范围</option>
              <option value="half">半仓</option>
              <option value="full">全仓</option>
              <option value="scale_in">滚仓（盈利加仓）</option>
            </select>
            <p className="text-[11px] text-[var(--text-muted)]">
              手数范围与资金使用范围二选一；交易从 AI 资金仓走流水。
            </p>
          </div>
          {(positionMode === "fixed_qty" || positionMode === "scale_in") && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>最少手数</Label>
                <Input
                  type="number"
                  min={1}
                  value={qtyMin}
                  onChange={(e) => {
                    const v = Math.max(1, Number(e.target.value) || 1)
                    setQtyMin(v)
                    setFixedQty(v)
                    if (qtyMax < v) setQtyMax(v)
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>
                  {positionMode === "scale_in" ? "每层最多手数" : "最多手数"}
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={qtyMax}
                  onChange={(e) => {
                    const v = Math.max(1, Number(e.target.value) || 1)
                    setQtyMax(v)
                    if (qtyMin > v) {
                      setQtyMin(v)
                      setFixedQty(v)
                    }
                  }}
                />
              </div>
            </div>
          )}
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
              滚仓：首仓按手数范围开仓；浮盈时可同向再加一层，最多 3
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
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "保存中…" : "保存修改"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
