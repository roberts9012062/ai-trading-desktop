"use client"

import { AlertTriangle, Loader2, Repeat, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { DecisionList } from "@/components/ai-trading/detail/decision-list"
import { TradeList } from "@/components/ai-trading/detail/trade-list"
import {
  STATUS_LABEL,
  statusKey,
} from "@/components/ai-trading/task-list-helpers"
import { RunLogList } from "@/components/ai-trading/detail/run-log-list"
import { TaskProfitView } from "@/components/ai-trading/detail/task-profit-view"
import { TaskIcon } from "@/components/ai-trading/task-icon"
import { TaskActions } from "@/components/ai-trading/task-actions"
import type {
  AITradingDecision,
  AITradingTask,
} from "@/lib/ai-trading-api"
import { getAIModels } from "@/lib/api"
import { chatModelsOnly } from "@/lib/decision-model"
import type { AIModel } from "@/types"
import { useAITradingStore } from "@/stores/ai-trading"
import { formatDisplayTime } from "@/lib/utils"

interface TaskDetailDrawerProps {
  open: boolean
  task: AITradingTask | null
  decisions: AITradingDecision[]
  trades: Record<string, unknown>[]
  loading: boolean
  onClose: () => void
  onEdit?: (task: AITradingTask) => void
  /** 无持仓时调整盈亏比例（运行中也允许） */
  onEditRules?: (task: AITradingTask) => void
  /** 只读模式（策略收藏夹详情）：隐藏评估/结束/删除/换模型等操作，
   * 新增「收益」页签（累计收益+总收益柱状图+已运行时长） */
  readOnly?: boolean
}

/** 判定决策是否为模型异常（reason 前缀） */
function isModelErrorDecision(d: AITradingDecision | undefined): boolean {
  if (!d) return false
  const reason = d.reason || ""
  return (
    reason.startsWith("模型异常") ||
    (reason.startsWith("模型HTTP") && !reason.startsWith("模型HTTP2"))
  )
}

/** 常驻换模型区（AI 任务）：下拉随时更换 AI 交易员 */
function ModelSwitchSection({ task }: { task: AITradingTask }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [models, setModels] = useState<AIModel[]>([])
  const [selected, setSelected] = useState(task.model_row_id ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const switchModel = useAITradingStore((s) => s.switchModel)

  useEffect(() => {
    if (!expanded) return
    if (models.length > 0) return
    void getAIModels()
      .then((list) => setModels(chatModelsOnly(list)))
      .catch(() => setModels([]))
  }, [expanded, models.length])

  // 抽屉切到别的任务时同步选中与收起
  useEffect(() => {
    setSelected(task.model_row_id ?? "")
    setExpanded(false)
    setError(null)
  }, [task.id, task.model_row_id])

  async function handleSwitch(): Promise<void> {
    if (!selected) {
      setError("请选择一个模型")
      return
    }
    if (selected === task.model_row_id) {
      setError("新模型与当前模型相同")
      return
    }
    setError(null)
    setBusy(true)
    try {
      await switchModel(task.id, selected)
      setExpanded(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)]/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-[var(--text-muted)] shrink-0">AI 交易员</span>
        <span className="text-xs text-[var(--text-secondary)] truncate flex-1">
          {task.model_display_name || task.model_id || "--"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 h-7"
          disabled={busy}
          onClick={() => setExpanded((v) => !v)}
        >
          <Repeat className="w-3.5 h-3.5" />
          <span className="ml-1">更换模型</span>
        </Button>
      </div>

      {expanded && (
        <div className="pt-2 mt-2 border-t border-[var(--border)] space-y-2">
          <div className="flex items-center gap-2">
            <select
              className="flex-1 h-8 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-xs text-[var(--text-primary)]"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={busy}
            >
              {models.length === 0 && <option value="">加载中...</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name} ({m.provider_name})
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="default"
              disabled={busy || !selected}
              onClick={() => void handleSwitch()}
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Repeat className="w-3.5 h-3.5" />
              )}
              <span className="ml-1">确认切换</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              disabled={busy}
              onClick={() => setExpanded(false)}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            切换后立即用新模型评估一次；持仓 / 资金 / 策略规则不变。
          </p>
          {error && <p className="text-[11px] text-red-400">{error}</p>}
        </div>
      )}
    </div>
  )
}

/** 任务详情：分析记录 + 交易记录 + 模型接手 */
export function TaskDetailDrawer({
  open,
  task,
  decisions,
  trades,
  loading,
  onClose,
  onEdit,
  onEditRules,
  readOnly = false,
}: TaskDetailDrawerProps): React.JSX.Element {
  // decisions 按时间倒序（最新在前）；后端返回顺序不保证，这里稳妥排序
  const sortedDecisions = useMemo(() => {
    return [...decisions].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
  }, [decisions])

  const latestDecision = sortedDecisions[0]
  const modelError = isModelErrorDecision(latestDecision)
  const isAiTask = (task?.strategy_type ?? "ai") === "ai"
  const showTakeover = isAiTask && modelError

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {task && (
              <TaskIcon
                icon={task.icon}
                strategyType={task.strategy_type}
                modelId={task.model_id}
                providerName={task.provider_name}
                displayName={task.model_display_name}
                size={28}
              />
            )}
            <span className="truncate">{task?.name ?? "任务详情"}</span>
          </DialogTitle>
        </DialogHeader>
        {task && (
          <>
            <div className="text-xs text-[var(--text-muted)] flex flex-wrap gap-x-3 gap-y-1">
              <span>
                {task.symbol_name || task.symbol} · {task.timeframe}
              </span>
              <span>{task.model_display_name}</span>
              <span>状态 {STATUS_LABEL[statusKey(task)] ?? task.status}</span>
              {task.max_hold_days ? (
                <span>周期 {task.max_hold_days} 天</span>
              ) : null}
              {task.total_realized_pnl != null && task.total_realized_pnl !== 0 ? (
                <span
                  className={
                    Number(task.total_realized_pnl) >= 0 ? "text-up" : "text-down"
                  }
                >
                  累计盈亏 {Number(task.total_realized_pnl) > 0 ? "+" : ""}
                  {Number(task.total_realized_pnl).toFixed(2)} USDT
                </span>
              ) : null}
              {Number(task.trade_count ?? 0) > 0 ? (
                <span>
                  胜率 {Number(task.win_rate ?? 0).toFixed(1)}%（{task.win_count}/
                  {task.trade_count}）
                </span>
              ) : null}
              {task.last_run_at && (
                <span>上次评估 {formatDisplayTime(task.last_run_at)}</span>
              )}
            </div>
            {!readOnly && showTakeover && (
              <ModelTakeoverBanner task={task} latestReason={latestDecision?.reason ?? ""} />
            )}
            {!readOnly && isAiTask && <ModelSwitchSection task={task} />}
            {!readOnly && (
              <TaskActions task={task} onEdit={onEdit} onEditRules={onEditRules} />
            )}
            <Tabs
              defaultValue={readOnly ? "profit" : "decisions"}
              className="flex-1 min-h-0"
            >
              <TabsList>
                {readOnly && <TabsTrigger value="profit">收益</TabsTrigger>}
                <TabsTrigger value="decisions">
                  分析记录 ({decisions.length})
                </TabsTrigger>
                <TabsTrigger value="trades">
                  交易记录 ({trades.length})
                </TabsTrigger>
                <TabsTrigger value="runlogs">运行日志</TabsTrigger>
              </TabsList>
              {readOnly && (
                <TabsContent value="profit" className="mt-3">
                  {task?.id ? (
                    <TaskProfitView taskId={task.id} />
                  ) : null}
                </TabsContent>
              )}
              <TabsContent value="decisions" className="mt-3">
                <DecisionList items={decisions} loading={loading} />
              </TabsContent>
              <TabsContent value="trades" className="mt-3">
                <TradeList items={trades} loading={loading} />
              </TabsContent>
              <TabsContent value="runlogs" className="mt-3">
                {task?.id ? (
                  <RunLogList taskId={task.id} open={open} />
                ) : null}
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 模型异常警告条 + 内联切换面板 */
function ModelTakeoverBanner({
  task,
  latestReason,
}: {
  task: AITradingTask
  latestReason: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [models, setModels] = useState<AIModel[]>([])
  const [selected, setSelected] = useState(task.model_row_id ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const switchModel = useAITradingStore((s) => s.switchModel)

  useEffect(() => {
    if (!expanded) return
    if (models.length > 0) return
    void getAIModels()
      .then((list) => setModels(chatModelsOnly(list)))
      .catch(() => setModels([]))
  }, [expanded, models.length])

  async function handleTakeover(): Promise<void> {
    if (!selected) {
      setError("请选择一个模型")
      return
    }
    if (selected === task.model_row_id) {
      setError("新模型与当前模型相同")
      return
    }
    setError(null)
    setBusy(true)
    try {
      await switchModel(task.id, selected)
      setExpanded(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "接手失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-red-300 font-medium">
            当前模型异常，建议切换模型接手操盘
          </p>
          <p className="text-[11px] text-red-300/70 mt-0.5 truncate">
            {latestReason || "模型调用失败"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="border-red-500/40 text-red-300 hover:bg-red-500/20 shrink-0"
          disabled={busy}
          onClick={() => setExpanded((v) => !v)}
        >
          <Repeat className="w-3.5 h-3.5" />
          <span className="ml-1">换模型接手</span>
        </Button>
      </div>

      {expanded && (
        <div className="pt-2 border-t border-red-500/20 space-y-2">
          <div className="flex items-center gap-2">
            <select
              className="flex-1 h-8 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-xs text-[var(--text-primary)]"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={busy}
            >
              {models.length === 0 && <option value="">加载中...</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name} ({m.provider_name})
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="default"
              disabled={busy || !selected}
              onClick={() => void handleTakeover()}
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Repeat className="w-3.5 h-3.5" />
              )}
              <span className="ml-1">确认接手</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              disabled={busy}
              onClick={() => setExpanded(false)}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            接手后立即用新模型评估当前持仓，持仓/资金/策略规则不变。
          </p>
          {error && (
            <p className="text-[11px] text-red-400">{error}</p>
          )}
        </div>
      )}
    </div>
  )
}
