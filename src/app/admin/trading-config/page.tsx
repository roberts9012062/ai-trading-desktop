"use client"

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

/** 配置项组件 */
function ConfigItem({
  label,
  value,
  unit,
  description,
}: {
  label: string
  value: string
  unit: string
  description: string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[180px_1fr_60px] items-center gap-4">
      <div>
        <p className="text-sm text-[var(--text-primary)]">{label}</p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">{description}</p>
      </div>
      <Input defaultValue={value} className="max-w-[200px]" />
      <span className="text-xs text-[var(--text-muted)]">{unit}</span>
    </div>
  )
}

/** 梯度行组件 */
function GradientRow({
  level,
  range,
  margin,
}: {
  level: string
  range: string
  margin: string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-4 p-3 rounded-md bg-[var(--bg-tertiary)]">
      <span className="text-sm text-[var(--text-secondary)]">{level}</span>
      <span className="text-sm font-num text-[var(--text-secondary)]">{range}</span>
      <span className="text-sm font-num text-[var(--text-primary)]">{margin}</span>
    </div>
  )
}

/** 交易参数配置页面 */
export default function AdminTradingConfigPage(): React.JSX.Element {
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">交易参数配置</h1>

      {/* 单笔最大下单量 */}
      <Card>
        <CardHeader>
          <CardTitle>下单限制</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigItem
            label="单笔最大下单量"
            value="500"
            unit="手"
            description="单笔委托的最大手数限制"
          />
          <ConfigItem
            label="单日最大下单量"
            value="5000"
            unit="手"
            description="单个用户每日累计最大委托手数"
          />
          <ConfigItem
            label="单用户最大持仓"
            value="2000"
            unit="手"
            description="单个用户单合约最大持仓手数"
          />
        </CardContent>
      </Card>

      {/* 保证金梯度 */}
      <Card>
        <CardHeader>
          <CardTitle>保证金梯度</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-3 gap-4 text-xs font-medium text-[var(--text-muted)] px-3">
            <span>梯度等级</span>
            <span>持仓范围（手）</span>
            <span>保证金率</span>
          </div>
          <GradientRow level="第一档" range="0 - 500" margin="10%" />
          <GradientRow level="第二档" range="501 - 1000" margin="12%" />
          <GradientRow level="第三档" range="1001 - 2000" margin="15%" />
          <GradientRow level="第四档" range="> 2000" margin="20%" />
        </CardContent>
      </Card>

      {/* 手续费配置 */}
      <Card>
        <CardHeader>
          <CardTitle>手续费配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigItem
            label="开仓手续费率"
            value="0.01"
            unit="%"
            description="按成交金额比例收取"
          />
          <ConfigItem
            label="平仓手续费率"
            value="0.01"
            unit="%"
            description="平仓时按比例收取"
          />
          <ConfigItem
            label="平今仓手续费率"
            value="0.02"
            unit="%"
            description="当日开仓当日平仓的手续费率"
          />
          <ConfigItem
            label="最低手续费"
            value="1.0"
            unit="元/手"
            description="每手最低收取金额"
          />
        </CardContent>
      </Card>

      {/* 风控参数 */}
      <Card>
        <CardHeader>
          <CardTitle>风控参数</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ConfigItem
            label="预警风险率"
            value="80"
            unit="%"
            description="超过此值发送预警通知"
          />
          <ConfigItem
            label="强平风险率"
            value="100"
            unit="%"
            description="达到此值触发强制平仓"
          />
          <ConfigItem
            label="最大撤单次数"
            value="50"
            unit="次/日"
            description="每日允许的最大撤单次数"
          />
          <ConfigItem
            label="行情波动熔断阈值"
            value="5"
            unit="%"
            description="涨跌幅达到此值触发熔断"
          />
        </CardContent>
      </Card>

      <Separator />

      {/* 保存按钮 */}
      <div className="flex justify-end">
        <Button>保存配置</Button>
      </div>
    </div>
  )
}
