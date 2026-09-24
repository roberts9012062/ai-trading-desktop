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
import type { AIModel } from "@/types"
import { decisionModelsOnly } from "@/lib/decision-model"
import type { AITradingTask, CreateTaskPayload } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import {
  CreateTaskRules,
  EMPTY_RULE_FORM,
  buildCloseRulesPayload,
  rulesFromTask,
  type RuleFormState,
} from "@/components/ai-trading/form/create-task-rules"
import { CreateQuantParams } from "@/components/ai-trading/form/create-quant-params"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { IconPicker } from "@/components/ai-trading/form/icon-picker"
import { SymbolPicker } from "@/components/ai-trading/form/symbol-picker"
import { maxHoldDaysForTimeframe } from "@/components/ai-trading/form/ai-fund-style-fields"
import {
  DEFAULT_QUANT_PARAMS,
  buildStrategyParams,
  quantIntervalLabel,
  quantIntervalMinuteOptions,
  paramsToQuantState,
  timeframeMinutes,
  validateQuantParams,
  type QuantKind,
  type QuantParamsState,
} from "@/lib/quant-strategy"

interface CreateQuantDialogProps {
  open: boolean
  onClose: () => void
  /** 克隆预填：从已有量化/因子任务带出全部参数 */
  prefillFrom?: AITradingTask | null
}

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "60m", "1d"] as const

const DEFAULT_RULES: RuleFormState = {
  ...EMPTY_RULE_FORM,
  sessionClose: true,
  closeAi: false,
  // 决策模型模式默认由模型自己决定平仓/止损（普通量化模式不展示该选项）
  modelExit: true,
  modelStop: true,
  lossPct: "3",
  stopAi: false,
  autoStart: true,
}

