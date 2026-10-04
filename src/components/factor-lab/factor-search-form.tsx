"use client"

/**
 * 因子搜索表单 —— 合约/周期/种群/代数 + 教练控件
 */

import { gateResearchRange } from "@/lib/crypto-direct"
import { CRYPTO_RESEARCH_NOTE } from "@/lib/mining/crypto-profile"
import { championSeedsFor } from "@/lib/mining/champion-seeds"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Search } from "lucide-react"
import { getAIModels, getContractsApi, type ContractItem } from "@/lib/api"
import { chatModelsOnly } from "@/lib/decision-model"
import type { AIModel } from "@/types"
import { BacktestRangeSlider } from "@/components/backtest/backtest-range-slider"
import {
  defaultFactorRangeFor,
  factorMaxDaysFor,
} from "./factor-range-limits"
import { SymbolCombobox } from "./symbol-combobox"
import { DataChannelSelect } from "@/components/common/data-channel-select"
import { CryptoDataPanel } from "@/components/common/crypto-data-panel"
import { DEFAULT_KLINE_CHANNEL, LOCAL_DERIVATIVE_CHANNELS } from "@/lib/kline-channels"
import { FACTOR_HELP, HelpTip, LabelWithHelp } from "./help-tip"
import { CoachControls } from "./llm/coach-controls"
import { antiOverfitPayload } from "./hooks/factor-helpers"

const TIMEFRAMES = [
  { value: "1d", label: "日线" },
  { value: "60m", label: "60分" },
  { value: "30m", label: "30分" },
  { value: "15m", label: "15分" },
  { value: "5m", label: "5分" },
  { value: "1m", label: "1分" },
]

export interface SearchFormPayload {
  symbol: string
  timeframe: string
  population: number
  generations: number
  top_n: number
  seed: number
  /** null = 由后端按品种 tick + 手续费推导单边成本率 */
  cost: number | null
  use_llm_coach: boolean
  model_row_id: string | null
  /** 防过拟合：训练段占比（0=关闭） */
  train_ratio?: number
  /** 防过拟合：强制最近 N 根作测试段（0=关闭） */
  test_recent_bars?: number
  /** 防过拟合：walk-forward 折数（0=关闭） */
  walk_forward_folds?: number
  /** 本地增强挖掘(selection_v2 + evolve_v2):仅本地引擎生效,服务端忽略 */
  enhanced?: boolean
  /** 组合因子:末代自动组合优质/回捞因子(≤5)测超级因子(勾选「组合因子」) */
  combo_super?: boolean
  /** 冠军种子库 token(本地引擎注入种群头部;来自 G2 冻结合格冠军) */
  seed_tokens?: number[][]
  /** 长历史区间（YYYY-MM-DD，需与 end_date 成对；不传走近期数据） */
  start_date?: string
  end_date?: string
  /** 数据渠道(okx/binance_spot/gate_spot;本地引擎按渠道直连取数) */
  data_channel?: string
}

interface FactorSearchFormProps {
  defaultSymbol: string
  localEngine?: boolean
  loading: boolean
  onSearch: (payload: SearchFormPayload) => void
  onSymbolChange: (symbol: string) => void
}

