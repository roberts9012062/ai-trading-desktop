"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ProfitLockSettings } from "./profit-lock-settings"
import { buildProfitLockConfig, profitLockFromConfig, DEFAULT_PROFIT_LOCK, type ProfitLockFormState } from "@/lib/profit-lock"
import type {
  CloseRules,
  IndicatorExitItem,
} from "@/lib/ai-trading-api"

export interface RuleFormState {
  profitLock?: ProfitLockFormState
  pnlPct: string
  totalPnlPct: string
  sessionClose: boolean
  closeAi: boolean
  /** 平仓由决策模型自己决定（仅 decision 策略显示） */
  modelExit: boolean
  lossPct: string
  lossAmount: string
  stopAi: boolean
  /** 决策模型自主止损（仅 decision 策略显示；关=拦截模型平仓） */
  modelStop: boolean
  autoStart: boolean
  closeOnStop: boolean
  // —— 平仓标准扩展：技术指标（多选）——
  exitMacd: boolean
  exitMa: boolean
  exitKdj: boolean
  exitSwing: boolean
  maFast: string
  maSlow: string
  maType: "sma" | "ema"
  swingLeft: string
  swingRight: string
  swingMinRight: string
  // —— 平仓标准扩展：因子阈值 ——
  factorExitMode: "" | "decay" | "reach"
  factorExitLong: string
  factorExitShort: string
  // —— 兜底平仓（最高权重）：按保证金收益率触发 ——
  bottomTpOn: boolean
  bottomTpPct: string
  bottomSlOn: boolean
  bottomSlPct: string
  lossCooldownOn?: boolean
  lossCooldownLimit?: string
}

/** 空白规则表单（各弹窗在此基础上覆盖自己的默认值） */
export const EMPTY_RULE_FORM: RuleFormState = {
  profitLock: DEFAULT_PROFIT_LOCK,
  pnlPct: "",
  totalPnlPct: "",
  sessionClose: false,
  closeAi: true,
  modelExit: false,
  lossPct: "",
  lossAmount: "",
  stopAi: true,
  modelStop: false,
  autoStart: false,
  closeOnStop: true,
  exitMacd: false,
  exitMa: false,
  exitKdj: false,
  exitSwing: false,
  maFast: "5",
  maSlow: "20",
  maType: "sma",
  swingLeft: "3",
  swingRight: "3",
  swingMinRight: "3",
  factorExitMode: "",
  factorExitLong: "",
  factorExitShort: "",
  // 兜底平仓默认开启：止盈 20% / 止损 10%（相对保证金收益率）
  bottomTpOn: true,
  bottomTpPct: "20",
  bottomSlOn: true,
  bottomSlPct: "10",
  lossCooldownOn: true,
  lossCooldownLimit: "2",
}

interface CreateTaskRulesProps {
  /** Reuse only standard bottom controls in the independent hunter strategy. */
  bottomOnly?: boolean
  checkSeconds?: number
  cooldownScope?: "task" | "hunter"
  value: RuleFormState
  onChange: (next: RuleFormState) => void
  /** 量化规则策略传 false，不展示 AI 自主平仓/止损 */
  showAiOptions: boolean
  /** 决策模型任务展示「模型自己决定平仓」 */
  showModelExit?: boolean
  /** 决策模型任务展示「决策模型自主止损」 */
  showModelStop?: boolean
  /** 传 false 隐藏「创建后立即开始/结束任务时平掉持仓」生命周期选项
   * （运行中调整盈亏比例弹窗复用本组件时用） */
  showLifecycle?: boolean
  /** 技术指标平仓（AI / 量化任务均适用），默认展示 */
  showIndicatorExits?: boolean
  /** 因子阈值平仓：量化 factor 任务恒显；AI 任务挂载参考因子后显示 */
  showFactorExit?: boolean
  /** 因子来源说明（AI 任务=挂载的参考因子；量化 factor 任务=任务自身公式） */
  factorExitHint?: string
}

type ExitKindKey = "exitMacd" | "exitMa" | "exitKdj" | "exitSwing"

const EXIT_KIND_CHIPS: { key: ExitKindKey; label: string }[] = [
  { key: "exitMacd", label: "MACD 死叉/金叉" },
  { key: "exitMa", label: "均线 死叉/金叉" },
  { key: "exitKdj", label: "KDJ 死叉/金叉" },
  { key: "exitSwing", label: "波段 波峰/波谷反转" },
]

