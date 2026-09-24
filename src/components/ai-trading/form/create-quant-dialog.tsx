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
import {
  FundingSourceBadge,
  MarginLeverageFields,
  useFundingSource,
} from "@/components/ai-trading/form/margin-leverage-fields"
import { useMarketStore } from "@/stores/market"
import { useAuthStore } from "@/stores/auth"

/** 实盘模式创建任务：官方接口真实下单提示横幅 */
function LiveExecBanner(): React.JSX.Element | null {
  const mode = useAuthStore((s) => s.user?.trading_mode)
  if (mode !== "live") return null
  return (
    <div className="rounded-md border border-[var(--accent-danger)]/50 bg-[var(--accent-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--accent-danger)]">
      实盘执行模式：任务开平仓将通过官方交易所接口（OKX/币安/芝麻开门）真实下单，
      盈亏与手续费真实结算。止损单直接挂到交易所。
    </div>
  )
}
import { maxHoldDaysForTimeframe } from "@/components/ai-trading/form/ai-fund-style-fields"
import {
  DEFAULT_QUANT_PARAMS,
  buildStrategyParams,
  paramsToQuantState,
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

/** K 线周期 → 分钟（分析间隔上限） */
const TF_MINUTES: Record<string, number> = {
  "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1d": 1440,
}

/** 快捷间隔档（分钟），渲染时过滤 ≤ 周期上限 */
const INTERVAL_CHIPS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440]

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
  const [icon, setIcon] = useState<string | null>(null)
  const [allocatedCapital, setAllocatedCapital] = useState(1000)
  const [symbol, setSymbol] = useState("")
  const [symbolName, setSymbolName] = useState("")
  const [timeframe, setTimeframe] = useState("15m")
  const [maxHoldDays, setMaxHoldDays] = useState<string>(String(maxHoldDaysForTimeframe("15m")))
  const [sideMode, setSideMode] = useState("both")
  const [positionMode, setPositionMode] = useState("fixed_margin")
  // r20：每笔保证金 USDT + 杠杆（数量自动换算，不再按手数）
  const [marginModel, setMarginModel] = useState({ marginPerTrade: 100, leverage: 10 })
  // 量化分析间隔（分钟）：1 ~ K 线周期；默认=周期（每根收盘分析一次）
  const [evalIntervalMin, setEvalIntervalMin] = useState(15)
  const tfMinutes = TF_MINUTES[timeframe] ?? 15
  const funding = useFundingSource(open)
  const lastPrice = useMarketStore(
    (s) => Number(s.quotes[symbol]?.last_price) || 0,
  )
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
    setAllocatedCapital(Number(t.allocated_capital || 1000))
    setSymbol(t.symbol || "")
    setSymbolName(t.symbol_name || "")
    setTimeframe(t.timeframe || "15m")
    setMaxHoldDays(
      String(t.max_hold_days ?? maxHoldDaysForTimeframe(t.timeframe || "15m")),
    )
    const tfMin0 = TF_MINUTES[t.timeframe || "15m"] ?? 15
    const ivSec = Number(t.eval_interval_sec || 0)
    setEvalIntervalMin(
      ivSec >= 60 ? Math.max(1, Math.min(tfMin0, Math.round(ivSec / 60))) : tfMin0,
    )
    setSideMode(t.side_mode || "both")
    setPositionMode(t.position_mode || "fixed_margin")
    setMarginModel({
      marginPerTrade: Number(t.margin_per_trade) > 0 ? Number(t.margin_per_trade) : 100,
      leverage: Math.max(1, Math.min(100, Number(t.leverage) || 10)),
    })
    setRules(rulesFromTask(t))
    const isDecision = String(t.strategy_type || "") === "decision"
    setDecisionEnabled(isDecision)
    setDecisionModelRowId(isDecision ? t.model_row_id || "" : "")
    setDecisionIntervalSec(
      isDecision ? Number(t.decision_interval_sec || 60) : 60,
    )
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillFrom])

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
    if (allocatedCapital < 10) {
      setError("任务资金仓至少 10 USDT")
      return
    }
    if (marginModel.marginPerTrade < 1) {
      setError("每笔保证金至少 1 USDT")
      return
    }
    if (
      funding.info &&
      funding.info.source === "live" &&
      funding.info.balance_usdt != null &&
      allocatedCapital > funding.info.balance_usdt
    ) {
      setError(
        `实盘资金库可用 ${funding.info.balance_usdt.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} USDT，资金仓不能超过`,
      )
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
      // 量化分析间隔：等于周期（默认）发 null=按K线收盘；决策模型忽略
      eval_interval_sec:
        !decisionEnabled && evalIntervalMin < tfMinutes
          ? evalIntervalMin * 60
          : null,
      icon,
      allocated_capital: allocatedCapital,
      symbol: symbol.trim().toLowerCase(),
      symbol_name: symbolName,
      timeframe,
      side_mode: sideMode,
      position_mode: positionMode,
      margin_per_trade: marginModel.marginPerTrade,
      leverage: marginModel.leverage,
      funding_source:
        funding.info && funding.info.source === "live" && funding.info.balance_usdt != null
          ? "live"
          : "site",
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
          纯规则策略，不调用大模型。按每笔保证金×杠杆自动换算数量（USDT 口径，小数）。
        </p>
        <LiveExecBanner />
        <FundingSourceBadge info={funding.info} onReload={funding.reload} />

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
                  setEvalIntervalMin(TF_MINUTES[e.target.value] ?? 15)
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

          {!decisionEnabled && (
            <div className="space-y-1.5 rounded-md border border-[var(--border)] p-2.5">
              <div className="flex items-center justify-between">
                <Label>分析间隔（分钟）</Label>
                <span className="font-num text-xs text-[var(--primary)] font-semibold">
                  {evalIntervalMin >= tfMinutes
                    ? `每根K线收盘（${tfMinutes >= 1440 ? "1天" : tfMinutes + "分钟"}）`
                    : `每 ${evalIntervalMin} 分钟`}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={1}
                  max={tfMinutes}
                  value={evalIntervalMin}
                  onChange={(e) =>
                    setEvalIntervalMin(
                      Math.max(1, Math.min(tfMinutes, Math.floor(Number(e.target.value) || 1))),
                    )
                  }
                  className="font-num h-8 text-sm w-24"
                />
                {INTERVAL_CHIPS.filter((v) => v <= tfMinutes && v > 1).slice(-4).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setEvalIntervalMin(v)}
                    className={
                      "px-1.5 h-7 text-[10px] rounded border transition-colors shrink-0 " +
                      (evalIntervalMin === v
                        ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]")
                    }
                  >
                    {v >= 1440 ? "1天" : v + "分"}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">
                最小 1 分钟，最大为 K 线周期（{tfMinutes >= 1440 ? "1 天" : tfMinutes + " 分钟"}）。
                默认每根 K 线收盘分析一次；间隔小于周期时按间隔复用最近已收盘 K 线分析。
                勾选决策模型后由决策模型的响应频率控制。
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
            <Label>任务资金仓（USDT）</Label>
            <Input
              type="number"
              min={10}
              step="any"
              value={allocatedCapital}
              onChange={(e) =>
                setAllocatedCapital(
                  Math.max(10, Number(e.target.value) || 10),
                )
              }
            />
            <p className="text-[10px] text-[var(--text-muted)]">
              {funding.info && funding.info.source === "live"
                ? "从实盘资金库（交易所 USDT 可用）划转独立资金仓；任务删除时退回。"
                : "从站内账户划转独立资金仓；任务删除时退回。"}
              盈亏按资金仓额度计算（USDT，可小数）。
            </p>
          </div>

          <div className="space-y-2 rounded-md border border-[var(--border)] p-2.5">
            <div className="space-y-1">
              <Label>仓位管理</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={positionMode}
                onChange={(e) => setPositionMode(e.target.value)}
              >
                <option value="fixed_margin">指定每笔保证金</option>
                <option value="half">半仓（预算一半）</option>
                <option value="full">全仓（全部预算）</option>
                <option value="scale_in">滚仓（盈利加层）</option>
              </select>
            </div>
            {positionMode !== "half" && positionMode !== "full" && (
              <MarginLeverageFields
                value={marginModel}
                onChange={setMarginModel}
                lastPrice={lastPrice}
                scaleIn={positionMode === "scale_in"}
              />
            )}
            {(positionMode === "half" || positionMode === "full") && (
              <>
                <MarginLeverageFields
                  value={marginModel}
                  onChange={setMarginModel}
                  lastPrice={lastPrice}
                  budgetOnly
                />
                <p className="text-[10px] text-[var(--text-muted)]">
                  {positionMode === "half" ? "每笔使用资金仓可用预算的一半" : "每笔使用资金仓全部可用预算"}作保证金；数量 = 保证金 × 杠杆 ÷ 价格。
                </p>
              </>
            )}
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
