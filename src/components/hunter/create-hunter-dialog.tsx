import { MACD_MA20_VERSION, MACD_MA20_NAME, MACD_PERIODS, REBOUND_VERSION, hunterCycleLabel, type MacdPeriod } from "@/lib/hunter/macd-ma20"
import { MarginLeverageFields } from "@/components/ai-trading/form/margin-leverage-fields"
import { CreateTaskRules, EMPTY_RULE_FORM, buildBottomPayload } from "@/components/ai-trading/form/create-task-rules"
import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getAIModels } from "@/lib/api"
import { chatModelsOnly, decisionModelsOnly } from "@/lib/decision-model"
import type { AIModel } from "@/types"
import { useAuthStore } from "@/stores/auth"
import { useHunterStore } from "@/stores/hunter"
import { hunterApi, canStartHunter, hunterAccountLabel, type HunterCapabilities, type HunterConfig, type HunterSymbol } from "@/lib/hunter/api"
import { HunterSymbolMultiSelect } from "./symbol-multi-select"
import { ProfitLockSettings } from "@/components/ai-trading/form/profit-lock-settings"
import { DEFAULT_PROFIT_LOCK, buildProfitLockConfig } from "@/lib/profit-lock"
import { CYCLES, validateLeverage, type Cycle } from "@/lib/hunter/rules"

const selectClass = "w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm"
const initial: HunterConfig = {
  name: "AI 多周期猎手", leverage: 1, venue: "okx", margin_mode: "isolated", cycles: ["short", "medium", "long"],
  brain: "rules", model_id: null, rule_fallback: false, direction: "both", whitelist: [], blacklist: [],
  pool_size: 50, max_positions: 4, scan_seconds: 60, strategy_version: "hunter-v3",
}

