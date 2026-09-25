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
import type { AITradingTask } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import { showConfirm } from "@/stores/dialog"
import { QUANT_KIND_OPTIONS } from "@/lib/quant-strategy"
import {
  CreateTaskRules,
  buildBottomPayload,
  buildCloseRulesPayload,
  rulesFromTask,
  type RuleFormState,
} from "@/components/ai-trading/form/create-task-rules"

const QUANT_STRATEGY_SET = new Set<string>(
  QUANT_KIND_OPTIONS.map((o) => o.value),
)

/** 当前是否有持仓（实盘=交易所持仓 / 虚拟盘=paper 持仓，快照来自任务列表接口） */
function hasLivePosition(task: AITradingTask | null): boolean {
  if (!task) return false
  return (
    task.position_direction != null && Number(task.position_qty ?? 0) > 0
  )
}

/** 调整止盈/止损与兜底平仓参数。
 * 无持仓：全部规则可改（运行/暂停/已结束均可，运行中下轮评估生效）；
 * 有持仓：仅允许改兜底平仓参数——已达阈值时保存即触发立即平仓（警告确认）。 */
export function EditRulesDialog({
  open,
  task,
  onClose,
}: {
  open: boolean
  task: AITradingTask | null
  onClose: () => void
}): React.JSX.Element {
  const updateRules = useAITradingStore((s) => s.updateRules)
  const [rules, setRules] = useState<RuleFormState>(
    rulesFromTask({
      close_rules: {},
      stop_rules: {},
      close_on_stop: true,
    }),
  )
  /** 杠杆倍数（运行中可改：仅影响后续新开仓，当前持仓保证金不变） */
  const [leverage, setLeverage] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stype = String(task?.strategy_type ?? "ai").toLowerCase()
  const quantMode = QUANT_STRATEGY_SET.has(stype)
  const decisionMode = stype === "decision"
  const withPosition = hasLivePosition(task)
  // 因子阈值平仓：量化 factor 任务用自身公式；AI 任务需已挂载参考因子
  const mountedTokens = (task?.strategy_params as Record<string, unknown> | null | undefined)
      ?.factor_tokens
  const showFactorExit =
    stype === "factor" || (!quantMode && Array.isArray(mountedTokens) && mountedTokens.length > 0)

  useEffect(() => {
    if (!open || !task) return
    setRules(rulesFromTask(task))
    setLeverage(task.leverage != null ? String(task.leverage) : "")
    setError(null)
  }, [open, task])

  /** 兜底阈值已越过的持仓 → 保存前弹警告（保存后引擎 2s 内立即平仓） */
  async function confirmBottomBreach(
    bottom: { max_profit_pct: number | null; max_loss_pct: number | null },
  ): Promise<boolean> {
    if (!task) return true
    const margin = Number(task.position_margin ?? 0)
    const unreal = Number(task.position_unrealized ?? 0)
    if (margin <= 0 || !withPosition) return true
    const roi = (unreal / margin) * 100
    const tp = bottom.max_profit_pct
    const sl = bottom.max_loss_pct
    if (tp != null && roi >= tp) {
      return showConfirm({
        title: "保存后将立即平仓",
        description: `当前持仓收益率 ${roi.toFixed(2)}%（浮盈 ${unreal.toFixed(2)} / 保证金 ${margin.toFixed(2)}）已达到兜底止盈 ${tp}%。保存后引擎将在数秒内强制平仓，不受策略/AI 影响。确认保存？`,
        variant: "destructive",
        confirmText: "确认并平仓",
      })
    }
    if (sl != null && roi <= -sl) {
      return showConfirm({
        title: "保存后将立即平仓",
        description: `当前持仓收益率 ${roi.toFixed(2)}%（浮亏 ${Math.abs(unreal).toFixed(2)} / 保证金 ${margin.toFixed(2)}）已达到兜底止损 ${sl}%。保存后引擎将在数秒内强制平仓，不受策略/AI 影响。确认保存？`,
        variant: "destructive",
        confirmText: "确认并平仓",
      })
    }
    return true
  }

  async function handleSubmit(): Promise<void> {
    if (!task) return
    setError(null)
    let bottom: ReturnType<typeof buildBottomPayload>
    try {
      bottom = buildBottomPayload(rules)
    } catch (err) {
      setError(err instanceof Error ? err.message : "兜底参数无效")
      return
    }
    // 杠杆（可选改）：1~100，仅影响后续新开仓
    let levPayload: { leverage?: number } = {}
    if (leverage.trim() !== "" && Number(leverage) !== Number(task.leverage ?? 0)) {
      const lev = Number(leverage)
      if (!Number.isFinite(lev) || lev < 1 || lev > 100) {
        setError("杠杆倍数须在 1~100 之间")
        return
      }
      levPayload = { leverage: Math.floor(lev) }
    }
    if (!(await confirmBottomBreach(bottom))) return
    setSubmitting(true)
    try {
      if (withPosition) {
        // 持仓中：仅兜底平仓参数与杠杆（后端同样拦截普通规则改动）
        await updateRules(task.id, { ...bottom, ...levPayload })
      } else {
        await updateRules(task.id, {
          close_rules: buildCloseRulesPayload(
            rules,
            decisionMode ? rules.modelExit : quantMode ? false : rules.closeAi,
          ),
          stop_rules: {
            loss_pct: rules.lossPct ? Number(rules.lossPct) : null,
            loss_amount: rules.lossAmount ? Number(rules.lossAmount) : null,
            ai_auto: decisionMode
              ? rules.modelStop
              : quantMode
                ? false
                : rules.stopAi,
          },
          ...bottom,
          ...levPayload,
        })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>调整盈亏比例</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-[var(--text-muted)]">
          {task ? `${task.name} · ${task.symbol.toUpperCase()}` : ""}
          {withPosition
            ? "　当前持仓中：仅可调整兜底平仓参数（最高权重）；普通止盈止损请平仓后修改。"
            : "　仅调整止盈/止损，任务状态不变；运行中的任务下一轮评估生效。"}
        </p>

        <div className="space-y-3 text-sm">
          <CreateTaskRules
            value={rules}
            onChange={setRules}
            showAiOptions={!quantMode && !decisionMode}
            showModelExit={decisionMode}
            showModelStop={decisionMode}
            showLifecycle={false}
            showFactorExit={showFactorExit}
            factorExitHint={
              stype === "factor" ? "因子来源：任务公式。" : "因子来源：任务挂载的参考因子。"
            }
            onlyBottomLine={withPosition}
          />

          {/* 杠杆倍数：运行中可改，仅影响后续新开仓 */}
          <div className="rounded-md border border-[var(--border)] p-2.5 space-y-1.5">
            <Label className="text-[11px]">杠杆倍数</Label>
            <Input
              placeholder="如 5（1~100）"
              value={leverage}
              onChange={(e) => setLeverage(e.target.value)}
            />
            <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
              数量 = 每笔保证金 × 杠杆 ÷ 价格。运行中修改
              <span className="text-[var(--text-secondary)]">仅对后续新开仓生效</span>
              （开仓前自动对齐交易所合约杠杆）；当前持仓的保证金与强平价由交易所按开仓时杠杆锁定，平仓后重开即按新杠杆执行。
            </p>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "保存中…" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
