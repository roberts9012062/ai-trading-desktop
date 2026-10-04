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
  name: "AI 多周期猎手", capital: 1000, leverage: 1, venue: "okx", margin_mode: "isolated", cycles: ["short", "medium", "long"],
  brain: "rules", model_id: null, rule_fallback: false, direction: "both", whitelist: [], blacklist: [],
  pool_size: 50, max_positions: 4, scan_seconds: 60, strategy_version: "hunter-v3",
}

export function CreateHunterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [config, setConfig] = useState<HunterConfig>(initial)
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
    if (config.strategy_version !== "hunter-v1" && !capabilities?.supported_versions?.includes(config.strategy_version!)) { setError("服务器尚未支持所选规则版本，请更新服务器或选择旧版规则"); return }
    if (!Number.isFinite(config.capital) || config.capital <= 0 || !config.cycles.length) { setError("请输入有效资金并选择至少一个周期"); return }
    try { validateLeverage(config.leverage) } catch (e) { setError(e instanceof Error ? e.message : "杠杆无效"); return }
    if (config.brain !== "rules" && !choices.some(m => m.id === config.model_id)) { setError("请选择对应类型的模型"); return }
    setBusy(true)
    try {
      await create({ ...config, name: config.name.trim(),
        profit_lock: buildProfitLockConfig(profitLock),
        model_id: config.brain === "rules" ? null : config.model_id })
      onClose()
    } catch (e) { setError(e instanceof Error ? e.message : "创建失败") } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={v => { if (!v && !busy) onClose() }}>
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>创建多周期猎手</DialogTitle>
        <DialogDescription>桌面寻找机会，服务器接管交易。同一账户同时只能运行一个猎手。</DialogDescription>
      </DialogHeader>
      <div className="rounded-md border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">
        当前账户：{capabilities ? hunterAccountLabel(capabilities.execution_mode ?? (capabilities.trading_mode === "virtual" ? "virtual" : undefined)) : "读取中…"}。新策略验证状态：未验证。
        桌面关闭后暂停搜索，服务器继续管理已挂载任务。杠杆可选 1–50 倍，默认 1 倍；资金可选逐仓或全仓。
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1"><Label htmlFor="hunter-profile">入场规则</Label><select id="hunter-profile" className={selectClass} value={config.strategy_version ?? "hunter-v1"} onChange={e => patch({ strategy_version: e.target.value as HunterConfig["strategy_version"] })}>
          <option value="hunter-v3">机会增强版 · 突破回踩 + 回调 + 短线延续</option><option value="hunter-v2">均衡版 · 突破回踩 + 趋势回调</option><option value="hunter-v1">原版 · 突破回踩</option>
        </select><p className="text-xs text-[var(--text-muted)]">{config.strategy_version === "hunter-v3" ? "短线排名前/后50%，增加趋势延续入口；BTC横盘可筛选自身趋势币，逆向趋势或冲击继续拦截。建议50个币＋短线＋双向，按小时显示信号与挂载结果，未达目标会提示；不因超时强制下单。" : "均衡版：排名前/后30%，短线量能1.3倍、信号有效180秒；原版保持原有条件。"} 尚未完成盈利验证。</p></div>
        <div className="space-y-1"><Label htmlFor="hunter-name">名称</Label><Input id="hunter-name" maxLength={120} value={config.name} onChange={e => patch({ name: e.target.value })} /></div>
        <div className="space-y-1"><Label htmlFor="hunter-capital">策略资金（USDT）</Label><Input id="hunter-capital" type="number" min={1} value={config.capital} onChange={e => patch({ capital: Number(e.target.value) })} /></div>
        <div className="space-y-1"><Label htmlFor="hunter-margin-mode">资金保证金模式</Label><select id="hunter-margin-mode" className={selectClass} value={config.margin_mode} onChange={e => patch({ margin_mode: e.target.value as HunterConfig["margin_mode"] })}>
          <option value="isolated">逐仓</option><option value="cross">全仓</option>
        </select></div>
        <div className="space-y-1"><Label htmlFor="hunter-leverage">杠杆倍率（1–50 倍）</Label><Input id="hunter-leverage" type="number" min={1} max={50} step={1} value={config.leverage} onChange={e => patch({ leverage: Number(e.target.value) })} /></div>
        <div className="space-y-1"><Label htmlFor="hunter-venue">行情交易所</Label><Input id="hunter-venue" value="OKX" readOnly /></div>
        <div className="space-y-1"><Label htmlFor="hunter-direction">交易方向</Label><select id="hunter-direction" className={selectClass} value={config.direction} onChange={e => patch({ direction: e.target.value as HunterConfig["direction"] })}>
          <option value="long">顺势做多</option><option value="both">顺势双向</option>
        </select></div>
      </div>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">交易周期与风险预算</legend>
        {(Object.keys(CYCLES) as Cycle[]).map(cycle => <label key={cycle} className="flex gap-3 items-start rounded-md border border-[var(--border)] px-3 py-2 text-sm">
          <input type="checkbox" checked={config.cycles.includes(cycle)} onChange={e => patch({ cycles: e.target.checked ? [...config.cycles, cycle] : config.cycles.filter(c => c !== cycle) })} />
          <span>{CYCLES[cycle].label} · 单笔风险 {CYCLES[cycle].risk*100}% · 第一目标 {CYCLES[cycle].target}R
            <span className="block text-xs text-[var(--text-muted)]">预算上限 {CYCLES[cycle].budget*100}%；结构止损、分批止盈、移动止损及时间退出。</span>
          </span>
        </label>)}
        <p className="text-xs text-[var(--text-muted)]">保留 20% 资金；单币仓位不超过 20%；合计初始风险不超过 1.2%。目标盈亏比不代表实际收益。</p>
        <p className="text-xs text-[var(--text-muted)]">保证金 = 仓位名义价值 ÷ 杠杆；手续费按完整仓位计算。杠杆不提高单笔风险预算或单币名义仓位上限；止损及估算成本超过初始保证金 50% 的机会会跳过，不会强行缩短结构止损。</p>
        <p className="text-xs text-[var(--text-muted)]">两种模式都遵守单笔止损与策略总风险限额。OKX API 模拟盘和实盘按交易设置中的凭证类型执行，并向交易所提交所选保证金模式和保护单；站内模拟撮合使用统一资金账本。</p>
      </fieldset>
      <ProfitLockSettings value={profitLock} onChange={setProfitLock} />
      <details className="rounded-md border border-[var(--border)] p-3 text-xs space-y-2">
        <summary className="cursor-pointer text-sm">下单、止盈和亏损平仓标准</summary>
        <p>只使用已收盘 K 线：币种趋势、上市时长和流动性合格，相对强弱进入合格区间。{config.strategy_version === "hunter-v3" ? "短线排名前/后50%，允许BTC横盘，拦截反向趋势及市场冲击；突破回踩、EMA20回调或短线趋势延续收盘确认后申请挂载，中长线保留均衡版条件。" : config.strategy_version === "hunter-v2" ? "排名前/后30%，大盘与币种同向；放量突破回踩或EMA20趋势回调企稳确认后申请挂载。" : "排名前/后20%，大盘与币种同向；放量突破、回踩及收盘确认后申请挂载。"}服务器再次复核报价、成本、风险预算及已有仓位，成本不得超过止损距离的20%。</p>
        <p>R 为实际入场价到初始止损的价格距离。短线：2R 平 30%，3R 平 30%；中线：3R 平 25%，5R 平 25%；长线：4R 平 20%，6R 平 20%。剩余仓位随趋势移动止损，实际整笔盈亏比单独统计。</p>
        <p>触及止损、累计净亏损达到单笔预算、结构/趋势失效、保护缺失或超过持仓期限时平仓。止损只能收紧，禁止亏损加仓。日亏损 2% 或周亏损 5% 暂停搜索，峰值回撤 8% 停止并退出持仓；某周期连亏 3 笔冷却 24 小时。</p>
        <p>盈利验收需独立样本外正期望和扣除全部成本后 PF ≥ 1.2，并通过执行验收；当前尚未取得这些证据。</p>
      </details>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1"><Label htmlFor="hunter-brain">策略大脑</Label><select id="hunter-brain" className={selectClass} value={config.brain} onChange={e => patch({ brain: e.target.value as HunterConfig["brain"], model_id: null, rule_fallback: false })}>
          <option value="rules">不选模型 · 规则模式</option><option value="llm">AI 大模型 · 候选审核</option><option value="jev">Jev · 决策模型</option>
        </select></div>
        {config.brain !== "rules" && <div className="space-y-1"><Label htmlFor="hunter-model">模型</Label><select id="hunter-model" className={selectClass} value={config.model_id ?? ""} onChange={e => patch({ model_id: e.target.value || null })}>
          <option value="">请选择模型</option>{choices.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
        </select></div>}
      </div>
      {config.brain !== "rules" && <div className="space-y-2">
        <p className="text-xs text-[var(--text-muted)]">模型须赞同规则方向且置信度至少 65%；仓位与止损仍由固定风控决定。</p>
        <label className="flex gap-2 items-center text-xs"><input type="checkbox" checked={config.rule_fallback} onChange={e => patch({ rule_fallback: e.target.checked })} />模型不可用时允许规则降级（默认关闭）</label>
      </div>}
      <details className="rounded-md border border-[var(--border)] p-3">
        <summary className="cursor-pointer text-sm">搜索参数</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <div><Label htmlFor="hunter-pool">扫描币池数量（5～50）</Label><Input id="hunter-pool" type="number" min={5} max={50} value={config.pool_size} onChange={e => patch({ pool_size: Number(e.target.value) })} /></div>
          <div><Label htmlFor="hunter-slots">最多持仓任务（1～4）</Label><Input id="hunter-slots" type="number" min={1} max={4} value={config.max_positions} onChange={e => patch({ max_positions: Number(e.target.value) })} /></div>
          <div><Label htmlFor="hunter-interval">扫描复查间隔（秒）</Label><Input id="hunter-interval" type="number" min={30} max={3600} value={config.scan_seconds} onChange={e => patch({ scan_seconds: Number(e.target.value) })} /><p className="text-xs text-[var(--text-muted)]">新版短线按此间隔复查；中线至少5分钟，长线至少30分钟。执行K线收盘后优先更新。</p></div>
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
        <Button disabled={busy || !ready || Boolean(existingHunter)} onClick={() => void submit()}>{busy ? "创建中…" : "开始执行"}</Button></div>
    </DialogContent>
  </Dialog>
}
