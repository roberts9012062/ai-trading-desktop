"use client"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import type { Hunter, Opportunity } from "@/lib/hunter/api"

export function PivotSignalDialog({ group, opportunity: o, onClose }: { group: Hunter; opportunity: Opportunity; onClose: () => void }) {
  const evidence = o.plan.entry_evidence, bars = evidence?.candles ?? [], point = evidence?.pivot
  const levels = [...bars.flatMap(b => [b.low, b.high]), o.plan.entry, ...(o.plan.stop ? [o.plan.stop] : [])]
  const low = Math.min(...levels), high = Math.max(...levels), span = Math.max(high-low, high*.001)
  const y = (value: number) => 25+(high-value)/span*195
  const x = (i: number) => 40+(i+.5)*600/Math.max(1, bars.length)
  const pivotIndex = bars.findIndex(b => Date.parse(b.time) === Date.parse(point?.time ?? ""))
  const params = o.plan.pivot_params
  const reverse = params?.reverse_entry === true
  const sourceSide = point?.side ?? o.plan.direction
  const entryLabel = reverse ? `${sourceSide === "long" ? "波谷多信号" : "波峰空信号"} → 反向${o.plan.direction === "long" ? "做多" : "做空"}` : o.plan.direction === "long" ? "波谷做多" : "波峰做空"
  return <Dialog open onOpenChange={next => { if (!next) onClose() }}>
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{group.name} · {o.symbol.toUpperCase()} 枢轴波段</DialogTitle>
        <DialogDescription>60分钟 · {entryLabel} · 保存的入场K线与枢轴信号</DialogDescription></DialogHeader>
      {bars.length > 0 && <svg viewBox="0 0 720 270" role="img" aria-label="入场枢轴K线图" className="w-full rounded border border-[var(--border)]">
        {bars.map((b, i) => { const color = b.close >= b.open ? "#ef4444" : "#22c55e"; return <g key={b.time}>
          <title>{new Date(b.time).toLocaleString("zh-CN")} · 开{b.open} 高{b.high} 低{b.low} 收{b.close}</title>
          <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} />
          <rect x={x(i)-6} y={Math.min(y(b.open), y(b.close))} width={12} height={Math.max(1, Math.abs(y(b.open)-y(b.close)))} fill={color} />
        </g> })}
        <line x1={25} x2={650} y1={y(o.plan.entry)} y2={y(o.plan.entry)} stroke="#3b82f6" strokeDasharray="4 4" />
        <text x={653} y={y(o.plan.entry)+4} fontSize={11} fill="#3b82f6">入场</text>
        {o.plan.stop && <><line x1={25} x2={650} y1={y(o.plan.stop)} y2={y(o.plan.stop)} stroke="#f59e0b" strokeDasharray="4 4" /><text x={653} y={y(o.plan.stop)+4} fontSize={11} fill="#f59e0b">止损</text></>}
        {point && pivotIndex >= 0 && <><circle cx={x(pivotIndex)} cy={y(point.price)} r={5} fill="#a78bfa" /><text x={x(pivotIndex)} y={250} textAnchor="middle" fontSize={12} fill="#a78bfa">{point.side === "long" ? "波谷多" : "波峰空"}{point.provisional ? " · 预确认" : " · 正式"}</text></>}
      </svg>}
      <div className="text-xs space-y-2">
        {point && <p>枢轴时间：{new Date(point.time).toLocaleString("zh-CN")} · 极值 {point.price.toPrecision(7)}</p>}
        {o.plan.pivot_confirmation && <p>原信号收盘反转确认：{new Date(o.plan.pivot_confirmation.time).toLocaleString("zh-CN")} · {o.plan.pivot_confirmation.direction === "long" ? "阳线转强" : "阴线转弱"} · 收盘 {o.plan.pivot_confirmation.close.toPrecision(7)}</p>}
        <p>实际入场：{(o.runtime.entry ?? o.plan.entry).toPrecision(7)} · 计划止损：{o.plan.stop?.toPrecision(7) ?? "—"} · 净盈亏：{o.net_profit.toFixed(2)} USDT</p>
        {params && <p>左侧 {params.left} / 右侧 {params.right} / 预确认 {params.min_right_live} · 幅度 {params.min_amplitude_pct}% · ATR {params.min_atr_mult}倍 / {params.atr_period}周期 · 多空交替{params.alternate ? "开启" : "关闭"} · 反向入场{reverse ? "开启" : "关闭"}</p>}
        <p>只在按P确认信号出现后的最近2根K线内入场。原多信号要求右侧收盘阳线且收盘抬高，原空信号要求收盘阴线且收盘降低；报价须维持原信号确认方向。{reverse && "下单方向与原信号相反，止损和锁利润按实际持仓方向计算。"}兜底平仓优先，锁利润自动开启；持仓止损枢轴失效或出现相反下单方向的枢轴可结束本单。</p>
        <p>{o.finished_at ? "离场原因：" : "当前状态："}{o.runtime.exit_required ?? o.runtime.reason ?? o.runtime.note ?? o.runtime.technical_exit ?? o.status}</p>
      </div>
    </DialogContent>
  </Dialog>
}
