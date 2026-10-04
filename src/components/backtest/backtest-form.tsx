"use client"

/**
 * 回测参数表单 —— 品种/时间/策略
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SymbolPicker } from "@/components/ai-trading/form/symbol-picker"
import { StrategySection } from "@/components/backtest/backtest-form-fields"
import {
  AiFundStyleFields,
  DEFAULT_AI_FUND_STYLE,
  type AiFundStyleState,
} from "@/components/ai-trading/form/ai-fund-style-fields"
import { getAIModels } from "@/lib/api"
import { chatModelsOnly } from "@/lib/decision-model"
import {
  DEFAULT_QUANT_PARAMS,
  buildStrategyParams,
  type QuantParamsState,
} from "@/lib/quant-strategy"
import {
  AiQuantRefPicker,
  type QuantRefStrategy,
} from "@/components/ai-trading/form/ai-quant-ref-picker"
import type { AIModel } from "@/types"
import type { BacktestRunPayload } from "@/lib/backtest-api"
import { DataChannelSelect } from "@/components/common/data-channel-select"
import type { ChannelRange } from "@/lib/history-channels"
import { validateBacktestForm } from "@/components/backtest/backtest-form-helpers"
import { BacktestRangeSlider } from "@/components/backtest/backtest-range-slider"
import {
  defaultRangeFor,
  inclusiveDays,
  maxDaysFor,
  multiSegmentMinDays,
  railDaysFor,
  SEGMENT_MAX_COUNT,
  SEGMENT_MIN_COUNT,
  toISO,
} from "@/components/backtest/timeframe-limits"

interface BacktestFormProps {
  submitting: boolean
  onSubmit: (payload: BacktestRunPayload) => void
}

const TIMEFRAMES = ["1d", "60m", "30m", "15m", "5m", "1m"] as const

/** 回测配置表单 */
export function BacktestForm({
  submitting,
  onSubmit,
}: BacktestFormProps): React.JSX.Element {
  const [today] = useState(() => new Date())
  const [mode, setMode] = useState<"quant" | "ai">("quant")
  const [quant, setQuant] = useState<QuantParamsState>(DEFAULT_QUANT_PARAMS)
  const [symbol, setSymbol] = useState("")
  const [symbolName, setSymbolName] = useState("")
  const [timeframe, setTimeframe] = useState("1d")
  const [initRange] = useState(() => defaultRangeFor("1d", new Date()))
  const [startDate, setStartDate] = useState(initRange.start)
  const [endDate, setEndDate] = useState(initRange.end)
  // 历史数据渠道：选渠道后按其可用范围 clamp 回测日期
  const [dataChannel, setDataChannel] = useState("okx")
  const [channelRange, setChannelRange] = useState<ChannelRange | null>(null)
  // 多段回测：日线（1d）不支持；段数 2~5
  const [multiSeg, setMultiSeg] = useState(false)
  const [segCount, setSegCount] = useState(SEGMENT_MIN_COUNT)
  const [sideMode, setSideMode] = useState("both")
  // r20 模型：每笔保证金（USDT）×杠杆 自动算量；数量留空时按此口径
  const [marginPerTrade, setMarginPerTrade] = useState(1000)
  const [leverage, setLeverage] = useState(5)
  /** 保证金模式：全仓（账户共享，回测不强平）/ 逐仓（仓位独立强平线） */
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross")
  const [initialCash, setInitialCash] = useState(1_000_000)
  const [name, setName] = useState("")
  const [lossPct, setLossPct] = useState("3")
  const [pnlPct, setPnlPct] = useState("")
  const [models, setModels] = useState<AIModel[]>([])
  const [modelRowId, setModelRowId] = useState("")
  const [refStrategies, setRefStrategies] = useState<QuantRefStrategy[]>([])
  const [fundStyle, setFundStyle] =
    useState<AiFundStyleState>(DEFAULT_AI_FUND_STYLE)
  const [error, setError] = useState<string | null>(null)
  const [rangeError, setRangeError] = useState<string | null>(null)

  useEffect(() => {
    if (mode !== "ai") return
    void getAIModels()
      .then((list) => {
        const chat = chatModelsOnly(list)
        setModels(chat)
        if (chat.length && !modelRowId) setModelRowId(chat[0].id)
      })
      .catch(() => setModels([]))
  }, [mode, modelRowId])

  // 切换周期：同步重置到该周期允许的最近区间。
  // 必须与 setTimeframe 在同一回调内原子更新，否则会出现一帧「旧日期在新 rail
  // 下算出非法百分比被 clamp」的中间态，导致滑块柄瞬移、拖拽时左右乱伸缩。
  function changeTimeframe(tf: string): void {
    setTimeframe(tf)
    // 日线不支持多段：切到 1d 时自动关闭多段并恢复单段默认区间
    const multi = multiSeg && tf !== "1d"
    setMultiSeg(multi)
    const r = multi
      ? multiSegDefaultRange(tf, segCount)
      : defaultRangeFor(tf, today)
    setStartDate(r.start)
    setEndDate(r.end)
    setRangeError(null)
  }

  /** 多段模式初始区间：最近一个满足最小天数（含首尾）的窗口 */
  function multiSegDefaultRange(
    tf: string,
    n: number,
  ): { start: string; end: string } {
    const end = new Date(today)
    const start = new Date(today)
    start.setUTCDate(start.getUTCDate() - (multiSegmentMinDays(tf, n) - 1))
    return { start: toISO(start), end: toISO(end) }
  }

  function changeMultiSeg(on: boolean): void {
    setMultiSeg(on)
    const r = on
      ? multiSegDefaultRange(timeframe, segCount)
      : defaultRangeFor(timeframe, today)
    setStartDate(r.start)
    setEndDate(r.end)
    setRangeError(null)
  }

  function changeSegCount(n: number): void {
    setSegCount(n)
    // 段数变大后当前区间可能不足新下限：不足时回弹到最近的满足窗口
    if (multiSeg && inclusiveDays(startDate, endDate) < multiSegmentMinDays(timeframe, n)) {
      const r = multiSegDefaultRange(timeframe, n)
      setStartDate(r.start)
      setEndDate(r.end)
      setRangeError(null)
    }
  }

  // 渠道范围回来后 clamp 日期：早于渠道最早/晚于渠道最新的日期不可选；
  // 当前区间整体越界时重置为「渠道末端一个合法区间」
  const railMinISO = channelRange?.min_date ?? null
  const railMaxISO = channelRange?.max_date ?? null
  useEffect(() => {
    if (!railMinISO || !railMaxISO) return
    const upper = railMaxISO < toISO(today) ? railMaxISO : toISO(today)
    setStartDate((s) => (s < railMinISO ? railMinISO : s > upper ? upper : s))
    setEndDate((e) => {
      if (e > upper) return upper
      if (e < railMinISO) {
        const d = new Date(railMinISO)
        d.setUTCDate(d.getUTCDate() + maxDaysFor(timeframe) - 1)
        return toISO(d) <= upper ? toISO(d) : upper
      }
      return e
    })
  }, [railMinISO, railMaxISO, timeframe, today])

  function handleSubmit(): void {
    setError(null)
    const verr = validateBacktestForm({
      symbol,
      startDate,
      endDate,
      timeframe,
      mode,
      modelRowId,
      fundStyle,
      quant,
      multiSegment: multiSeg,
      segmentCount: segCount,
    })
    if (verr) {
      setError(verr)
      return
    }

    // 短线因子不进回测（选项已过滤）；类型收窄防御非法值
    const strategy_type =
      mode === "ai"
        ? "ai"
        : (quant.quantKind === "shortline_factor"
            ? "factor"
            : quant.quantKind) as Exclude<
              import("@/lib/quant-strategy").QuantKind,
              "shortline_factor"
            >
    const strategy_params =
      mode === "ai" ? null : buildStrategyParams(quant)

    onSubmit({
      name: name.trim(),
      strategy_type,
      strategy_params,
      ref_strategies:
        mode === "ai" && refStrategies.length ? refStrategies : null,
      model_row_id: mode === "ai" ? modelRowId : null,
      symbol: symbol.trim().toLowerCase(),
      symbol_name: symbolName,
      timeframe,
      start_date: startDate,
      end_date: endDate,
      data_channel: dataChannel,
      multi_segment: multiSeg,
      segment_count: segCount,
      side_mode: sideMode,
      margin_per_trade: marginPerTrade,
      leverage,
      margin_mode: marginMode,
      initial_cash: initialCash,
      risk_style: mode === "ai" ? fundStyle.riskStyle : "balanced",
      custom_prompt_enabled:
        mode === "ai" ? fundStyle.customPromptEnabled : false,
      custom_prompt:
        mode === "ai" && fundStyle.customPromptEnabled
          ? fundStyle.customPrompt.trim()
          : null,
      close_rules: {
        pnl_pct: pnlPct ? Number(pnlPct) : null,
        session_close: false,
      },
      stop_rules: {
        loss_pct: lossPct ? Number(lossPct) : null,
      },
    })
  }

  return (
    <div className="space-y-4">
      <StrategySection
        mode={mode}
        onMode={setMode}
        timeframe={timeframe}
        quant={quant}
        onQuant={setQuant}
        models={models}
        modelRowId={modelRowId}
        onModel={setModelRowId}
        symbol={symbol}
        onApplyFactorMeta={(sym, tf) => {
          // 选中收藏因子时，回填其品种与周期到回测表单
          if (sym && sym.trim()) {
            setSymbol(sym.trim().toLowerCase())
            setSymbolName("")
          }
          if (tf && tf.trim()) setTimeframe(tf.trim())
        }}
      />

      {/* SymbolPicker 自带「品种」标签，此处不再重复 */}
      <SymbolPicker
        symbol={symbol}
        symbolName={symbolName}
        onChange={(sym, n) => {
          setSymbol(sym)
          setSymbolName(n)
        }}
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label>回测区间（拖动或点击日期手动输入）</Label>
          <div className="flex items-center gap-2">
            <DataChannelSelect
              value={dataChannel}
              onChange={(c) => {
                setDataChannel(c)
                setChannelRange(null)
              }}
              symbol={symbol.trim().toLowerCase() || null}
              timeframe={timeframe}
              onRange={setChannelRange}
              kinds={["swap"]}
              className="w-56"
            />
            {timeframe !== "1d" && (
              <label className="flex items-center gap-1.5 text-xs cursor-pointer text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={multiSeg}
                  onChange={(e) => changeMultiSeg(e.target.checked)}
                  className="accent-[var(--primary)] cursor-pointer"
                />
                启用多段回测
              </label>
            )}
          </div>
        </div>
        {multiSeg && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span className="text-[var(--text-muted)]">段数</span>
            <select
              className="h-8 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
              value={segCount}
              onChange={(e) => changeSegCount(Number(e.target.value))}
            >
              {Array.from(
                { length: SEGMENT_MAX_COUNT - SEGMENT_MIN_COUNT + 1 },
                (_, i) => SEGMENT_MIN_COUNT + i,
              ).map((n) => (
                <option key={n} value={n}>
                  {n} 段
                </option>
              ))}
            </select>
            <span className="text-[var(--text-muted)]">
              每段 {maxDaysFor(timeframe)} 天 · 最少共{" "}
              {multiSegmentMinDays(timeframe, segCount)} 天
            </span>
          </div>
        )}
        <BacktestRangeSlider
          timeframe={timeframe}
          start={startDate}
          end={endDate}
          today={today}
          railStartISO={railMinISO ?? undefined}
          maxDaysOverride={multiSeg ? railDaysFor(timeframe, today) : undefined}
          minDays={multiSeg ? multiSegmentMinDays(timeframe, segCount) : undefined}
          onChange={(s, e) => {
            setStartDate(s)
            setEndDate(e)
          }}
          onRangeError={setRangeError}
        />
        {rangeError && (
          <p className="text-[11px] text-[var(--accent-danger)]">{rangeError}</p>
        )}
        {!rangeError && (
          <p className="text-[11px] text-[var(--text-muted)]">
            {multiSeg
              ? `提交后系统将在所选区间内随机抽取 ${segCount} 段（每段 ${maxDaysFor(
                  timeframe,
                )} 天）独立回测并汇总${mode === "ai" ? "；AI 调用按段均分" : ""}`
              : "日线可用长期历史库；分钟线依赖近端数据，区间上限按周期收紧"}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>K 线周期</Label>
          <select
            className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm"
            value={timeframe}
            onChange={(e) => changeTimeframe(e.target.value)}
          >
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
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
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-2">
          <Label>每笔保证金（USDT）</Label>
          <Input
            type="number"
            min={10}
            step={10}
            value={marginPerTrade}
            onChange={(e) => setMarginPerTrade(Number(e.target.value || 1000))}
          />
        </div>
        <div className="space-y-2">
          <Label>杠杆</Label>
          <Input
            type="number"
            min={1}
            max={125}
            value={leverage}
            onChange={(e) => setLeverage(Math.max(1, Math.min(125, Number(e.target.value || 5))))}
          />
        </div>
        <div className="space-y-2">
          <Label>保证金模式</Label>
          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                { v: "cross" as const, label: "全仓", hint: "共享保证金·不强平" },
                { v: "isolated" as const, label: "逐仓", hint: "独立强平线" },
              ]
            ).map(({ v, label, hint }) => (
              <button
                key={v}
                type="button"
                onClick={() => setMarginMode(v)}
                className={
                  "h-9 rounded-md border text-xs transition-colors " +
                  (marginMode === v
                    ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]")
                }
              >
                {label}
                <span className="ml-1 text-[10px] text-[var(--text-muted)]">{hint}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Label>初始资金（USDT）</Label>
          <Input
            type="number"
            min={10000}
            step={10000}
            value={initialCash}
            onChange={(e) => setInitialCash(Number(e.target.value || 10000))}
          />
        </div>
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">
        每笔名义 = 保证金 × 杠杆；数量自动按开仓价换算（USDT 永续口径）
      </p>

      {mode === "ai" && (
        <AiQuantRefPicker
          value={refStrategies}
          onChange={setRefStrategies}
        />
      )}

      {mode === "ai" && (
        <AiFundStyleFields
          value={{ ...fundStyle, allocatedCapital: initialCash }}
          onChange={(next) => {
            setFundStyle(next)
          }}
          timeframe={timeframe}
          capitalLabel="回测本金 / AI 资金仓（元）"
          capitalHint="上方「初始资金」即 AI 资金仓本金（独立虚拟账户，不划转模拟盘余额）。"
          showCapital={false}
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>止损 %（可选）</Label>
          <Input type="number"
            value={lossPct}
            placeholder="如 3"
            onChange={(e) => setLossPct(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>止盈 %（可选）</Label>
          <Input type="number"
            value={pnlPct}
            placeholder="如 5"
            onChange={(e) => setPnlPct(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>备注名称（可选）</Label>
        <Input
          value={name}
          placeholder="例如 PP 日线突破 2 月"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {error && (
        <div className="text-sm text-[var(--accent-danger)]">{error}</div>
      )}

      <Button validateNumbers
        className="w-full"
        disabled={submitting}
        onClick={() => handleSubmit()}
      >
        {submitting ? "回测执行中…" : "开始回测"}
      </Button>
    </div>
  )
}