export function CreateHunterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [config, setConfig] = useState<HunterConfig>(initial)
  const [bottomRules, setBottomRules] = useState(EMPTY_RULE_FORM)
  const isMacd = config.strategy_version === MACD_MA20_VERSION
  const isRebound = config.strategy_version === REBOUND_VERSION
  const isNewStrategy = isMacd || isRebound
  const [profitLock, setProfitLock] = useState(DEFAULT_PROFIT_LOCK)
  const [models, setModels] = useState<AIModel[]>([])
  const [symbols, setSymbols] = useState<HunterSymbol[]>([])
  const [symbolsLoading, setSymbolsLoading] = useState(false)
  const [symbolsError, setSymbolsError] = useState<string | null>(null)
  const [symbolsReload, setSymbolsReload] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [capabilities, setCapabilities] = useState<HunterCapabilities | null>(null)
  const mode = useAuthStore(s => s.user?.trading_mode)
  const create = useHunterStore(s => s.create)
  const existingHunter = useHunterStore(s => s.groups.find(g => g.status !== "stopped"))
  const patch = (values: Partial<HunterConfig>) => setConfig(s => ({ ...s, ...values }))
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setSymbolsLoading(true); setSymbolsError(null)
    void hunterApi.symbols(controller.signal).then(list => {
      if (!controller.signal.aborted) setSymbols(list)
    }).catch(e => {
      if (!controller.signal.aborted) setSymbolsError(e instanceof Error ? e.message : "OKX 币种加载失败")
    }).finally(() => { if (!controller.signal.aborted) setSymbolsLoading(false) })
    return () => controller.abort()
  }, [open, symbolsReload])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setReady(false); setCapabilities(null); setError(null)
    void hunterApi.capabilities().then(cap => {
      if (!cancelled) {
        setCapabilities(cap)
        setReady(canStartHunter(cap))
        if (!canStartHunter(cap)) setError(cap.reason || "服务器尚未接入猎手的 OKX API 执行，请更新服务器后重试。")
      }
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "服务器模块不可用") })
    void getAIModels().then(list => { if (!cancelled) setModels(list) }).catch(() => { if (!cancelled) setModels([]) })
    return () => { cancelled = true }
  }, [open, mode])
  const choices = config.brain === "jev" ? decisionModelsOnly(models) : chatModelsOnly(models)
  const submit = async () => {
    setError(null)
    if (existingHunter) { setError("当前账户已有未停止的多周期猎手，请先停止后再创建"); return }
    if (config.scan_location === "server" && !capabilities?.can_server_host) { setError("服务器托管仅限有效VIP或管理员"); return }
    if (config.strategy_version !== "hunter-v1" && !capabilities?.supported_versions?.includes(config.strategy_version!)) { setError("服务器尚未支持所选规则版本，请更新服务器或选择旧版规则"); return }
    if (!config.cycles.length) { setError("请选择至少一个周期"); return }
    try {
      if (isNewStrategy) {
        if (!Number.isInteger(config.leverage) || config.leverage < 1 || config.leverage > 100) throw new Error("杠杆范围为1–100倍")
        if (isRebound && (!(config.rebound_threshold_pct ?? 10) || (config.rebound_threshold_pct ?? 10) <= 0 || (config.rebound_threshold_pct ?? 10) > 50)) throw new Error("反弹柱体阈值须为0–50之间")
        buildBottomPayload(bottomRules)
      } else validateLeverage(config.leverage)
    } catch (e) { setError(e instanceof Error ? e.message : "参数无效"); return }
    if (config.brain !== "rules" && !choices.some(m => m.id === config.model_id)) { setError("请选择对应类型的模型"); return }
    setBusy(true)
    try {
      await create({ ...config, name: config.name.trim(),
        ...(isNewStrategy ? { ...buildBottomPayload(bottomRules), ...(isRebound ? { profit_lock: buildProfitLockConfig(profitLock) } : {}) } : { profit_lock: buildProfitLockConfig(profitLock) }),
        model_id: config.brain === "rules" ? null : config.model_id })
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : "创建失败") } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={v => { if (!v && !busy) onClose() }}>
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>创建多周期猎手</DialogTitle>
        <DialogDescription>可选择桌面搜索或服务器托管。同一账户同时只能运行一个猎手。</DialogDescription>
      </DialogHeader>
      <div className="rounded-md border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
        当前账户：{capabilities ? hunterAccountLabel(capabilities.execution_mode ?? (capabilities.trading_mode === "virtual" ? "virtual" : undefined)) : "读取中…"}。新策略验证状态：未验证。
        {config.scan_location === "server" ? "服务器托管后，关闭桌面仍会自动搜索和执行交易。" : "桌面关闭后暂停搜索，服务器继续管理已挂载任务。"}{isNewStrategy ? "按仓位管理设置执行，方向按所选做多/做空独立判断。" : "杠杆可选 1–50 倍，默认 1 倍；资金可选逐仓或全仓。"}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1"><Label htmlFor="hunter-profile">入场规则</Label><select id="hunter-profile" className={selectClass} value={config.strategy_version ?? "hunter-v1"} onChange={e => {
          const version = e.target.value as HunterConfig["strategy_version"]
          const toNew = version === MACD_MA20_VERSION || version === REBOUND_VERSION
          const fromNew = isMacd || isRebound
          patch({ strategy_version: version,
            ...(toNew ? {
              cycles: ["30m", "60m"], direction: version === REBOUND_VERSION ? "both" : "long", brain: "rules", model_id: null,
              leverage: 10, margin_mode: "cross", position_mode: "fixed_margin", margin_per_trade: 100,
              capital_usage_min_pct: 10, capital_usage_max_pct: 20,
              ...(version === REBOUND_VERSION ? { rebound_threshold_pct: 10 } : {}) } : {}),
            ...(!toNew && fromNew ? { cycles: ["short", "medium", "long"], leverage: 1, margin_mode: "isolated", direction: "both" } : {}) })
        }}>
          <option value={MACD_MA20_VERSION}>{MACD_MA20_NAME}</option><option value={REBOUND_VERSION}>反弹猎手 · 急跌抢反弹/急涨动能衰竭 · 锁利管理</option><option value="hunter-v4">波段持有版 · 计划净3:1 + 多周期延续 + 确认反转</option><option value="hunter-v3">机会增强版 · 突破回踩 + 回调 + 短线延续</option><option value="hunter-v2">均衡版 · 突破回踩 + 趋势回调</option><option value="hunter-v1">原版 · 突破回踩</option>
        </select><p className="text-xs text-[var(--text-muted)]">{isRebound ? `均值回归：做多=前两根阴线柱体合计≥${config.rebound_threshold_pct ?? 10}%×MA20，第二根收盘（第三根开盘）立即挂单买入；做空=前两根阳线柱体合计≥${config.rebound_threshold_pct ?? 10}%×MA20，第三根递减且距均线距离缩短才卖。盈利由锁利跟踪平仓，亏损由兜底止损保护；无技术指标平仓、不滚仓。` : isMacd ? (config.direction === "short" ? "5/15/30/60分钟分别扫描；MACD(12,26,9)处于死叉状态（不要求刚发生死叉），MA20拐头向下（持平不算），连续2–3根已收盘K线实体（开盘价和收盘价）严格在SMA20下方；实体穿线或触线中断计数，上影线可触线越线；达到4根不追空。" : config.direction === "both" ? "5/15/30/60分钟分别扫描；做多=MACD金叉状态（不要求刚发生）＋连续3–4根实体在SMA20上方＋MA20向上，超过4根跳过；做空=MACD死叉状态＋MA20向下＋连续2–3根实体在SMA20下方，达到4根不追空。同一时刻只满足其中一个方向。" : "5/15/30/60分钟分别扫描；MACD(12,26,9)处于金叉状态（DIF高于DEA，不要求刚发生），连续3–4根K线实体（开盘价和收盘价）在SMA20上方，穿线K线不计入，MA20向上。超过4根跳过。") : config.strategy_version === "hunter-v4" ? "50币双向、多周期趋势延续；服务器按最差限价和全部预计成本复核净3:1空间。趋势未反转可持有浮亏至结构止损；禁止摊平。" : config.strategy_version === "hunter-v3" ? "短线排名前/后50%，增加趋势延续入口；BTC横盘可筛选自身趋势币，逆向趋势或冲击继续拦截。建议50个币＋短线＋双向，按小时显示信号与挂载结果，未达目标会提示；不因超时强制下单。" : "均衡版：排名前/后30%，短线量能1.3倍、信号有效180秒；原版保持原有条件。"} 尚未完成盈利验证。</p></div>
        <div className="space-y-1"><Label htmlFor="hunter-name">名称</Label><Input id="hunter-name" maxLength={120} value={config.name} onChange={e => patch({ name: e.target.value })} /></div>
        {!isNewStrategy && <><div className="space-y-1"><Label htmlFor="hunter-margin-mode">资金保证金模式</Label><select id="hunter-margin-mode" className={selectClass} value={config.margin_mode} onChange={e => patch({ margin_mode: e.target.value as HunterConfig["margin_mode"] })}>
          <option value="isolated">逐仓</option><option value="cross">全仓</option>
        </select></div>
        <div className="space-y-1"><Label htmlFor="hunter-leverage">杠杆倍率（1–50 倍）</Label><Input id="hunter-leverage" type="number" min={1} max={50} step={1} value={config.leverage} onChange={e => patch({ leverage: Number(e.target.value) })} /></div></>}
        <div className="space-y-1"><Label htmlFor="hunter-venue">行情交易所</Label><Input id="hunter-venue" value="OKX" readOnly /></div>
        <div className="space-y-1"><Label htmlFor="hunter-direction">交易方向</Label><select id="hunter-direction" className={selectClass} value={config.direction} onChange={e => patch({ direction: e.target.value as HunterConfig["direction"] })}>
        {isNewStrategy ? <>
            {isMacd && <option value="long">做多 · MACD金叉＋实体在MA20上方</option>}
            {isMacd && <option value="short">做空 · MACD死叉＋实体在MA20下方</option>}
            {isRebound && <option value="long">只抢急跌反弹做多</option>}
            {isRebound && <option value="short">只做冲高回落做空</option>}
            <option value="both">双向 · 多空独立判断</option>
          </> : <>
            <option value="long">顺势做多</option>
            <option value="both">顺势双向</option>
          </>}
        </select></div>
      </div>
      <section className="space-y-2 rounded-md border border-[var(--border)] p-3">
        <Label htmlFor="hunter-scan-location">扫描运行位置</Label>
        <select id="hunter-scan-location" className={selectClass} value={config.scan_location ?? "desktop"} onChange={e => patch({ scan_location: e.target.value as "desktop" | "server" })}>
          <option value="desktop">桌面扫描</option>
          <option value="server" disabled={!capabilities?.server_hosting_available || !capabilities.can_server_host}>服务器托管 · VIP / 管理员</option>
        </select>
        <p className="text-xs text-[var(--text-muted)]">{config.scan_location === "server" ? "服务器自动扫描、挂载并执行交易，关闭客户端或退出登录后继续运行。" : "客户端开启时搜索新机会；已挂载持仓由服务器继续管理。"} 服务器托管仅限有效VIP，管理员可直接使用。</p>
      </section>
      {isNewStrategy && <>
        <fieldset className="space-y-2"><legend className="text-sm font-medium">交易周期</legend>
          <div className="grid grid-cols-2 gap-2">{(Object.keys(MACD_PERIODS) as MacdPeriod[]).map(period => <label key={period} className="flex items-center gap-2 rounded-md border border-[var(--border)] p-3 text-sm">
            <input type="checkbox" checked={config.cycles.includes(period)} onChange={e => patch({ cycles: e.target.checked ? [...config.cycles, period] : config.cycles.filter(x => x !== period) })} />{hunterCycleLabel(period)}
          </label>)}</div><p className="text-xs text-[var(--text-muted)]">各周期独立判断和管理交易；同一币种已有任务或持仓时跳过，避免重复接管。</p>
        </fieldset>
        <section className="space-y-3 rounded-md border border-[var(--border)] p-3">
          <Label htmlFor="hunter-position-mode">仓位管理</Label>
          <select id="hunter-position-mode" className={selectClass} value={config.position_mode ?? "fixed_margin"} onChange={e => patch({ position_mode: e.target.value as HunterConfig["position_mode"] })}>
            <option value="fixed_margin">指定每笔保证金</option><option value="capital_pct">资金使用范围</option>
            <option value="half">半仓（预算一半）</option><option value="full">全仓（全部预算）</option><option value="scale_in">滚仓（盈利加层）</option>
          </select>
          <MarginLeverageFields value={{ marginPerTrade: config.margin_per_trade ?? 100, leverage: config.leverage, marginMode: config.margin_mode }}
            onChange={v => patch({ margin_per_trade: v.marginPerTrade, leverage: v.leverage, margin_mode: v.marginMode })}
            scaleIn={config.position_mode === "scale_in"} budgetOnly={["half", "full", "capital_pct"].includes(config.position_mode ?? "")} />
          {config.position_mode === "capital_pct" && <div className="grid grid-cols-2 gap-2">
            <div><Label htmlFor="hunter-capital-min">资金使用下限 %</Label><Input id="hunter-capital-min" type="number" min={0} max={100} value={config.capital_usage_min_pct ?? 10} onChange={e => patch({ capital_usage_min_pct: Number(e.target.value) })} /></div>
            <div><Label htmlFor="hunter-capital-max">资金使用上限 %</Label><Input id="hunter-capital-max" type="number" min={1} max={100} value={config.capital_usage_max_pct ?? 20} onChange={e => patch({ capital_usage_max_pct: Number(e.target.value) })} /></div>
          </div>}
          <p className="text-xs text-[var(--text-muted)]">数量 = 保证金 × 杠杆 ÷ 价格。半仓/全仓按下单时实际可用资金计算，并预留成交手续费。资金使用范围在规则模式下使用上限；AI审核只决定是否入场。滚仓浮盈且出现新的合格金叉才加层，最多3层，超过4根不追入。</p>
        </section>
        {isRebound && <section className="space-y-2 rounded-md border border-[var(--border)] p-3">
          <Label htmlFor="hunter-rebound-threshold">反弹柱体阈值（两根合计占 MA20 的 %，0–50）</Label>
          <Input id="hunter-rebound-threshold" type="number" min={0.5} max={50} step={0.5} value={config.rebound_threshold_pct ?? 10}
            onChange={e => patch({ rebound_threshold_pct: Number(e.target.value) })} />
          <p className="text-xs text-[var(--text-muted)]">做多：前两根阴线柱体高度之和 ≥ 该百分比×MA20，第二根收盘（第三根开盘）立即挂单买入，信号只在第三根K线内有效；做空：前两根阳线柱体之和 ≥ 该百分比×MA20 且第三根递减、距均线距离缩短才触发。默认 10%，多空共用同一设置。</p>
        </section>}
        <CreateTaskRules value={bottomRules} onChange={setBottomRules} showAiOptions={false} bottomOnly checkSeconds={5} cooldownScope="hunter" />
      </>}
      {!isNewStrategy && <fieldset className="space-y-2"><legend className="text-sm font-medium">交易周期与风险预算</legend>
        {(Object.keys(CYCLES) as Cycle[]).map(cycle => <label key={cycle} className="flex gap-3 items-start rounded-md border border-[var(--border)] px-3 py-2 text-sm">
          <input type="checkbox" checked={config.cycles.includes(cycle)} onChange={e => patch({ cycles: e.target.checked ? [...config.cycles, cycle] : config.cycles.filter(c => c !== cycle) })} />
          <span>{CYCLES[cycle].label} · 单笔风险 {CYCLES[cycle].risk*100}% · {config.strategy_version === "hunter-v4" ? `扣费后目标 ≥ ${Math.max(3, CYCLES[cycle].target)}:1` : `第一目标 ${CYCLES[cycle].target}R`}
            <span className="block text-xs text-[var(--text-muted)]">预算上限 {CYCLES[cycle].budget*100}%；{config.strategy_version === "hunter-v4" ? "全仓波段持有、盈利保护与确认反转退出。" : "结构止损、分批止盈、移动止损及时间退出。"}</span>
          </span>
        </label>)}
        <p className="text-xs text-[var(--text-muted)]">服务器按创建时账户可用资金建立风险基准，每次开仓复核实际可用保证金。保留 20% 资金；单币仓位不超过 20%；合计初始风险不超过 1.2%。目标盈亏比不代表实际收益。</p>
        <p className="text-xs text-[var(--text-muted)]">保证金 = 仓位名义价值 ÷ 杠杆；手续费按完整仓位计算。杠杆不提高单笔风险预算或单币名义仓位上限；止损及估算成本超过初始保证金 50% 的机会会跳过，不会强行缩短结构止损。</p>
        <p className="text-xs text-[var(--text-muted)]">两种模式都遵守单笔止损与策略总风险限额。OKX API 模拟盘和实盘按交易设置中的凭证类型执行，并向交易所提交所选保证金模式和保护单；站内模拟撮合使用统一资金账本。</p>
      </fieldset>}
      {!isNewStrategy && <ProfitLockSettings value={profitLock} onChange={setProfitLock} />}
      {isRebound && <section className="space-y-2">
        <p className="text-sm font-medium">锁利设置（反弹策略的盈利平仓方式）</p>
        <ProfitLockSettings value={profitLock} onChange={setProfitLock} />
      </section>}
      {isNewStrategy ? <div className="rounded-md border border-[var(--border)] p-3 text-xs space-y-2">
        <p className="font-medium">平仓标准</p><p>① 兜底收益率达到设置的止盈或止损值，优先全平。</p>
        {isMacd && config.direction !== "short" && <p>② 做多：所属交易周期的 MA20 拐头向下、MACD 处于死叉状态、连续至少3根已收盘K线实体（开盘价和收盘价）都在各自 MA20 下方，三项同时满足才全平。</p>}
        {isMacd && config.direction !== "long" && <p>② 做空：出现完整做多入场信号（MACD金叉状态＋MA20向上＋连续3–4根已收盘K线实体在各自 MA20 上方）时平掉空仓；平空不自动反手开多，做多开仓由做多策略独立判断并遵守仓位、冷静期及重复开仓限制。</p>}
        {isRebound && <p>② 锁利：净收益达到激活线后开始跟踪峰值，回吐超过让利幅度即全平锁住利润；按持仓方向计算多空盈亏（空头=入场价−现价）。反弹策略无技术指标平仓、不做滚仓加层。</p>}
        <p>技术指标使用已收盘K线，MA20为20根K线的简单均线。MA20持平不算拐头；穿线或触线的K线实体不计入连续根数。持仓后的平仓按该笔交易所属周期判断，不混用周期。兜底平仓优先执行。创建后自动开始扫描。</p>
      </div> : <details className="rounded-md border border-[var(--border)] p-3 text-xs space-y-2">
        <summary className="cursor-pointer text-sm">下单、止盈和亏损平仓标准</summary>
        <p>只使用已收盘 K 线：币种趋势、上市时长和流动性合格，相对强弱进入合格区间。{config.strategy_version === "hunter-v4" ? "保留三路短线入口，中长线增加受限趋势延续；重要阻力/支撑阻挡净3:1目标时跳过。" : config.strategy_version === "hunter-v3" ? "短线排名前/后50%，允许BTC横盘，拦截反向趋势及市场冲击；突破回踩、EMA20回调或短线趋势延续收盘确认后申请挂载，中长线保留均衡版条件。" : config.strategy_version === "hunter-v2" ? "排名前/后30%，大盘与币种同向；放量突破回踩或EMA20趋势回调企稳确认后申请挂载。" : "排名前/后20%，大盘与币种同向；放量突破、回踩及收盘确认后申请挂载。"}服务器再次复核报价、成本、风险预算及已有仓位，成本不得超过止损距离的20%。</p>
        {config.strategy_version === "hunter-v4" ? <p>净风险单位包含初始止损与预计全部成本；达到1倍净风险保本、2倍至少锁0.5倍，3倍锁净峰值60%，继续持有波段。EMA20、MACD动量、RSI、连续结构破位与量能确认反转才退出；迟缓单独不平仓，确认回撤后收紧ATR保护。硬止损、盈利保护和用户锁利可先触发。退出后同币同向至少等两根执行K线和新信号。计划3:1不等于实际平均盈亏比3:1。</p> : <p>R 为实际入场价到初始止损的价格距离。短线：2R 平 30%，3R 平 30%；中线：3R 平 25%，5R 平 25%；长线：4R 平 20%，6R 平 20%。剩余仓位随趋势移动止损，实际整笔盈亏比单独统计。</p>}
        <p>触及止损、累计净亏损达到单笔预算、结构/趋势失效、保护缺失或超过持仓期限时平仓。止损只能收紧，禁止亏损加仓。日亏损 2% 或周亏损 5% 暂停搜索，峰值回撤 8% 停止并退出持仓；某周期连亏 3 笔冷却 24 小时。</p>
        <p>盈利验收需独立样本外正期望和扣除全部成本后 PF ≥ 1.2，并通过执行验收；当前尚未取得这些证据。</p>
        {config.strategy_version === "hunter-v4" && <p>开发重放的21笔完整交易实际平均盈亏比约1.55、PF约0.77、净收益为负，未达到实际3:1。窗口仅24小时且缺少历史资金费和深度；后续需要独立样本验证。</p>}
      </details>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1"><Label htmlFor="hunter-brain">策略大脑</Label><select id="hunter-brain" className={selectClass} value={config.brain} onChange={e => patch({ brain: e.target.value as HunterConfig["brain"], model_id: null, rule_fallback: false })}>
          <option value="rules">不选模型 · 规则模式</option><option value="llm">AI 大模型 · 候选审核</option><option value="jev">Jev · 决策模型</option>
        </select></div>
        {config.brain !== "rules" && <div className="space-y-1"><Label htmlFor="hunter-model">模型</Label><select id="hunter-model" className={selectClass} value={config.model_id ?? ""} onChange={e => patch({ model_id: e.target.value || null })}>
          <option value="">请选择模型</option>{choices.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
        </select></div>}
      </div>
      {config.brain !== "rules" && <div className="space-y-2">
        <p className="text-xs text-[var(--text-muted)]">模型须赞同规则方向且置信度至少 65%；{isNewStrategy ? (isRebound ? "仓位按仓位管理设置，平仓按兜底止损与锁利。" : "仓位按仓位管理设置，平仓按兜底与联合技术条件。") : "仓位与止损仍由固定风控决定。"}</p>
        <label className="flex gap-2 items-center text-xs"><input type="checkbox" checked={config.rule_fallback} onChange={e => patch({ rule_fallback: e.target.checked })} />模型不可用时允许规则降级（默认关闭）</label>
      </div>}
      <details className="rounded-md border border-[var(--border)] p-3">
        <summary className="cursor-pointer text-sm">搜索参数</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <div><Label htmlFor="hunter-pool">扫描币池数量（5～200）</Label><Input id="hunter-pool" type="number" min={5} max={200} value={config.pool_size} onChange={e => patch({ pool_size: Number(e.target.value) })} /><p className="text-xs text-[var(--text-muted)]">按 24 小时成交额从大到小取前 N 个最活跃币种，默认 50；运行中也可在猎手面板随时调整。</p></div>
          <div><Label htmlFor="hunter-slots">最多持仓任务（1～4）</Label><Input id="hunter-slots" type="number" min={1} max={4} value={config.max_positions} onChange={e => patch({ max_positions: Number(e.target.value) })} /></div>
          <div><Label htmlFor="hunter-interval">扫描复查间隔（秒）</Label><Input id="hunter-interval" type="number" min={30} max={3600} value={config.scan_seconds} onChange={e => patch({ scan_seconds: Number(e.target.value) })} /><p className="text-xs text-[var(--text-muted)]">{isMacd ? "5/15/30/60分钟均按此间隔复查，信号只在各自K线收盘后确认。" : "新版短线按此间隔复查；中线至少5分钟，长线至少30分钟。执行K线收盘后优先更新。"}</p></div>
          <HunterSymbolMultiSelect id="hunter-white" label="白名单" value={config.whitelist} options={symbols}
            onChange={whitelist => patch({ whitelist })} max={50} loading={symbolsLoading} error={symbolsError}
            onRetry={() => setSymbolsReload(n => n + 1)} hint="留空不限制币种；选中后只搜索这些币种，最多 50 个。" />
          <HunterSymbolMultiSelect id="hunter-black" label="黑名单" value={config.blacklist} options={symbols}
            onChange={blacklist => patch({ blacklist })} max={100} loading={symbolsLoading} error={symbolsError}
            onRetry={() => setSymbolsReload(n => n + 1)} hint="选中币种不参与搜索，最多 100 个；同时出现在白名单时仍排除。" />
        </div>
      </details>
      <p className="text-xs text-[var(--text-muted)]">这套规则不依赖因子挖掘。CPU/GPU 研究继续使用现有超级因子功能，未验证或无法在服务器复现的结果不会自动用于交易。</p>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {existingHunter && <p role="alert" className="text-xs text-amber-400">当前账户已有未停止的猎手“{existingHunter.name}”，请先停止后再创建。</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
        <Button validateNumbers disabled={busy || !ready || Boolean(existingHunter)} onClick={() => void submit()}>{busy ? "创建中…" : "开始执行"}</Button></div>
    </DialogContent>
  </Dialog>
}
