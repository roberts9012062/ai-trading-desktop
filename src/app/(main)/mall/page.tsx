"use client"

/**
 * 商城 —— VIP 会员礼包购买
 * - 礼包由管理员后台自由组合（时长 + 价格 + 功能权益）
 * - AI 交易 / 交易为 VIP 专属；回测/因子实验室/超级因子 VIP 不限次数
 * - 普通用户每日免费次数在「我的权益」展示（管理员可调）
 */

import { useEffect, useState } from "react"
import { TaskSlotSummary } from "@/components/ai-trading/task-slot-summary"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, Crown, Check } from "lucide-react"
import {
  cancelOrderApi,
  createOrderApi,
  getMembershipApi,
  getMallStatusApi,
  getMyOrdersApi,
  getPlansApi,
  payOrderApi,
  VIP_FEATURE_LABELS,
  type VipMembershipState,
  type VipOrderItem,
  type VipPlan,
} from "@/lib/mall-api"

const STATUS_LABEL: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  cancelled: "已取消",
}

function durationLabel(days: number): string {
  if (days >= 360) return "年卡"
  if (days >= 88) return "季卡"
  if (days >= 28) return "月卡"
  return `${days} 天`
}

/** VIP 权益说明（普通用户的免费额度动态展示） */
function LimitsNote({ state }: { state: VipMembershipState }): React.JSX.Element {
  const f = (v: number | null): string => (v == null ? "不限" : `${v} 次/天`)
  if (state.is_vip) {
    return (
      <p className="text-xs text-[var(--text-muted)] mt-1">
        会员有效期内：历史回测、因子实验室、超级因子挖掘不限次数使用
      </p>
    )
  }
  return (
    <p className="text-xs text-[var(--text-muted)] mt-1">
      普通用户每日免费额度：历史回测 {f(state.daily_limits.backtest)} · 因子实验室{" "}
      {f(state.daily_limits.factor_lab)} · 超级因子 {f(state.daily_limits.factor_mining)}
      ；AI 交易有基础免费 1 槽，永久赠送槽与 VIP 槽额外叠加
    </p>
  )
}