/** 创建量化交易任务 */
export function CreateQuantDialog({
  open,
  onClose,
  prefillFrom = null,
}: CreateQuantDialogProps): React.JSX.Element {
  const createTask = useAITradingStore((s) => s.createTask)
  const [quant, setQuant] = useState<QuantParamsState>(DEFAULT_QUANT_PARAMS)
  // 决策模型（TypeSafe Jev System One）：多空平全由模型判断
  const [decisionEnabled, setDecisionEnabled] = useState(false)
  const [decisionModels, setDecisionModels] = useState<AIModel[]>([])
  const [decisionModelRowId, setDecisionModelRowId] = useState("")
  const [decisionIntervalSec, setDecisionIntervalSec] = useState(60)
  // 量化任务分析间隔（秒）：0=按K线收盘（默认）；60~K线周期秒数
  const [quantIntervalSec, setQuantIntervalSec] = useState(0)
  const [icon, setIcon] = useState<string | null>(null)
  const [allocatedCapital, setAllocatedCapital] = useState(100000)
  const [symbol, setSymbol] = useState("")
  const [symbolName, setSymbolName] = useState("")
  const [timeframe, setTimeframe] = useState("15m")
  const [maxHoldDays, setMaxHoldDays] = useState<string>(String(maxHoldDaysForTimeframe("15m")))
  const [sideMode, setSideMode] = useState("both")
  const [positionMode, setPositionMode] = useState("fixed_qty")
  const [fixedQty, setFixedQty] = useState(1)
  const [name, setName] = useState("")
  const [rules, setRules] = useState<RuleFormState>(DEFAULT_RULES)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 决策模型列表：只列 Jev（决策）模型 —— 别的模型被筛掉
  useEffect(() => {
    if (!open || !decisionEnabled) return
    void getAIModels()
      .then((list) => {
        const decision = decisionModelsOnly(list)
        setDecisionModels(decision)
        if (decision.length && !decisionModelRowId) setDecisionModelRowId(decision[0].id)
      })
      .catch(() => setDecisionModels([]))
  }, [open, decisionEnabled, decisionModelRowId])

  // 克隆预填：量化参数用 paramsToQuantState 反解，名称加后缀
  useEffect(() => {
    if (!open || !prefillFrom) return
    const t = prefillFrom
    setName(`${t.name || "克隆任务"}-克隆`)
    setIcon(t.icon ?? null)
    const isDecisionClone = String(t.strategy_type || "") === "decision"
    const sp = (t.strategy_params ?? {}) as Record<string, unknown>
    const ds = isDecisionClone
      ? ((sp.decision_strategy ?? {}) as { kind?: string; params?: Record<string, unknown> })
      : {}
    setQuant(
      paramsToQuantState(
        String(isDecisionClone ? (ds.kind ?? "ma_cross") : t.strategy_type || "ma_cross") as QuantKind,
        ((isDecisionClone ? ds.params : sp) ?? {}) as Record<string, unknown>,
      ),
    )
    setAllocatedCapital(Number(t.allocated_capital || 100000))
    setSymbol(t.symbol || "")
    setSymbolName(t.symbol_name || "")
    setTimeframe(t.timeframe || "15m")
    setMaxHoldDays(
      String(t.max_hold_days ?? maxHoldDaysForTimeframe(t.timeframe || "15m")),
    )
    setSideMode(t.side_mode || "both")
    setPositionMode(t.position_mode || "fixed_qty")
    setFixedQty(t.fixed_qty || 1)
    setRules(rulesFromTask(t))
    const isDecision = String(t.strategy_type || "") === "decision"
    setDecisionEnabled(isDecision)
    setDecisionModelRowId(isDecision ? t.model_row_id || "" : "")
    setDecisionIntervalSec(
      isDecision ? Number(t.decision_interval_sec || 60) : 60,
    )
    setQuantIntervalSec(
      isDecision ? 0 : Math.max(0, Math.floor(Number(t.quant_interval_sec || 0))),
    )
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillFrom])

  // 全部量化策略显示分析间隔；决策模型模式不显示（按决策模型响应频率评估）
  const quantIntervalVisible = !decisionEnabled

  async function handleSubmit(): Promise<void> {
    setError(null)
    if (!symbol.trim()) {
      setError("请选择合约品种")
      return
    }
    const qErr = validateQuantParams(quant)
    if (qErr) {
      setError(qErr)
      return
    }
    if (decisionEnabled) {
      if (decisionModels.length === 0) {
        setError("请先在 AI 设置添加 TypeSafe Jev 渠道并添加决策模型")
        return
      }
      if (!decisionModelRowId) {
        setError("请选择决策模型")
        return
      }
    }

    const closeRules = buildCloseRulesPayload(
      rules,
      decisionEnabled ? rules.modelExit : false,
    )
    if (decisionEnabled && rules.modelExit) closeRules.model_exit = true

    const payload: CreateTaskPayload = {
      name: name.trim(),
      model_row_id: decisionEnabled ? decisionModelRowId : null,
      strategy_type: decisionEnabled ? "decision" : quant.quantKind,
      strategy_params: decisionEnabled
        ? { decision_strategy: { kind: quant.quantKind, params: buildStrategyParams(quant) } }
        : buildStrategyParams(quant),
      decision_interval_sec: decisionEnabled ? decisionIntervalSec : undefined,
      quant_interval_sec: decisionEnabled ? undefined : quantIntervalSec,
      icon,
      allocated_capital: allocatedCapital,
      symbol: symbol.trim().toLowerCase(),
      symbol_name: symbolName,
      timeframe,
      side_mode: sideMode,
      position_mode: positionMode,
      fixed_qty: fixedQty,
      max_hold_days: maxHoldDays
        ? Math.min(365, Math.max(1, Math.floor(Number(maxHoldDays) || maxHoldDaysForTimeframe(timeframe))))
        : null,
      close_rules: closeRules,
      stop_rules: {
        loss_pct: rules.lossPct ? Number(rules.lossPct) : null,
        loss_amount: rules.lossAmount ? Number(rules.lossAmount) : null,
        ai_auto: decisionEnabled ? rules.modelStop : false,
      },
      close_on_stop: rules.closeOnStop,
      auto_start: rules.autoStart,
    }
    setSubmitting(true)
    try {
      await createTask(payload)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>创建量化交易</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-[var(--accent-info)]">
          纯规则策略，不调用大模型。与 AI 交易共用模拟账户、调度与风控。
        </p>

        <div className="space-y-3 text-sm">
          {/* 决策模型开关：开启后量化策略参数被替换为决策模型 + 响应频率 */}
          <label className="flex items-center gap-2 rounded-md border border-[var(--border)] p-2.5">
            <input
              type="checkbox"
              checked={decisionEnabled}
              onChange={(e) => setDecisionEnabled(e.target.checked)}
            />
            <span className="text-sm">决策模型</span>
            <span className="text-[10px] text-[var(--text-muted)]">
              量化策略给决策模型喂信号内容，决策模型综合行情自主执行做多/做空/平仓（速度快延迟低，适合交易）
            </span>
          </label>

          <div className="flex items-center gap-2">
            <IconPicker value={icon} onChange={setIcon}>
              <button
                type="button"
                className="rounded-full hover:ring-2 hover:ring-[var(--primary)]/50 transition"
              >
                <TaskIcon
                  icon={icon}
                  strategyType={decisionEnabled ? "decision" : quant.quantKind}
                  modelId={decisionEnabled ? decisionModels.find((m) => m.id === decisionModelRowId)?.model_id : undefined}
                  size={36}
                />
              </button>
            </IconPicker>
            <div className="text-[11px] text-[var(--text-muted)] leading-tight">
              <div className="text-[var(--text-secondary)]">任务图标</div>
              <div>默认按策略（量化/因子）；可点头像更换</div>
            </div>
          </div>
          {decisionEnabled && (
            <div className="space-y-2 rounded-md border border-[var(--border)] p-2.5">
              <div className="space-y-1">
                <Label>决策模型</Label>
                <select
                  className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                  value={decisionModelRowId}
                  onChange={(e) => setDecisionModelRowId(e.target.value)}
                >
                  {decisionModels.length === 0 && (
                    <option value="">未找到决策模型（需先在 AI 设置添加 Jev 渠道模型）</option>
                  )}
                  {decisionModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name} ({m.provider_name})
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-[var(--text-muted)]">
                  只显示决策模型（TypeSafe Jev 渠道）；其他模型已被筛掉。
                </p>
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
                <p className="text-[10px] text-[var(--text-muted)]">
                  决策模型评估间隔：最快 1 分钟，最慢 5 分钟。
                </p>
              </div>
            </div>
          )}
          {decisionEnabled && (
            <p className="text-[10px] text-[var(--text-muted)] -mt-1">
              下方策略类型与参数正常设置：策略信号将作为参考内容喂给决策模型，模型做最终投资判断（可推翻策略建议）。
            </p>
          )}
          <CreateQuantParams
            quant={quant}
            onQuant={setQuant}
            symbol={symbol}
            timeframe={timeframe}
            onApplyFactorMeta={(sym, tf) => {
              // 选中收藏因子时，回填其品种与周期到任务表单
              if (sym && sym.trim()) {
                setSymbol(sym.trim().toLowerCase())
                // 清空旧名称，避免与回填的 symbol 不一致
                setSymbolName("")
              }
              if (tf && tf.trim()) setTimeframe(tf.trim())
            }}
          />

          <div className="space-y-1">
            <Label>任务名称（可选）</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="默认按策略自动命名"
            />
          </div>

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
                  setTimeframe(e.target.value)
                  setMaxHoldDays(String(maxHoldDaysForTimeframe(e.target.value)))
                  // 周期改小后当前分析间隔可能越界，回退默认（跟随收盘）
                  if (quantIntervalSec > timeframeMinutes(e.target.value) * 60) {
                    setQuantIntervalSec(0)
                  }
                  // 主周期切到与波段第二周期相同 → 清空第二周期（共振需两个不同周期）
                  if (quant.quantKind === "swing_pivot" && quant.swingResonanceTf === e.target.value) {
                    setQuant({ ...quant, swingResonanceTf: "" })
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

          {quantIntervalVisible && (
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

          <div className="space-y-1">
            <Label>任务资金仓（元）</Label>
            <Input
              type="number"
              min={1000}
              step={10000}
              value={allocatedCapital}
              onChange={(e) =>
                setAllocatedCapital(
                  Math.max(1000, Number(e.target.value) || 1000),
                )
              }
            />
            <p className="text-[10px] text-[var(--text-muted)]">
              从主账户划转独立资金仓；任务删除时退回。盈亏按资金仓额度计算。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>仓位管理</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={positionMode}
                onChange={(e) => setPositionMode(e.target.value)}
              >
                <option value="fixed_qty">指定手数</option>
                <option value="half">半仓</option>
                <option value="full">全仓</option>
                <option value="scale_in">滚仓（盈利加仓）</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>手数</Label>
              <Input
                type="number"
                min={1}
                value={fixedQty}
                disabled={positionMode !== "fixed_qty"}
                onChange={(e) =>
                  setFixedQty(Math.max(1, Number(e.target.value) || 1))
                }
              />
            </div>
          </div>

          <CreateTaskRules
            value={rules}
            onChange={setRules}
            showAiOptions={false}
            showModelExit={decisionEnabled}
            showModelStop={decisionEnabled}
            showIndicatorExits
            showFactorExit={!decisionEnabled && quant.quantKind === "factor"}
            factorExitHint="因子来源：本任务的选择公式。"
          />

          {error && (
            <p className="text-xs text-[var(--accent-danger)]">{error}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="button"
              disabled={submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? "创建中…" : "创建"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
