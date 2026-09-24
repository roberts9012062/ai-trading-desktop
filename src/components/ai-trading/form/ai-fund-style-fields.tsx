"use client"

/**
 * AI 资金仓 / 策略风格 / 用户提示词 共用表单块
 * 创建任务、编辑任务、历史回测复用
 */

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export type RiskStyle = "aggressive" | "balanced" | "conservative"

export interface AiFundStyleState {
  allocatedCapital: number
  riskStyle: RiskStyle
  customPromptEnabled: boolean
  customPrompt: string
}

export const DEFAULT_AI_FUND_STYLE: AiFundStyleState = {
  allocatedCapital: 100000,
  riskStyle: "balanced",
  customPromptEnabled: false,
  customPrompt: "",
}

/** 周期 → 默认最长持仓天数（与后端 TIMEFRAME_MAX_HOLD_DAYS 一致） */
export function maxHoldDaysForTimeframe(timeframe: string): number {
  const tf = (timeframe || "").toLowerCase()
  if (tf === "1m") return 3
  if (tf === "5m") return 7
  if (tf === "15m" || tf === "30m") return 30
  if (tf === "60m") return 60
  return 90 // 1d
}

export function horizonLabel(timeframe: string): string {
  const d = maxHoldDaysForTimeframe(timeframe)
  if (d <= 2) return "超短线"
  if (d <= 10) return "中线"
  return "长线"
}

const RISK_OPTIONS: { value: RiskStyle; label: string; desc: string }[] = [
  {
    value: "aggressive",
    label: "激进",
    desc: "满仓倾向·快进·止盈可至用户目标约1.5倍·止损略宽·用满持仓上限",
  },
  {
    value: "balanced",
    label: "稳健",
    desc: "中等仓位·严格按您设定的止盈/止损/持仓上限执行（推荐）",
  },
  {
    value: "conservative",
    label: "保守",
    desc: "低仓·快进快出·约1/3用户止盈即兑现·止损更紧·持仓约上限一半",
  },
]

interface AiFundStyleFieldsProps {
  value: AiFundStyleState
  onChange: (next: AiFundStyleState) => void
  timeframe: string
  /** 回测场景：资金文案改为「回测本金」 */
  capitalLabel?: string
  capitalHint?: string
  showCapital?: boolean
  /** 宽屏双栏时压缩说明与提示词高度 */
  compact?: boolean
}

/** AI 资金仓 + 风格 + 可选用户提示词 */
export function AiFundStyleFields({
  value,
  onChange,
  timeframe,
  capitalLabel,
  capitalHint,
  showCapital,
  compact,
}: AiFundStyleFieldsProps): React.JSX.Element {
  const holdDays = maxHoldDaysForTimeframe(timeframe)
  const horizon = horizonLabel(timeframe)
  const showCap = showCapital !== false
  const isCompact = Boolean(compact)

  function patch(partial: Partial<AiFundStyleState>): void {
    onChange({ ...value, ...partial })
  }

  return (
    <div
      className={
        isCompact
          ? "space-y-2 rounded-md border border-[var(--border)] p-2.5 h-full"
          : "space-y-3 rounded-md border border-[var(--border)] p-3"
      }
    >
      <div className="text-xs font-medium text-[var(--text-secondary)]">
        AI 资金与策略风格
      </div>

      {showCap && (
        <div className="space-y-1">
          <Label>{capitalLabel || "AI 资金仓（元）"}</Label>
          <Input
            type="number"
            min={1000}
            step={1000}
            value={value.allocatedCapital}
            onChange={(e) =>
              patch({
                allocatedCapital: Math.max(
                  1000,
                  Number(e.target.value) || 1000,
                ),
              })
            }
          />
          <p className="text-[11px] text-[var(--text-muted)]">
            {capitalHint ||
              (isCompact
                ? "主账户→AI 资金仓真实划转；开平仓均从该仓流水，不占主账户可用。"
                : "从主账户可用余额真实划转到 AI 资金仓（流水 ai_transfer_out）；AI 开平仓保证金/手续费均从该仓走，不占主账户剩余可用。")}
          </p>
        </div>
      )}

      <div className="space-y-1">
        <Label>
          策略风格
          {value.customPromptEnabled ? (
            <span className="ml-2 text-[11px] font-normal text-amber-400/90">
              （已启用用户提示词，风格不生效）
            </span>
          ) : null}
        </Label>
        <select
          className="w-full h-9 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-sm disabled:opacity-50"
          value={value.riskStyle}
          disabled={value.customPromptEnabled}
          onChange={(e) =>
            patch({ riskStyle: e.target.value as RiskStyle })
          }
        >
          {RISK_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-[var(--text-muted)]">
          {value.customPromptEnabled
            ? "用户提示词开启后风格失效，按提示词执行；仍受止盈止损原值与持仓上限约束。"
            : RISK_OPTIONS.find((o) => o.value === value.riskStyle)?.desc}
        </p>
      </div>

      <div className="rounded bg-[var(--bg-secondary)]/60 px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
        周期{" "}
        <span className="text-[var(--text-primary)]">{timeframe}</span>
        ·
        <span className="text-amber-400/90"> {horizon} </span>
        · 持仓上限
        <span className="text-amber-400/90"> {holdDays} </span>
        天
        {!isCompact && (
          <span>
            。风格在您设定的止盈/止损/持仓范围内调节仓位、节奏与进出。
          </span>
        )}
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={value.customPromptEnabled}
            onChange={(e) =>
              patch({ customPromptEnabled: e.target.checked })
            }
            className="rounded border-[var(--border)]"
          />
          启用用户提示词（开启后策略风格失效）
        </label>
        {value.customPromptEnabled && (
          <div className="space-y-1">
            <Label>用户交易提示词</Label>
            <textarea
              className={
                isCompact
                  ? "w-full min-h-[72px] max-h-[140px] rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm resize-y"
                  : "w-full min-h-[96px] rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm resize-y"
              }
              maxLength={2000}
              placeholder="例如：只做趋势突破；避开隔夜重大数据；盈利 2% 分批止盈……"
              value={value.customPrompt}
              onChange={(e) => patch({ customPrompt: e.target.value })}
            />
            <p className="text-[11px] text-[var(--text-muted)]">
              {isCompact
                ? `用户提示词优先；风格不缩放。${value.customPrompt.length}/2000`
                : `用户提示词为最高业务执行准则；激进/稳健/保守不再缩放规则。仍须遵守止盈止损原值、持仓上限、仓位与资金仓。${value.customPrompt.length}/2000`}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
