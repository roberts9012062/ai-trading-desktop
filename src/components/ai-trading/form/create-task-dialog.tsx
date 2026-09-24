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
import { chatModelsOnly } from "@/lib/decision-model"
import type { AIModel } from "@/types"
import type { AITradingTask, CreateTaskPayload } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import {
  CreateTaskRules,
  EMPTY_RULE_FORM,
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
import { SymbolPicker } from "@/components/ai-trading/form/symbol-picker"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { IconPicker } from "@/components/ai-trading/form/icon-picker"
import { AiFactorMount } from "@/components/ai-trading/form/ai-factor-mount"
import {
  AiQuantRefPicker,
  type QuantRefStrategy,
} from "@/components/ai-trading/form/ai-quant-ref-picker"
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
    <div className="rounded-md border border-[var(--accent-danger)]/50 bg-[var(--accent-danger)]/10 px-2.5 py-1.5 text-[11px] text-[var(--accent-danger)] text-left">
      实盘执行模式：任务开平仓将通过官方交易所接口（OKX/币安/芝麻开门）真实下单，
      盈亏与手续费真实结算。止损单直接挂到交易所。
    </div>
  )
}

interface CreateTaskDialogProps {
  open: boolean
  onClose: () => void
  /** 克隆预填：从已有任务（或收藏快照重建的任务对象）带出全部参数 */
  prefillFrom?: AITradingTask | null
}

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "60m", "1d"] as const

const DEFAULT_RULES: RuleFormState = {
  ...EMPTY_RULE_FORM,
  closeAi: true,
  autoStart: true,
}

