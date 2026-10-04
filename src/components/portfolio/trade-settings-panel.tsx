"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Loader2, Save, RotateCcw } from "lucide-react"
import {
  getPaperSettings,
  getProductSpecs,
  updatePaperSettings,
  type PaperTradeSettings,
  type ProductSpecItem,
} from "@/lib/paper-api"

/** 交易设置：保证金/手续费倍率 + 可选全局覆盖 + 品种默认表 */
export function TradeSettingsPanel(): React.JSX.Element {
  const [settings, setSettings] = useState<PaperTradeSettings | null>(null)
  const [specs, setSpecs] = useState<ProductSpecItem[]>([])
  const [marginScale, setMarginScale] = useState("1")
  const [feeScale, setFeeScale] = useState("1")
  const [useOverride, setUseOverride] = useState(false)
  const [marginOverride, setMarginOverride] = useState("0.12")
  const [feeMode, setFeeMode] = useState<"rate" | "fixed">("rate")
  const [openFee, setOpenFee] = useState("0.0001")
  const [closeFee, setCloseFee] = useState("0.0001")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const applySettings = useCallback((s: PaperTradeSettings) => {
    setSettings(s)
    setMarginScale(String(s.margin_scale))
    setFeeScale(String(s.fee_scale))
    const hasOverride =
      s.margin_rate_override != null ||
      s.fee_mode_override != null ||
      s.open_fee_override != null
    setUseOverride(hasOverride)
    if (s.margin_rate_override != null) {
      setMarginOverride(String(s.margin_rate_override))
    }
    if (s.fee_mode_override === "fixed" || s.fee_mode_override === "rate") {
      setFeeMode(s.fee_mode_override)
    }
    if (s.open_fee_override != null) {
      setOpenFee(String(s.open_fee_override))
    }
    if (s.close_fee_override != null) {
      setCloseFee(String(s.close_fee_override))
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, p] = await Promise.all([getPaperSettings(), getProductSpecs()])
      applySettings(s)
      setSpecs(p.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [applySettings])

  useEffect(() => {
    void load()
  }, [load])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const ms = Number(marginScale)
      const fs = Number(feeScale)
      if (Number.isNaN(ms) || ms < 0.1 || ms > 5) {
        throw new Error("保证金倍率须在 0.1~5")
      }
      if (Number.isNaN(fs) || fs < 0 || fs > 10) {
        throw new Error("手续费倍率须在 0~10")
      }
      const body: Parameters<typeof updatePaperSettings>[0] = {
        margin_scale: ms,
        fee_scale: fs,
        clear_overrides: !useOverride,
      }
      if (useOverride) {
        const mr = Number(marginOverride)
        const of = Number(openFee)
        const cf = Number(closeFee)
        if (Number.isNaN(mr) || mr <= 0 || mr > 1) {
          throw new Error("全局保证金率须在 (0,1]")
        }
        body.margin_rate_override = mr
        body.fee_mode_override = feeMode
        body.open_fee_override = of
        body.close_fee_override = cf
      }
      const next = await updatePaperSettings(body)
      applySettings(next)
      setMessage("交易参数已保存，下单将按新规则计保证金/手续费")
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setSaving(true)
    setError(null)
    setMessage(null)
    try {
      const next = await updatePaperSettings({
        margin_scale: 1,
        fee_scale: 1,
        clear_overrides: true,
      })
      applySettings(next)
      setUseOverride(false)
      setMessage("已恢复为品种默认规则（倍率 1.0）")
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败")
    } finally {
      setSaving(false)
    }
  }

  if (loading && !settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] py-12">
        <Loader2 className="w-4 h-4 animate-spin" />
        加载交易参数…
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">交易设置</h2>
      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        模拟交易按期货规则计算：保证金 = 价格×手数×合约乘数×保证金率；
        手续费支持「按成交金额比例」或「元/手定额」。下方为行业常见默认值，可调倍率或全局覆盖。
      </p>

      {error && (
        <div className="text-sm text-[var(--accent-danger)] bg-[var(--accent-danger)]/10 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      {message && (
        <div className="text-sm text-[var(--accent-up)] bg-[var(--accent-up)]/10 rounded-md px-3 py-2">
          {message}
        </div>
      )}

      <Card>
        <CardContent className="p-4 space-y-4">
          <p className="text-sm font-medium text-[var(--text-primary)]">参数调节</p>
          <Separator />
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-[var(--text-secondary)]">
                保证金率倍率（1.0 = 品种默认）
              </Label>
              <Input
                value={marginScale}
                onChange={(e) => setMarginScale(e.target.value)}
                className="h-8 mt-1 text-sm font-num"
                type="number"
                step="0.1"
                min="0.1"
                max="5"
              />
              <p className="text-[10px] text-[var(--text-muted)] mt-1">
                例：1.2 表示各品种保证金率 ×1.2
              </p>
            </div>
            <div>
              <Label className="text-xs text-[var(--text-secondary)]">
                手续费倍率（1.0 = 品种默认）
              </Label>
              <Input
                value={feeScale}
                onChange={(e) => setFeeScale(e.target.value)}
                className="h-8 mt-1 text-sm font-num"
                type="number"
                step="0.1"
                min="0"
                max="10"
              />
              <p className="text-[10px] text-[var(--text-muted)] mt-1">
                0 表示免手续费（仅练习）
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-[var(--text-secondary)]">启用全局覆盖</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                开启后所有品种使用同一保证金率/手续费（忽略倍率）
              </p>
            </div>
            <button
              type="button"
              onClick={() => setUseOverride(!useOverride)}
              className={
                useOverride
                  ? "w-8 h-4 rounded-full bg-[var(--primary)] relative cursor-pointer"
                  : "w-8 h-4 rounded-full bg-[var(--bg-tertiary)] relative cursor-pointer"
              }
            >
              <span
                className={
                  useOverride
                    ? "absolute top-0.5 left-[18px] w-3 h-3 rounded-full bg-white"
                    : "absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white"
                }
              />
            </button>
          </div>

          {useOverride && (
            <div className="space-y-3 rounded-md bg-[var(--bg-tertiary)]/40 p-3">
              <div>
                <Label className="text-xs">全局保证金率（0~1）</Label>
                <Input
                  value={marginOverride}
                  onChange={(e) => setMarginOverride(e.target.value)}
                  className="h-8 mt-1 text-sm font-num w-40"
                  type="number"
                  step="0.01"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={feeMode === "rate" ? "default" : "outline"}
                  onClick={() => setFeeMode("rate")}
                >
                  按金额比例
                </Button>
                <Button
                  size="sm"
                  variant={feeMode === "fixed" ? "default" : "outline"}
                  onClick={() => setFeeMode("fixed")}
                >
                  元/手定额
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">
                    开仓费（{feeMode === "rate" ? "比例" : "元/手"}）
                  </Label>
                  <Input
                    value={openFee}
                    onChange={(e) => setOpenFee(e.target.value)}
                    className="h-8 mt-1 text-sm font-num"
                  />
                </div>
                <div>
                  <Label className="text-xs">
                    平仓费（{feeMode === "rate" ? "比例" : "元/手"}）
                  </Label>
                  <Input
                    value={closeFee}
                    onChange={(e) => setCloseFee(e.target.value)}
                    className="h-8 mt-1 text-sm font-num"
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button resetNumbers
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={saving}
              onClick={() => void handleReset()}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              恢复默认
            </Button>
            <Button validateNumbers
              size="sm"
              className="gap-1"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            品种默认规格（参考）
          </p>
          <p className="text-[10px] text-[var(--text-muted)]">
            保证金 = 价格×手数×乘数×保证金率；手续费见「说明」列
          </p>
          <Separator />
          <div className="max-h-[320px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-[var(--text-muted)] sticky top-0 bg-[var(--bg-secondary)]">
                <tr className="text-left">
                  <th className="py-1.5 pr-2">代码</th>
                  <th className="py-1.5 pr-2">名称</th>
                  <th className="py-1.5 pr-2">乘数</th>
                  <th className="py-1.5 pr-2">保证金率</th>
                  <th className="py-1.5">手续费</th>
                </tr>
              </thead>
              <tbody>
                {specs.map((row) => (
                  <tr
                    key={row.code}
                    className="border-t border-[var(--border)]/40 text-[var(--text-secondary)]"
                  >
                    <td className="py-1.5 pr-2 font-num">{row.code}</td>
                    <td className="py-1.5 pr-2">{row.name}</td>
                    <td className="py-1.5 pr-2 font-num">{row.multiplier}</td>
                    <td className="py-1.5 pr-2 font-num">
                      {(row.margin_rate * 100).toFixed(1)}%
                    </td>
                    <td className="py-1.5 text-[var(--text-muted)]">
                      {row.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
