"use client"

/**
 * 管理后台 · VIP 商城管理
 * - 礼包 CRUD：时长/价格/权益组合随意搭配（月卡/季卡/年卡等）
 * - 每日免费次数：普通用户回测/因子实验室/超级因子/任务数（0=不限）
 * - 会员直开/撤销（按用户名）
 * - 订单流水
 */

import { NumericInput } from "@/components/ui/numeric-input"
import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Loader2, Plus, Trash2 } from "lucide-react"
import {
  adminDeletePlanApi,
  adminGetDailyLimitsApi,
  adminGrantApi,
  adminListOrdersApi,
  adminListPlansApi,
  adminRevokeApi,
  adminSetDailyLimitsApi,
  adminUpsertPlanApi,
  type AdminDailyLimits,
  type VipOrderItem,
  type VipPlan,
} from "@/lib/mall-api"

const ALL_FEATURES: { key: string; label: string }[] = [
  { key: "ai_trading", label: "AI 交易（额外任务槽）" },
  { key: "trading", label: "交易（VIP 专属）" },
  { key: "backtest", label: "历史回测（VIP 不限次）" },
  { key: "factor_lab", label: "因子实验室（VIP 不限次）" },
  { key: "factor_mining", label: "超级因子挖掘（VIP 不限次）" },
]

interface PlanDraft {
  id: string | null
  name: string
  task_slots: string
  duration_days: string
  price: string
  features: string[]
  description: string
  is_active: boolean
  sort: string
}

const EMPTY_DRAFT: PlanDraft = {
  id: null,
  name: "",
  duration_days: "30",
  task_slots: "2",
  price: "99",
  features: ["ai_trading", "trading", "backtest", "factor_lab", "factor_mining"],
  description: "",
  is_active: true,
  sort: "0",
}