export default function MallPage(): React.JSX.Element {
  const [plans, setPlans] = useState<VipPlan[]>([])
  const [state, setState] = useState<VipMembershipState | null>(null)
  const [orders, setOrders] = useState<VipOrderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [closed, setClosed] = useState(false)
  const [busyPlan, setBusyPlan] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      const [p, m, o, s] = await Promise.all([
        getPlansApi(),
        getMembershipApi(),
        getMyOrdersApi(),
        getMallStatusApi(),
      ])
      setPlans(p)
      setState(m)
      setOrders(o)
      setClosed(Boolean(s.closed))
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function buy(plan: VipPlan): Promise<void> {
    setBusyPlan(plan.id)
    setError(null)
    setMessage(null)
    try {
      const order = await createOrderApi(plan.id)
      await payOrderApi(order.id)
      setMessage(`已开通「${plan.name}」：${durationLabel(plan.duration_days)}权益立即生效`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "购买失败")
    } finally {
      setBusyPlan(null)
    }
  }

  async function cancelOrder(id: string): Promise<void> {
    try {
      await cancelOrderApi(id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : "取消失败")
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-[var(--text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        加载中…
      </div>
    )
  }

  // 商城已关闭（后台开关）：VIP 功能全站免费开放，仅保留会员状态展示
  if (closed) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center space-y-3">
        <Crown className="w-10 h-10 text-[var(--text-muted)] mx-auto" />
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">
          商城已关闭
        </h1>
        <p className="text-sm text-[var(--text-muted)]">
          会员功能已向所有用户免费开放，无需购买。
          {state?.is_vip && !state?.is_admin
            ? " 您的 VIP 额外任务槽在到期前继续生效。"
            : ""}
        </p>
        {state && (
          <TaskSlotSummary slots={state.task_slots} />
        )}
      </div>
    )
  }

  return (
    <div className="p-4 space-y-5 max-w-5xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Crown className="w-5 h-5 text-amber-400" />
            商城 · VIP 会员
          </h1>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            开通会员增加任务槽，解锁交易与不限次回测/因子研究
          </p>
        </div>
        {state && (
          <Card className="w-72">
            <CardContent className="p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">我的权益</span>
                {state.is_admin ? (
                  <Badge variant="up" className="text-[10px]">
                    管理员 · 不受限制
                  </Badge>
                ) : state.is_vip ? (
                  <Badge variant="up" className="text-[10px]">
                    VIP · 剩 {state.days_left} 天
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">
                    普通用户
                  </Badge>
                )}
              </div>
              {state.is_vip && state.expires_at && (
                <p className="text-[11px] text-[var(--text-muted)] mt-1">
                  到期 {state.expires_at.slice(0, 10)} ·{" "}
                  {state.feature_labels.join(" / ")}
                </p>
              )}
              <TaskSlotSummary slots={state.task_slots} />
              <LimitsNote state={state} />
            </CardContent>
          </Card>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-[var(--accent-danger)]/10 text-[var(--accent-danger)] text-xs">
          {error}
        </div>
      )}
      {message && (
        <div className="px-3 py-2 rounded-md bg-[var(--accent-up)]/10 text-up text-xs">
          {message}
        </div>
      )}

      {plans.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">
          暂无可购买的礼包，请联系管理员在后台配置
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.map((plan) => (
            <Card
              key={plan.id}
              className="border-[var(--border)] hover:border-amber-400/50 transition-colors"
            >
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm">{plan.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {durationLabel(plan.duration_days)}
                  </Badge>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold font-num text-amber-500">
                    ¥{plan.price}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    / {plan.duration_days} 天
                  </span>
                </div>
                <p className="text-xs">额外任务槽 +{plan.features.includes("ai_trading") ? (plan.task_slots ?? 2) : 0} 个，与基础免费和永久赠送槽叠加。</p>
                <p className="text-[11px] text-[var(--text-muted)]">到期后有持仓的 VIP 任务仅允许减仓和平仓，确认空仓后回收；永久赠送槽不受影响。续费延长有效期，不重复增加槽位。</p>
                <ul className="space-y-1">
                  {plan.feature_labels.map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-xs">
                      <Check className="w-3 h-3 text-up shrink-0" />
                      <span>
                        {f}
                        {["历史回测", "因子实验室", "超级因子挖掘"].includes(f)
                          ? "（不限次数）"
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                {plan.description && (
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                    {plan.description}
                  </p>
                )}
                <Button
                  className="w-full"
                  disabled={busyPlan === plan.id}
                  onClick={() => void buy(plan)}
                >
                  {busyPlan === plan.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                  ) : null}
                  立即开通
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {orders.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium">
              我的订单
            </div>
            <div className="divide-y divide-[var(--border)]/60">
              {orders.slice(0, 8).map((o) => (
                <div key={o.id} className="px-3 py-2 flex items-center gap-3 text-xs">
                  <span className="font-medium">{o.plan_name}</span>
                  <span className="font-num text-[var(--text-secondary)]">
                    ¥{o.price} · {o.duration_days} 天
                  </span>
                  <span className="text-[var(--text-muted)]">
                    {o.created_at.slice(0, 10)}
                  </span>
                  <span className="ml-auto">
                    <Badge
                      variant={o.status === "paid" ? "up" : "outline"}
                      className="text-[10px]"
                    >
                      {STATUS_LABEL[o.status] ?? o.status}
                    </Badge>
                  </span>
                  {o.status === "pending" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[11px]"
                      onClick={() => void cancelOrder(o.id)}
                    >
                      取消
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-[10px] text-[var(--text-muted)] text-center">
        权益由 {Object.values(VIP_FEATURE_LABELS).join(" / ")} 组合构成，礼包内容以管理员配置为准
      </p>
    </div>
  )
}