/** 平仓/止损/启停选项 */
export function CreateTaskRules({
  value,
  onChange,
  showAiOptions,
  showModelExit = false,
  showModelStop = false,
  showLifecycle = true,
  showIndicatorExits = true,
  showFactorExit = false,
  factorExitHint,
  bottomOnly = false,
  checkSeconds = 2,
  cooldownScope = "task",
}: CreateTaskRulesProps): React.JSX.Element {
  function patch(partial: Partial<RuleFormState>): void {
    onChange({ ...value, ...partial })
  }

  const decayMode = value.factorExitMode === "decay"
  const reachMode = value.factorExitMode === "reach"
  const factorPh = reachMode ? "0.80" : "0.15"

  const bottomLineSection = (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 space-y-2">
      <div className="text-xs font-medium text-amber-500/90">
        兜底平仓（最高权重）
      </div>
      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        按保证金收益率实时触发（约每 {checkSeconds} 秒检查），先于策略/AI 与普通止盈止损，二者互不影响。
        例：100U 保证金 × 5 倍，盈利 50U = 收益率 50%。
      </p>
      <div className="rounded border border-amber-500/20 p-2 space-y-1.5">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={value.lossCooldownOn !== false}
            onChange={(e) => patch({ lossCooldownOn: e.target.checked })} />
          亏损冷静期
        </label>
        <div className="flex items-center gap-2 text-xs">
          <span className="shrink-0">本日亏损平仓</span>
          <Input aria-label="冷静期亏损次数" type="number" min={1} max={10} step={1}
            className="w-20" disabled={value.lossCooldownOn === false}
            value={value.lossCooldownLimit ?? "2"}
            onChange={(e) => patch({ lossCooldownLimit: e.target.value })} />
          <span>次后停止开仓</span>
        </div>
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          {cooldownScope === "hunter" ? "本猎手的所有周期与子任务合计" : "每个任务独立"}累计，范围 1–10 次，默认 2 次。每轮全部平仓后扣开、平仓手续费亏损记一次；盈利不清零。
          北京时间每日 06:00 重置，冷静期继续执行止损和平仓。关闭后允许恢复开仓，重新开启沿用本日记录。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.bottomTpOn}
              onChange={(e) => patch({ bottomTpOn: e.target.checked })}
            />
            最大收益平仓
          </label>
          <Input type="number"
            placeholder="20"
            disabled={!value.bottomTpOn}
            value={value.bottomTpPct}
            onChange={(e) => patch({ bottomTpPct: e.target.value })}
          />
          <p className="text-[10px] text-[var(--text-muted)]">
            收益率达阈值即平 · 最小 10% · 无上限
          </p>
        </div>
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.bottomSlOn}
              onChange={(e) => patch({ bottomSlOn: e.target.checked })}
            />
            最大止损
          </label>
          <Input type="number"
            placeholder="10"
            disabled={!value.bottomSlOn}
            value={value.bottomSlPct}
            onChange={(e) => patch({ bottomSlPct: e.target.value })}
          />
          <p className="text-[10px] text-[var(--text-muted)]">
            亏损率达阈值即平 · 最小 5% · 无上限
          </p>
        </div>
      </div>
    </div>
  )

  if (bottomOnly) return bottomLineSection

  return (
    <>
      <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
        <div className="text-xs font-medium text-[var(--text-secondary)]">平仓标准</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[11px]">持仓收益%平仓</Label>
            <Input type="number"
              placeholder="如 5"
              value={value.pnlPct}
              onChange={(e) => patch({ pnlPct: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-[11px]">总收益%平仓</Label>
            <Input type="number"
              placeholder="如 10"
              value={value.totalPnlPct}
              onChange={(e) => patch({ totalPnlPct: e.target.value })}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={value.sessionClose}
            onChange={(e) => patch({ sessionClose: e.target.checked })}
          />
          收盘平仓
        </label>
        {showModelExit && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.modelExit}
              onChange={(e) => patch({ modelExit: e.target.checked })}
            />
            模型自己决定平仓
            <span className="text-[10px] text-[var(--text-muted)]">
              （决策模型自主判断何时平仓；技术指标/止损等硬规则仍优先执行）
            </span>
          </label>
        )}
        {showAiOptions && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.closeAi}
              onChange={(e) => patch({ closeAi: e.target.checked })}
            />
            AI 自主判断平仓
          </label>
        )}

        {showIndicatorExits && (
          <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
            <Label className="text-[11px]">技术指标平仓（可多选）</Label>
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              每根收盘K线检查；持多仓遇死叉/波段波峰反转平多，持空仓遇金叉/波段波谷反转平空。系统硬性执行，先于 AI 与策略信号。
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {EXIT_KIND_CHIPS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => patch({ [key]: !value[key] } as Partial<RuleFormState>)}
                  className={`h-8 rounded-md border text-[11px] transition-colors ${
                    value[key]
                      ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {value.exitMa && (
              <div className="grid grid-cols-3 gap-1.5">
                <div>
                  <Label className="text-[10px]">快线周期</Label>
                  <Input type="number"
                    placeholder="5"
                    value={value.maFast}
                    onChange={(e) => patch({ maFast: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-[10px]">慢线周期</Label>
                  <Input type="number"
                    placeholder="20"
                    value={value.maSlow}
                    onChange={(e) => patch({ maSlow: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-[10px]">均线类型</Label>
                  <div className="grid grid-cols-2 gap-1">
                    {(["sma", "ema"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => patch({ maType: t })}
                        className={`h-8 rounded-md border text-[10px] transition-colors ${
                          value.maType === t
                            ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                            : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        }`}
                      >
                        {t.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {value.exitSwing && (
              <>
                <div className="grid grid-cols-3 gap-1.5">
                  <div>
                    <Label className="text-[10px]">左分型根数</Label>
                    <Input type="number"
                      placeholder="3"
                      value={value.swingLeft}
                      onChange={(e) => patch({ swingLeft: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px]">右确认根数</Label>
                    <Input type="number"
                      placeholder="3"
                      value={value.swingRight}
                      onChange={(e) => patch({ swingRight: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px]">预确认右侧根数</Label>
                    <Input type="number"
                      placeholder="3"
                      value={value.swingMinRight}
                      onChange={(e) => patch({ swingMinRight: e.target.value })}
                    />
                  </div>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                  与图表波段信号同口径。预确认右侧根数调小（1~右确认根数）时，确认未凑满即提前平仓、更早离场，但预确认会随行情消失、有误平风险；设为右确认根数＝只用正式确认。
                </p>
              </>
            )}
          </div>
        )}

        {showFactorExit && (
          <div className="space-y-1.5 border-t border-[var(--border)] pt-2">
            <Label className="text-[11px]">因子阈值平仓</Label>
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              {reachMode
                ? "达到即平：因子值达到阈值即平仓（过热离场），且此时不开新仓防止开完立刻平。"
                : decayMode
                  ? "动能衰减：持多仓因子值跌破正阈值平多；持空仓因子值回升破负阈值平空。"
                  : "按因子仓位意图（-1~+1）双向设置平仓阈值，多空各自生效。"}
              {factorExitHint ? ` ${factorExitHint}` : ""}
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { mode: "" as const, label: "不启用" },
                  { mode: "decay" as const, label: "动能衰减" },
                  { mode: "reach" as const, label: "达到即平" },
                ]
              ).map(({ mode, label }) => (
                <button
                  key={mode || "off"}
                  type="button"
                  onClick={() => patch({ factorExitMode: mode })}
                  className={`h-8 rounded-md border text-[11px] transition-colors ${
                    value.factorExitMode === mode
                      ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {value.factorExitMode && (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <Label className="text-[10px]">平多阈值</Label>
                    <Input type="number"
                      placeholder={factorPh}
                      value={value.factorExitLong}
                      onChange={(e) => patch({ factorExitLong: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-[10px]">平空阈值</Label>
                    <Input type="number"
                      placeholder={factorPh}
                      value={value.factorExitShort}
                      onChange={(e) => patch({ factorExitShort: e.target.value })}
                    />
                  </div>
                </div>
                <p className="text-[10px] text-[var(--text-muted)]">
                  {reachMode
                    ? "建议 0.35~0.99（须高于因子开仓线 0.3）；留空默认 0.80"
                    : "建议 0.01~0.29（须低于因子开仓线 0.3）；留空默认 0.15"}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <ProfitLockSettings value={value.profitLock} onChange={profitLock => patch({ profitLock })} />
      <div className="rounded-md border border-[var(--border)] p-2.5 space-y-2">
        <div className="text-xs font-medium text-[var(--text-secondary)]">止损</div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[11px]">亏损%</Label>
            <Input type="number"
              placeholder="留空不启用百分比止损"
              value={value.lossPct}
              onChange={(e) => patch({ lossPct: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-[11px]">亏损额度(元)</Label>
            <Input type="number"
              placeholder="如 5000"
              value={value.lossAmount}
              onChange={(e) => patch({ lossAmount: e.target.value })}
            />
          </div>
        </div>
        {showAiOptions && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.stopAi}
              onChange={(e) => patch({ stopAi: e.target.checked })}
            />
            AI 自主执行止损
          </label>
        )}
        {showModelStop && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.modelStop}
              onChange={(e) => patch({ modelStop: e.target.checked })}
            />
            决策模型自主止损
            <span className="text-[10px] text-[var(--text-muted)]">
              （模型依据浮盈亏%自主判断何时止损；关闭则拦截模型的平仓指令）
            </span>
          </label>
        )}
      </div>

      {bottomLineSection}

      {showLifecycle && (
        <>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.autoStart}
              onChange={(e) => patch({ autoStart: e.target.checked })}
            />
            创建后立即开始
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.closeOnStop}
              onChange={(e) => patch({ closeOnStop: e.target.checked })}
            />
            结束任务时平掉该品种持仓
          </label>
        </>
      )}
    </>
  )
}

/** 规则表单 → close_rules 提交 payload（扩展平仓标准未配置时键省略 = 清空） */
export function buildCloseRulesPayload(
  rules: RuleFormState,
  aiAuto: boolean,
): CloseRules {
  const profitLock = buildProfitLockConfig(rules.profitLock)
  const out: CloseRules = {
    ...(profitLock ? { profit_lock: profitLock } : {}),
    pnl_pct: rules.pnlPct ? Number(rules.pnlPct) : null,
    total_pnl_pct: rules.totalPnlPct ? Number(rules.totalPnlPct) : null,
    session_close: rules.sessionClose,
    ai_auto: aiAuto,
  }
  if (rules.modelExit) out.model_exit = true
  const exits: IndicatorExitItem[] = []
  if (rules.exitMacd) exits.push({ kind: "macd_cross" })
  if (rules.exitMa) {
    exits.push({
      kind: "ma_cross",
      params: {
        fast_period: Math.max(1, Math.floor(Number(rules.maFast) || 5)),
        slow_period: Math.max(2, Math.floor(Number(rules.maSlow) || 20)),
        ma_type: rules.maType,
      },
    })
  }
  if (rules.exitKdj) exits.push({ kind: "kdj_cross" })
  if (rules.exitSwing) {
    const swingRight = Math.max(2, Math.floor(Number(rules.swingRight) || 3))
    const minRightRaw = Math.floor(Number(rules.swingMinRight) || swingRight)
    exits.push({
      kind: "swing_pivot",
      params: {
        left: Math.max(1, Math.floor(Number(rules.swingLeft) || 3)),
        right: swingRight,
        // 钳到 1~right：=right 只用正式确认；调小启用盘中预确认提前平仓
        min_right_live: Math.max(1, Math.min(swingRight, minRightRaw)),
      },
    })
  }
  if (exits.length > 0) out.indicator_exits = exits

  if (rules.factorExitMode) {
    const decay = rules.factorExitMode === "decay"
    const fallback = decay ? 0.15 : 0.8
    const lt = rules.factorExitLong ? Math.abs(Number(rules.factorExitLong)) : fallback
    const st = rules.factorExitShort ? Math.abs(Number(rules.factorExitShort)) : fallback
    out.factor_exit = {
      mode: rules.factorExitMode,
      long_threshold: Number.isFinite(lt) ? lt : fallback,
      short_threshold: Number.isFinite(st) ? st : fallback,
    }
  }
  return out
}

/** 兜底平仓表单 → 提交字段（开=数值，关=null；校验最小值） */
export function buildBottomPayload(
  rules: RuleFormState,
): { max_profit_pct: number | null; max_loss_pct: number | null; loss_cooldown_enabled: boolean; loss_cooldown_limit: number } {
  buildProfitLockConfig(rules.profitLock)
  const limit = Number(rules.lossCooldownLimit ?? "2")
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("冷静期亏损次数须为 1–10 的整数")
  }
  const tp = rules.bottomTpOn ? Number(rules.bottomTpPct) : NaN
  const sl = rules.bottomSlOn ? Number(rules.bottomSlPct) : NaN
  if (rules.bottomTpOn && (!Number.isFinite(tp) || tp < 10)) {
    throw new Error("兜底止盈百分比无效：开启后最小 10%")
  }
  if (rules.bottomSlOn && (!Number.isFinite(sl) || sl < 5)) {
    throw new Error("兜底止损百分比无效：开启后最小 5%")
  }
  return {
    max_profit_pct: rules.bottomTpOn ? tp : null,
    max_loss_pct: rules.bottomSlOn ? sl : null,
    loss_cooldown_enabled: rules.lossCooldownOn !== false,
    loss_cooldown_limit: limit,
  }
}

/** 任务 → 止盈止损表单状态（创建弹窗克隆预填 / 编辑弹窗共用） */
export function rulesFromTask(task: {
  close_rules?: unknown
  stop_rules?: unknown
  close_on_stop?: boolean | null
  max_profit_pct?: number | null
  max_loss_pct?: number | null
  loss_cooldown_enabled?: boolean
  loss_cooldown_limit?: number
}): RuleFormState {
  const c = (task.close_rules ?? {}) as Record<string, unknown>
  const s = (task.stop_rules ?? {}) as Record<string, unknown>
  const exits = Array.isArray(c.indicator_exits)
    ? (c.indicator_exits as Array<Record<string, unknown>>)
    : []
  const maParams = ((exits.find((e) => e?.kind === "ma_cross")?.params ??
    {}) as Record<string, unknown>)
  const swingParams = ((exits.find((e) => e?.kind === "swing_pivot")?.params ??
    {}) as Record<string, unknown>)
  const fx = (c.factor_exit ?? null) as Record<string, unknown> | null
  return {
    pnlPct: c.pnl_pct != null ? String(c.pnl_pct) : "",
    profitLock: profitLockFromConfig((c.profit_lock ?? undefined) as CloseRules["profit_lock"]),
    totalPnlPct: c.total_pnl_pct != null ? String(c.total_pnl_pct) : "",
    sessionClose: Boolean(c.session_close),
    closeAi: c.ai_auto !== false,
    modelExit: Boolean(c.model_exit),
    lossPct: s.loss_pct != null ? String(s.loss_pct) : "",
    lossAmount: s.loss_amount != null ? String(s.loss_amount) : "",
    stopAi: s.ai_auto !== false,
    modelStop: s.ai_auto !== false,
    autoStart: false,
    closeOnStop: task.close_on_stop !== false,
    exitMacd: exits.some((e) => e?.kind === "macd_cross"),
    exitMa: exits.some((e) => e?.kind === "ma_cross"),
    exitKdj: exits.some((e) => e?.kind === "kdj_cross"),
    exitSwing: exits.some((e) => e?.kind === "swing_pivot"),
    maFast: maParams.fast_period != null ? String(maParams.fast_period) : "5",
    maSlow: maParams.slow_period != null ? String(maParams.slow_period) : "20",
    maType: maParams.ma_type === "ema" ? "ema" : "sma",
    swingLeft: swingParams.left != null ? String(swingParams.left) : "3",
    swingRight: swingParams.right != null ? String(swingParams.right) : "3",
    swingMinRight:
      swingParams.min_right_live != null
        ? String(swingParams.min_right_live)
        : String(swingParams.right ?? "3"),
    factorExitMode:
      fx?.mode === "reach" ? "reach" : fx?.mode === "decay" ? "decay" : "",
    factorExitLong: fx?.long_threshold != null ? String(fx.long_threshold) : "",
    factorExitShort: fx?.short_threshold != null ? String(fx.short_threshold) : "",
    bottomTpOn: task.max_profit_pct != null,
    bottomTpPct:
      task.max_profit_pct != null ? String(task.max_profit_pct) : "20",
    lossCooldownOn: task.loss_cooldown_enabled !== false,
    lossCooldownLimit: String(task.loss_cooldown_limit ?? 2),
    bottomSlOn: task.max_loss_pct != null,
    bottomSlPct: task.max_loss_pct != null ? String(task.max_loss_pct) : "10",
  }
}