/** 创建 AI 交易任务 */
export function CreateTaskDialog({
  open,
  onClose,
  prefillFrom = null,
}: CreateTaskDialogProps): React.JSX.Element {
  const createTask = useAITradingStore((s) => s.createTask)
  const [models, setModels] = useState<AIModel[]>([])
  const [modelRowId, setModelRowId] = useState("")
  const [icon, setIcon] = useState<string | null>(null)
  const [factorTokens, setFactorTokens] = useState<number[] | null>(null)
  const [refStrategies, setRefStrategies] = useState<QuantRefStrategy[]>([])
  const [symbol, setSymbol] = useState("")
  const [symbolName, setSymbolName] = useState("")
  const [timeframe, setTimeframe] = useState<string>("5m")
  const [extraTfs, setExtraTfs] = useState<string[]>([])
  const [barsLimit, setBarsLimit] = useState<string>("40")
  const [maxHoldDays, setMaxHoldDays] = useState<string>(String(maxHoldDaysForTimeframe("5m")))
  const [sideMode, setSideMode] = useState("both")
  const [positionMode, setPositionMode] = useState("fixed_margin")
  // r20：每笔保证金 USDT + 杠杆（数量自动换算，不再按手数）
  const [marginModel, setMarginModel] = useState({ marginPerTrade: 100, leverage: 10 })
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
  const [fundStyle, setFundStyle] =
    useState<AiFundStyleState>(DEFAULT_AI_FUND_STYLE)
  const [rules, setRules] = useState<RuleFormState>(DEFAULT_RULES)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void getAIModels()
      .then((list) => {
        const chat = chatModelsOnly(list)
        setModels(chat)
        if (chat.length && !modelRowId) setModelRowId(chat[0].id)
      })
      .catch(() => setModels([]))
  }, [open, modelRowId])

  // 克隆预填：带出源任务全部参数（字段映射与编辑弹窗一致），名称加后缀
  useEffect(() => {
    if (!open || !prefillFrom) return
    const t = prefillFrom
    setName(`${t.name || "克隆任务"}-克隆`)
    setIcon(t.icon ?? null)
    const ftParam = (t.strategy_params ?? {}) as Record<string, unknown>
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
    setModelRowId(t.model_row_id || "")
    setSymbol(t.symbol || "")
    setSymbolName(t.symbol_name || "")
    setTimeframe(t.timeframe || "5m")
    setExtraTfs(
      Array.isArray(t.extra_timeframes)
        ? t.extra_timeframes.filter((x) => x && x !== (t.timeframe || "5m"))
        : [],
    )
    setBarsLimit(String(t.ai_bars_limit ?? 40))
    setMaxHoldDays(
      String(t.max_hold_days ?? maxHoldDaysForTimeframe(t.timeframe || "5m")),
    )
    setSideMode(t.side_mode || "both")
    const rawMode = t.position_mode || "fixed_margin"
    const useMin0 = Number(t.capital_usage_min_pct ?? 0)
    const useMax0 = Number(t.capital_usage_max_pct ?? 100)
    const isCapitalMode =
      rawMode === "full" && (useMin0 > 0 || useMax0 < 100)
    setPositionMode(
      isCapitalMode
        ? "capital_pct"
        : rawMode === "fixed_qty"
          ? "fixed_margin"
          : rawMode,
    )
    setFixedQty(t.fixed_qty || 1)
    const qLo = Math.max(1, Number(t.qty_min ?? t.fixed_qty ?? 1))
    const qHi = Math.max(qLo, Number(t.qty_max ?? qLo))
    setQtyMin(qLo)
    setQtyMax(qHi)
    setCapitalUsageMin(useMin0)
    setCapitalUsageMax(useMax0)
    setMarginModel({
      marginPerTrade: Number(t.margin_per_trade) > 0 ? Number(t.margin_per_trade) : 100,
      leverage: Math.max(1, Math.min(100, Number(t.leverage) || 10)),
    })
    setFundStyle({
      allocatedCapital: Number(t.allocated_capital || 1000),
      riskStyle: (t.risk_style as RiskStyle) || "balanced",
      customPromptEnabled: Boolean(t.custom_prompt_enabled),
      customPrompt: t.custom_prompt || "",
    })
    setRules(rulesFromTask(t))
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillFrom])

  async function handleSubmit(): Promise<void> {
    setError(null)
    if (!modelRowId) {
      setError("请选择 AI 模型")
      return
    }
    if (!symbol.trim()) {
      setError("请选择合约品种")
      return
    }
    if (fundStyle.allocatedCapital < 10) {
      setError("AI 资金仓至少 10 USDT")
      return
    }
    if (positionMode !== "capital_pct" && marginModel.marginPerTrade < 1) {
      setError("每笔保证金至少 1 USDT")
      return
    }
    if (
      funding.info &&
      funding.info.source === "live" &&
      funding.info.balance_usdt != null &&
      fundStyle.allocatedCapital > funding.info.balance_usdt
    ) {
      setError(
        `实盘资金库可用 ${funding.info.balance_usdt.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} USDT，资金仓不能超过`,
      )
      return
    }
    if (
      fundStyle.customPromptEnabled &&
      !fundStyle.customPrompt.trim()
    ) {
      setError("已启用用户提示词，请填写内容")
      return
    }
    // 仓位模式互斥：保证金模式 vs 资金比例模式
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
      useMin = 0
      useMax = 100
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
      if (useMax <= 0) {
        setError("资金使用上限必须大于 0%")
        return
      }
    } else {
      // half / full
      qLo = 1
      qHi = 10000
      useMin = 0
      useMax = 100
    }
    const payload: CreateTaskPayload = {
      name: name.trim(),
      model_row_id: modelRowId,
      strategy_type: "ai",
      icon,
      strategy_params:
        (factorTokens && factorTokens.length) || refStrategies.length
          ? {
              ...(factorTokens && factorTokens.length
                ? { factor_tokens: factorTokens }
                : {}),
              ...(refStrategies.length
                ? { ref_strategies: refStrategies }
                : {}),
            }
          : undefined,
      symbol: symbol.trim().toLowerCase(),
      symbol_name: symbolName,
      timeframe,
      extra_timeframes: extraTfs,
      ai_bars_limit: Math.min(240, Math.max(10, Math.floor(Number(barsLimit) || 40))),
      side_mode: sideMode,
      position_mode: apiPositionMode,
      fixed_qty: qLo,
      qty_min: qLo,
      qty_max: qHi,
      // 所有模式统一保证金 sizing：half/full/capital_pct 忽略每笔保证金值、按预算比例，
      // 但必须传正值让引擎走 margin 模式（旧手数路径会把小数数量截成 0）
      margin_per_trade: marginModel.marginPerTrade,
      leverage: marginModel.leverage,
      funding_source:
        funding.info && funding.info.source === "live" && funding.info.balance_usdt != null
          ? "live"
          : "site",
      allocated_capital: fundStyle.allocatedCapital,
      capital_usage_min_pct: useMin,
      capital_usage_max_pct: useMax,
      risk_style: fundStyle.riskStyle,
      max_hold_days: maxHoldDays
        ? Math.min(365, Math.max(1, Math.floor(Number(maxHoldDays) || maxHoldDaysForTimeframe(timeframe))))
        : null,
      custom_prompt_enabled: fundStyle.customPromptEnabled,
      custom_prompt: fundStyle.customPromptEnabled
        ? fundStyle.customPrompt.trim()
        : null,
      close_rules: buildCloseRulesPayload(rules, rules.closeAi),
      stop_rules: {
        loss_pct: rules.lossPct ? Number(rules.lossPct) : null,
        loss_amount: rules.lossAmount ? Number(rules.lossAmount) : null,
        ai_auto: rules.stopAi,
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

  function onPositionModeChange(mode: string): void {
    setPositionMode(mode)
    // 保证金模式 / 资金模式互斥：切换时重置另一侧为默认
    if (mode === "fixed_margin" || mode === "scale_in") {
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
  }

  // 当前选中模型（头像匹配用）
  const selected = models.find((m) => m.id === modelRowId) || null

  // 16:9 宽屏面板：约 1120×630，双栏排版减少纵向滚动
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className={
          "max-w-[min(96vw,1120px)] w-[min(96vw,1120px)] " +
          "max-h-[min(90vh,640px)] h-[min(90vh,640px)] " +
          "overflow-hidden p-4 gap-2 flex flex-col"
        }
      >
        <DialogHeader className="shrink-0 space-y-1 pr-6">
          <DialogTitle>创建 AI 交易任务</DialogTitle>
          <p className="text-[11px] text-amber-400/90 text-left font-normal">
            模型按 K 线周期自主交易；资金仓额度控制风险上限。
          </p>
          <LiveExecBanner />
        </DialogHeader>

        <div className="min-h-0 flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm overflow-hidden">
          {/* 左栏：基础配置 + 仓位 */}
          <div className="min-h-0 overflow-y-auto space-y-2 pr-1">
            <div className="flex items-center gap-2">
              <IconPicker value={icon} onChange={setIcon}>
                <button
                  type="button"
                  className="rounded-full hover:ring-2 hover:ring-[var(--primary)]/50 transition"
                >
                  <TaskIcon
                    icon={icon}
                    modelId={selected?.model_id}
                    providerName={selected?.provider_name}
                    displayName={selected?.display_name}
                    strategyType="ai"
                    size={36}
                  />
                </button>
              </IconPicker>
              <div className="text-[11px] text-[var(--text-muted)] leading-tight">
                <div className="text-[var(--text-secondary)]">任务图标</div>
                <div>点头像更换；默认按模型自动匹配</div>
              </div>
            </div>
            <AiFactorMount
              value={factorTokens}
              onChange={setFactorTokens}
              symbol={symbol}
            />
            <AiQuantRefPicker
              value={refStrategies}
              onChange={setRefStrategies}
            />
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <Label>任务名称（可选）</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="默认：模型·品种·周期"
                />
              </div>
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <Label>AI 模型</Label>
                <select
                  className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                  value={modelRowId}
                  onChange={(e) => setModelRowId(e.target.value)}
                >
                  {models.length === 0 && (
                    <option value="">请先在 AI 设置添加模型</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name} ({m.provider_name})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <SymbolPicker
              symbol={symbol}
              symbolName={symbolName}
              onChange={(sym, n) => {
                setSymbol(sym)
                setSymbolName(n)
              }}
            />

            <div className="grid grid-cols-2 gap-2">
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
              <Label>仓位管理</Label>
              <select
                className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
                value={positionMode}
                onChange={(e) => onPositionModeChange(e.target.value)}
              >
                <option value="fixed_margin">指定每笔保证金</option>
                <option value="capital_pct">资金使用范围</option>
                <option value="half">半仓（预算一半）</option>
                <option value="full">全仓（全部预算）</option>
                <option value="scale_in">滚仓（盈利加层）</option>
              </select>
              <p className="text-[11px] text-[var(--text-muted)]">
                数量 = 每笔保证金 × 杠杆 ÷ 价格（USDT 口径，小数）；交易从 AI 资金仓走流水。
              </p>
            </div>

            <div className="rounded-md border border-[var(--border)] p-2.5">
              <MarginLeverageFields
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
              <div className="grid grid-cols-2 gap-2">
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
              <p className="text-[11px] text-[var(--text-muted)]">
                滚仓：首仓按每层保证金；浮盈可加层（最多 3 层）；浮亏不加；反向先平。
              </p>
            )}

            <CreateTaskRules
              value={rules}
              onChange={setRules}
              showAiOptions={true}
              showFactorExit={Boolean(factorTokens && factorTokens.length)}
              factorExitHint="因子来源：上方挂载的参考因子。"
            />
          </div>

          {/* 右栏：资金源 / 资金仓 / 风格 / 用户提示词 */}
          <div className="min-h-0 overflow-y-auto pr-1 space-y-2">
            <FundingSourceBadge info={funding.info} onReload={funding.reload} />
            <AiFundStyleFields
              value={fundStyle}
              onChange={setFundStyle}
              timeframe={timeframe}
              compact={true}
            />
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 shrink-0">{error}</p>
        )}
        <div className="flex justify-end gap-2 shrink-0 pt-1 border-t border-[var(--border)]">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "创建中…" : "创建"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