export default function AdminVipPage(): React.JSX.Element {
  const [plans, setPlans] = useState<VipPlan[]>([])
  const [limits, setLimits] = useState<AdminDailyLimits | null>(null)
  const [orders, setOrders] = useState<VipOrderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_DRAFT)
  const [showForm, setShowForm] = useState(false)
  const [grantUser, setGrantUser] = useState("")
  const [grantPlanId, setGrantPlanId] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh(): Promise<void> {
    try {
      const [p, l, o] = await Promise.all([
        adminListPlansApi(),
        adminGetDailyLimitsApi(),
        adminListOrdersApi(),
      ])
      setPlans(p)
      setLimits(l)
      setOrders(o)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  function editPlan(p: VipPlan): void {
    setDraft({
      id: p.id,
      name: p.name,
      duration_days: String(p.duration_days),
      task_slots: String(p.task_slots ?? 2),
      price: String(p.price),
      features: [...p.features],
      description: p.description,
      is_active: p.is_active,
      sort: String(p.sort),
    })
    setShowForm(true)
    setMsg(null)
    setErr(null)
  }

  async function saveDraft(): Promise<void> {
    const days = Number(draft.duration_days)
    const price = Number(draft.price)
    if (!draft.name.trim() || !Number.isFinite(days) || days < 1 || !Number.isFinite(price) || price < 0) {
      setErr("请填写有效名称/时长/价格")
      return
    }
    if (draft.task_slots === "" || !Number.isInteger(Number(draft.task_slots)) || Number(draft.task_slots) < 0 || Number(draft.task_slots) > 10000) {
      setErr("VIP 任务槽须为 0~10000 的整数")
      return
    }
    if (draft.features.length === 0) {
      setErr("至少勾选一项权益")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await adminUpsertPlanApi({
        id: draft.id,
        name: draft.name.trim(),
        duration_days: days,
        task_slots: Number(draft.task_slots),
        price,
        features: draft.features,
        description: draft.description,
        is_active: draft.is_active,
        sort: Number(draft.sort) || 0,
      })
      setMsg(draft.id ? "礼包已更新" : "礼包已创建")
      setDraft(EMPTY_DRAFT)
      setShowForm(false)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  async function saveLimits(): Promise<void> {
    if (!limits) return
    setBusy(true)
    setErr(null)
    try {
      await adminSetDailyLimitsApi(limits)
      setMsg("每日免费次数已保存（VIP 会员不受限制）")
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  async function grant(): Promise<void> {
    if (!grantUser.trim()) {
      setErr("请输入用户名")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const m = await adminGrantApi(
        grantPlanId ? { username: grantUser.trim(), plan_id: grantPlanId } : { username: grantUser.trim() }
      )
      setMsg(
        grantPlanId
          ? `已为 ${grantUser} 开通所选礼包（至 ${m.expires_at?.slice(0, 10) ?? ""}）`
          : "请选择要开通的礼包"
      )
      if (grantPlanId) setGrantUser("")
    } catch (e) {
      setErr(e instanceof Error ? e.message : "开通失败")
    } finally {
      setBusy(false)
    }
  }

  async function revoke(): Promise<void> {
    if (!grantUser.trim()) {
      setErr("请输入要撤销的用户名")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      await adminRevokeApi(grantUser.trim())
      setMsg(`已撤销 ${grantUser} 的会员`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "撤销失败")
    } finally {
      setBusy(false)
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

  return (
    <div className="p-4 space-y-4 max-w-5xl mx-auto">
      <h1 className="text-lg font-semibold">VIP 商城管理</h1>
      {err && (
        <div className="px-3 py-2 rounded-md bg-[var(--accent-danger)]/10 text-[var(--accent-danger)] text-xs">
          {err}
        </div>
      )}
      {msg && (
        <div className="px-3 py-2 rounded-md bg-[var(--accent-up)]/10 text-up text-xs">
          {msg}
        </div>
      )}

      {/* 每日免费次数 */}
      {limits && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <p className="text-xs font-medium">普通用户每日免费次数（VIP 不限）</p>
            <p className="text-xs text-[var(--text-muted)]">基础免费任务槽固定 1 个；永久赠送槽在用户管理中设置，VIP 额外槽在礼包中设置。</p>
            <div className="flex flex-wrap gap-3 text-xs">
              {(
                [
                  ["backtest_daily", "历史回测"],
                  ["factor_lab_daily", "因子实验室"],
                  ["factor_mining_daily", "超级因子"],

                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-1.5">
                  <span className="text-[var(--text-secondary)]">{label}</span>
                  <NumericInput
                    type="number"
                    min="0"
                    value={limits[key]}
                    onChange={(e) =>
                      setLimits({ ...limits, [key]: Number(e.target.value) || 0 })
                    }
                    className="w-20 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 font-num"
                  />
                  <span className="text-[10px] text-[var(--text-muted)]">次/天</span>
                </label>
              ))}
              <Button validateNumbers size="sm" disabled={busy} onClick={() => void saveLimits()}>
                保存
              </Button>
              <span className="text-[10px] text-[var(--text-muted)] self-center">0 = 不限</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 礼包管理 */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">VIP 礼包（{plans.length}）</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(EMPTY_DRAFT)
                setShowForm((v) => !v)
              }}
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              新建礼包
            </Button>
          </div>

          {showForm && (
            <div className="rounded-lg border border-[var(--border)] p-3 space-y-2 bg-[var(--bg-secondary)]">
              <div className="flex flex-wrap gap-2 text-xs items-center">
                <span className="text-[var(--text-secondary)]">{draft.id ? "编辑" : "新建"}礼包</span>
                <input
                  placeholder="名称（如：年卡全家桶）"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="flex-1 min-w-40 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2"
                />
                <NumericInput required
                  type="number"
                  placeholder="天数"
                  value={draft.duration_days}
                  onChange={(e) => setDraft({ ...draft, duration_days: e.target.value })}
                  className="w-20 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 font-num"
                />
                <NumericInput required
                  type="number"
                  placeholder="价格"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                  className="w-20 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 font-num"
                />
                <label className="flex items-center gap-1">VIP 额外任务槽
                  <NumericInput type="number" min="0" max="10000" step="1" aria-label="VIP 额外任务槽" value={draft.task_slots} onChange={e => setDraft({ ...draft, task_slots: e.target.value })} className="w-20 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2" />
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.is_active}
                    onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
                    className="accent-[var(--primary)]"
                  />
                  上架
                </label>
                <Button validateNumbers size="sm" disabled={busy} onClick={() => void saveDraft()}>
                  {busy ? "保存中…" : "保存礼包"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                  收起
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                {ALL_FEATURES.map((f) => (
                  <label
                    key={f.key}
                    className="flex items-center gap-1 cursor-pointer px-2 py-1 rounded-md border border-[var(--border)]"
                  >
                    <input
                      type="checkbox"
                      checked={draft.features.includes(f.key)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          features: e.target.checked
                            ? [...draft.features, f.key]
                            : draft.features.filter((x) => x !== f.key),
                        })
                      }
                      className="accent-[var(--primary)]"
                    />
                    {f.label}
                  </label>
                ))}
              </div>
              <input
                placeholder="介绍文案（可选）"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                className="w-full h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs"
              />
            </div>
          )}

          <div className="divide-y divide-[var(--border)]/60">
            {plans.length === 0 && (
              <p className="text-xs text-[var(--text-muted)] py-4 text-center">
                暂无礼包，点击右上角新建
              </p>
            )}
            {plans.map((p) => (
              <div key={p.id} className="py-2 flex items-center gap-3 text-xs flex-wrap">
                <span className="font-medium">{p.name}</span>
                <Badge variant="outline" className="text-[10px]">
                  {p.duration_days} 天
                </Badge>
                <span className="font-num text-amber-500">¥{p.price}</span>
                <span>额外任务槽 {p.features.includes("ai_trading") ? (p.task_slots ?? 2) : 0} 个</span>
                <span className="text-[var(--text-muted)] truncate max-w-64">
                  {p.feature_labels.join(" / ")}
                </span>
                {!p.is_active && (
                  <Badge variant="destructive" className="text-[10px]">
                    已下架
                  </Badge>
                )}
                <span className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => editPlan(p)}>
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px] text-[var(--accent-danger)]"
                    onClick={() => {
                      void (async () => {
                        try {
                          await adminDeletePlanApi(p.id)
                          await refresh()
                        } catch (e) {
                          setErr(e instanceof Error ? e.message : "删除失败")
                        }
                      })()
                    }}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 会员直开/撤销 */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <p className="text-xs font-medium">会员管理（直开 / 撤销）</p>
          <p className="text-xs text-[var(--text-muted)]">续费延长有效期，保留有效期内较高的套餐任务额度，不重复累加。撤销会员不影响永久赠送槽。</p>
          <div className="flex flex-wrap gap-2 text-xs items-center">
            <input
              placeholder="用户名"
              value={grantUser}
              onChange={(e) => setGrantUser(e.target.value)}
              className="w-36 h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2"
            />
            <select
              value={grantPlanId}
              onChange={(e) => setGrantPlanId(e.target.value)}
              className="h-7 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2 text-xs"
            >
              <option value="">选择礼包…</option>
              {plans
                .filter((p) => p.is_active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}（{p.duration_days}天）
                  </option>
                ))}
            </select>
            <Button size="sm" disabled={busy} onClick={() => void grant()}>
              直接开通
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void revoke()}>
              撤销会员
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 订单流水 */}
      <Card>
        <CardContent className="p-0">
          <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium">
            订单流水（{orders.length}）
          </div>
          <div className="divide-y divide-[var(--border)]/60 max-h-72 overflow-auto">
            {orders.length === 0 && (
              <p className="text-xs text-[var(--text-muted)] py-4 text-center">暂无订单</p>
            )}
            {orders.map((o) => (
              <div key={o.id} className="px-3 py-2 flex items-center gap-3 text-xs flex-wrap">
                <span className="font-medium">{o.plan_name}</span>
                <span className="font-num">¥{o.price}</span>
                <span className="text-[var(--text-muted)]">{o.created_at.slice(0, 16).replace("T", " ")}</span>
                <Badge variant={o.status === "paid" ? "up" : "outline"} className="text-[10px]">
                  {o.status === "paid" ? "已支付" : o.status === "pending" ? "待支付" : "已取消"}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