/** 搜索表单 */
export function FactorSearchForm({
  defaultSymbol,
  localEngine = false,
  loading,
  onSearch,
  onSymbolChange,
}: FactorSearchFormProps): React.JSX.Element {
  const [symbol, setSymbol] = useState(defaultSymbol)
  const [timeframe, setTimeframe] = useState("1d")
  const [dataChannel, setDataChannel] = useState<string>(DEFAULT_KLINE_CHANNEL)
  // 数字输入按「文本态」持有,输入期不钳制——逐键 Math.max 会把用户正在敲的
  // "1"(想输 15/100)立即改写成 "10"/"3",小数字根本打不进去;失焦/提交时
  // 再统一收敛到合法区间
  const [population, setPopulation] = useState("30")
  const [generations, setGenerations] = useState("15")
  const clampInt = (raw: string, min: number, max: number, dflt: number): number => {
    const n = Math.round(Number(raw))
    if (!raw.trim() || !Number.isFinite(n)) return dflt
    return Math.max(min, Math.min(max, n))
  }
  const populationNum = (): number => clampInt(population, 10, 30000, 30)
  const generationsNum = (): number => clampInt(generations, 3, 1000, 15)
  const [contracts, setContracts] = useState<ContractItem[]>([])
  const [useCoach, setUseCoach] = useState(false)
  useEffect(() => { if ((!localEngine || useCoach) && (dataChannel === "gate_usdt" || dataChannel === "binance_usdt")) setDataChannel(DEFAULT_KLINE_CHANNEL) }, [localEngine, useCoach, dataChannel])
  const [modelRowId, setModelRowId] = useState("")
  const [models, setModels] = useState<AIModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  // 防过拟合开关（默认开启推荐配置：训练比例 0.7 + walk-forward 3 折）
  // train/test split 防"假 OOS"，walk-forward 防"单点时移失效"，二者叠加
  // 覆盖"训练好看、近期亏损"的过拟合。test_recent_bars 留 0，因绝对根数跨周期
  // 语义不一，仅作特殊场景手动开。
  // antiOverfitOn 是启用位（决定三参是否透传），showAntiOverfit 仅控制面板展开，
  // 二者必须解耦：曾用折叠状态当启用位，面板默认收起时防护以 0 发出。
  const [antiOverfitOn, setAntiOverfitOn] = useState(true)
  const [showAntiOverfit, setShowAntiOverfit] = useState(false)
  const [trainRatio, setTrainRatio] = useState(0.7)
  const [testRecentBars, setTestRecentBars] = useState(0)
  const [walkForwardFolds, setWalkForwardFolds] = useState(3)
  // 本地增强挖掘(默认开;服务端引擎忽略)
  const [enhanced, setEnhanced] = useState(true)
  // 组合因子(默认关):末代组合优质/回捞因子测超级因子,单因子全军覆没时的兜底
  const [comboSuper, setComboSuper] = useState(false)
  // 冠军种子库(G2 冻结证据合格冠军):本地增强搜索默认注入
  const [useChampionSeeds, setUseChampionSeeds] = useState(true)
  const seedPick = useMemo(
    () => championSeedsFor(symbol.trim().toLowerCase() || "BTCUSDT", timeframe),
    [symbol, timeframe],
  )
  // 长历史区间（默认关）：不启用时请求不带日期，走近期数据（与历史行为一致）；
  // 启用后走 pg-tickdata 长历史库（2005 起，具体合约自动拼接主力连续）。
  const [showLongHistory, setShowLongHistory] = useState(false)
  const [useLongHistory, setUseLongHistory] = useState(false)
  const today = useMemo(() => new Date(), [])
  const [rangeStart, setRangeStart] = useState(
    () => defaultFactorRangeFor("1d", new Date()).start,
  )
  const [rangeEnd, setRangeEnd] = useState(
    () => defaultFactorRangeFor("1d", new Date()).end,
  )
  const [rangeError, setRangeError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await getContractsApi()
        if (!cancelled) setContracts(data)
      } catch {
        // 未加载到合约时仍可手动输入
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setModelsLoading(true)
      try {
        const list = chatModelsOnly(await getAIModels())
        if (!cancelled) setModels(list)
      } catch {
        if (!cancelled) setModels([])
      } finally {
        if (!cancelled) setModelsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function handleSymbol(v: string): void {
    setSymbol(v)
    if (v.trim()) setSymbolError(null)
    onSymbolChange(v)
  }

  // 切换周期：同步重置到该周期允许的最近区间（与 backtest-form 同款原子更新，
  // 避免旧日期在新周期上限下算出非法区间；未启用长历史时也保持同步，
  // 用户切换后再开启时区间即为合法值）。
  function changeTimeframe(tf: string): void {
    setTimeframe(tf)
    const r = dataChannel === "gate_usdt" ? gateResearchRange(tf, today) : defaultFactorRangeFor(tf, today)
    setRangeStart(r.start)
    setRangeEnd(r.end)
    setRangeError(null)
  }

  const [symbolError, setSymbolError] = useState<string | null>(null)

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    const sym = symbol.trim().toLowerCase()
    if (!sym) {
      setSymbolError("请先选择合约（不再默认 rb2610）")
      return
    }
    setSymbolError(null)
    if (useCoach && !modelRowId) return
    onSearch({
      symbol: sym,
      timeframe,
      population: populationNum(),
      generations: generationsNum(),
      top_n: 10,
      seed: 42,
      cost: null,
      use_llm_coach: useCoach,
      model_row_id: useCoach ? modelRowId : null,
      ...antiOverfitPayload(antiOverfitOn, trainRatio, testRecentBars, walkForwardFolds),
      enhanced,
      combo_super: comboSuper,
      ...(localEngine && enhanced && useChampionSeeds && seedPick.seeds.length
        ? { seed_tokens: seedPick.seeds.map((s) => s.tokens) }
        : {}),
      ...(useLongHistory ? { start_date: rangeStart, end_date: rangeEnd } : {}),
      data_channel: dataChannel,
    })
  }

  return (
    <div className="space-y-3">
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end"
      >
        <div className="space-y-1.5 lg:col-span-2">
          <div className="flex items-center gap-1">
            <Label>合约</Label>
            <HelpTip text={FACTOR_HELP.symbol} side="bottom" align="center" className="" />
          </div>
          <SymbolCombobox
            value={symbol}
            onChange={handleSymbol}
            contracts={contracts}
          />
        </div>

        <div className="space-y-1.5 lg:col-span-2">
          <div className="flex items-center gap-1">
            <Label>周期</Label>
            <HelpTip text={FACTOR_HELP.timeframe} side="bottom" align="center" className="" />
          </div>
          <div className="grid grid-cols-6 gap-1">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.value}
                type="button"
                onClick={() => changeTimeframe(tf.value)}
                className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                  timeframe === tf.value
                    ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5 lg:col-span-2">
          <Label>数据渠道</Label>
          <DataChannelSelect
            extraChannels={localEngine && !useCoach ? LOCAL_DERIVATIVE_CHANNELS : undefined}
            value={dataChannel}
            onChange={(v) => {
              setDataChannel(v)
              if (v === "gate_usdt") {
                const range = gateResearchRange(timeframe)
                setRangeStart(range.start); setRangeEnd(range.end)
              }
            }}
            symbol={symbol.trim().toLowerCase() || null}
            timeframe={timeframe}
          />
          {localEngine && <CryptoDataPanel channel={dataChannel} symbol={symbol} />}
        </div>

        <div className="space-y-1.5 lg:col-span-2">
          <LabelWithHelp
            htmlFor="fl-pop"
            label="种群（10-30000）"
            help={FACTOR_HELP.population}
          />
          <Input required step={1}
            id="fl-pop"
            type="number"
            min={10}
            max={30000}
            value={population}
            onChange={(e) => setPopulation(e.target.value)}
            onBlur={() => setPopulation(String(populationNum()))}
            className="h-9"
          />
        </div>

        <div className="space-y-1.5 lg:col-span-2">
          <LabelWithHelp
            htmlFor="fl-gen"
            label="代数（3-1000）"
            help={FACTOR_HELP.generations}
          />
          <Input required step={1}
            id="fl-gen"
            type="number"
            min={3}
            max={1000}
            value={generations}
            onChange={(e) => setGenerations(e.target.value)}
            onBlur={() => setGenerations(String(generationsNum()))}
            className="h-9"
          />
        </div>

        <div className="lg:col-span-2">
          <Button
            type="submit"
            disabled={loading || (useCoach && !modelRowId)}
            className="h-9 w-full"
          >
            <Search className="w-4 h-4 mr-1" />
            {loading ? "搜索中…" : "开始搜索"}
          </Button>
        </div>
        <p className="text-[10px] text-[var(--text-muted)] sm:col-span-2 lg:col-span-6">
          超大参数（种群上千/代数百）建议选本地 GPU 引擎（粗排 390 万评估/秒 + 精算分片并行）；
          服务端引擎可能因服务器资源限制拒绝大规模请求。
        </p>
        {symbolError && (
          <p className="text-[11px] text-down sm:col-span-2 lg:col-span-6">
            {symbolError}
          </p>
        )}
      </form>

      {/* LLM 教练(路线 A)依赖服务端搜索协同,服务端引擎已下线故隐藏;
          仅本地引擎时勾选会静默回落服务端,隐藏入口最干净 */}
      {!localEngine && (
        <CoachControls
          enabled={useCoach}
          onEnabledChange={setUseCoach}
          models={models}
          modelRowId={modelRowId}
          onModelChange={setModelRowId}
          modelsLoading={modelsLoading}
        />
      )}

      {/* 长历史区间（默认关：不带日期 = 近期数据，与历史行为一致） */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowLongHistory((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          <span className="flex items-center gap-1">
            <span className="font-medium">长历史区间（高级）</span>
            {useLongHistory && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-[var(--primary)]/15 text-[var(--primary)] text-[10px]">
                已开启
              </span>
            )}
          </span>
          <span className="text-[var(--text-muted)]">
            {showLongHistory ? "▾" : "▸"}
          </span>
        </button>
        {showLongHistory && (
          <div className="px-4 py-3 space-y-2 border-t border-[var(--border)]">
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={useLongHistory}
                onChange={(e) => setUseLongHistory(e.target.checked)}
              />
              启用自选区间（长历史库 2005 起，具体合约自动拼接主力连续）
            </label>
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              不勾选：使用近期数据（日线约 500 根）。勾选后按下方区间回测/搜索，
              走 pg-tickdata 长历史库；区间上限按因子评估设定（日线 5 年 / 60分 1 年 / 15分 180 天 / 1分 30 天）。
            </p>
            {useLongHistory && (
              <>
                <BacktestRangeSlider
                  timeframe={timeframe}
                  maxDaysOverride={factorMaxDaysFor(timeframe)}
                  start={rangeStart}
                  end={rangeEnd}
                  today={today}
                  onChange={(s, e) => {
                    setRangeStart(s)
                    setRangeEnd(e)
                  }}
                  onRangeError={setRangeError}
                />
                {rangeError && (
                  <p className="text-[11px] text-amber-400/90">{rangeError}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* 防过拟合高级选项（默认开启 0.7/3；启用位与面板折叠状态解耦） */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAntiOverfit((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          <span className="flex items-center gap-1">
            <span className="font-medium">防过拟合（高级）</span>
            <HelpTip
              text={FACTOR_HELP.overfit_warning}
              side="bottom"
              align="center"
              className=""
            />
            {!showAntiOverfit && antiOverfitOn && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-[var(--primary)]/15 text-[var(--primary)] text-[10px]">
                已开启
              </span>
            )}
          </span>
          <span className="text-[var(--text-muted)]">
            {showAntiOverfit ? "▾" : "▸"}
          </span>
        </button>
        {showAntiOverfit && (
          <div className="px-4 py-3 space-y-3 border-t border-[var(--border)]">
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={antiOverfitOn}
                onChange={(e) => setAntiOverfitOn(e.target.checked)}
              />
              启用防过拟合（训练/测试切分 + Walk-Forward 样本外验证）
            </label>
            <div
              className={`grid grid-cols-1 sm:grid-cols-3 gap-3 transition-opacity ${
                antiOverfitOn ? "" : "opacity-50 pointer-events-none"
              }`}
            >
              <div className="space-y-1.5">
                <LabelWithHelp
                  htmlFor="fl-tr"
                  label="训练比例（0-0.9）"
                  help={FACTOR_HELP.train_ratio}
                />
                <Input
                  id="fl-tr"
                  type="number"
                  step={0.05}
                  min={0}
                  max={0.9}
                  value={trainRatio}
                  onChange={(e) =>
                    setTrainRatio(
                      Math.max(0, Math.min(0.9, Number(e.target.value) || 0)),
                    )
                  }
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <LabelWithHelp
                  htmlFor="fl-trb"
                  label="近期作测试（0=关）"
                  help={FACTOR_HELP.test_recent_bars}
                />
                <Input
                  id="fl-trb"
                  type="number"
                  step={10}
                  min={0}
                  max={20000}
                  value={testRecentBars}
                  onChange={(e) =>
                    setTestRecentBars(
                      Math.max(0, Math.min(20000, Number(e.target.value) || 0)),
                    )
                  }
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <LabelWithHelp
                  htmlFor="fl-wf"
                  label="Walk-Forward 折数（0-10）"
                  help={FACTOR_HELP.walk_forward_folds}
                />
                <Input
                  id="fl-wf"
                  type="number"
                  min={0}
                  max={10}
                  value={walkForwardFolds}
                  onChange={(e) =>
                    setWalkForwardFolds(
                      Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                    )
                  }
                  className="h-9"
                />
              </div>
            </div>
            <p className="text-[11px] text-[var(--text-muted)]">
              默认已开启推荐配置「训练比例 0.7 + Walk-Forward 3 折」，能筛掉只在某段行情
              赚钱、近期就失效的过拟合因子。如需关闭（回到改造前行为），取消勾选上方
              「启用防过拟合」；如要专治近期失效，可设「近期作测试 60」（日线约一个季度），
              优先级高于训练比例。
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">{CRYPTO_RESEARCH_NOTE}</p>
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={enhanced}
                onChange={(e) => setEnhanced(e.target.checked)}
              />
              增强挖掘（仅本地引擎）：同一因子的不同写法先去重再验证，测试段后半封存只评估一次，进化加点/收缩变异
            </label>
            <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={comboSuper}
                onChange={(e) => setComboSuper(e.target.checked)}
              />
              组合因子：挖掘结束时自动把优质/回捞因子组合成超级因子继续测试（最多 5 个）
            </label>
            {comboSuper && (
              <p className="text-[11px] text-[var(--text-muted)]">
                优先组合优质因子（合格 + 研究级）；没有优质因子时回捞失败因子里样本外仍盈利者。
                组合须通过「验证区每折 Sortino 为正 + 封存段 2× 成本仍盈利」才获得超级因子标志，
                不通过则本次挖掘产出全部不合格。
              </p>
            )}
            {localEngine && enhanced && (
              <div className="space-y-1">
                <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useChampionSeeds}
                    onChange={(e) => setUseChampionSeeds(e.target.checked)}
                  />
                  注入冠军种子：从 G2 冻结验证的合格因子族出发搜索
                </label>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {useChampionSeeds ? seedPick.note : "已关闭：完全随机起步（合格概率显著更低）"}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
