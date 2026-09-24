"use client"

import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { useAITradingStore } from "@/stores/ai-trading"
import { QUANT_KIND_OPTIONS } from "@/lib/quant-strategy"
import {
  CreateTaskRules,
  buildCloseRulesPayload,
  rulesFromTask,
  type RuleFormState,
} from "@/components/ai-trading/form/create-task-rules"

const QUANT_STRATEGY_SET = new Set<string>(
  QUANT_KIND_OPTIONS.map((o) => o.value),
)

/** 调整止盈/止损比例 —— 该品种无持仓即可（运行/暂停/已结束均可）。
 * 运行中的任务不暂停不改状态，下一轮评估直接按新规则执行。 */
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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stype = String(task?.strategy_type ?? "ai").toLowerCase()
  const quantMode = QUANT_STRATEGY_SET.has(stype)
  const decisionMode = stype === "decision"
  // 因子阈值平仓：量化 factor 任务用自身公式；AI 任务需已挂载参考因子
  const mountedTokens = (task?.strategy_params as Record<string, unknown> | null | undefined)
    ?.factor_tokens
  const showFactorExit =
    stype === "factor" || (!quantMode && Array.isArray(mountedTokens) && mountedTokens.length > 0)

  useEffect(() => {
    if (!open || !task) return
    setRules(rulesFromTask(task))
    setError(null)
  }, [open, task])

  async function handleSubmit(): Promise<void> {
    if (!task) return
    setError(null)
    setSubmitting(true)
    try {
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
      })
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
          　仅调整止盈/止损，任务状态不变；运行中的任务下一轮评估生效。
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
          />
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
