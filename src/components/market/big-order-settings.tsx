"use client"

import { useEffect } from "react"
import { X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"
import {
  useBigOrderStore,
  type BigOrderDirection,
} from "@/stores/big-order"

/** 预设高亮色板（与图表 PRESET_COLORS 风格一致） */
const COLOR_PRESETS = [
  "#ef4444",
  "#22c55e",
  "#f5a623",
  "#00d4aa",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
  "#94a3b8",
]

/** 颜色选择器：预设色板 */
function ColorPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (c: string) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            "w-5 h-5 rounded-full border transition-transform",
            value.toLowerCase() === c.toLowerCase()
              ? "ring-2 ring-offset-2 ring-offset-[var(--bg-secondary)] ring-white scale-110"
              : "hover:scale-110",
          )}
          style={{ backgroundColor: c, borderColor: "rgba(255,255,255,0.2)" }}
          aria-label={`选择颜色 ${c}`}
        />
      ))}
    </div>
  )
}

/** 多空单方向设置行 */
function DirectionRow({
  dir,
  label,
}: {
  dir: BigOrderDirection
  label: string
}): React.JSX.Element {
  const settings = useBigOrderStore((s) => s.settings)
  const updateSettings = useBigOrderStore((s) => s.updateSettings)
  const toggleDirection = useBigOrderStore((s) => s.toggleDirection)
  const enabled = dir === "buy" ? settings.buy_enabled : settings.sell_enabled
  const threshold = dir === "buy" ? settings.buy_threshold : settings.sell_threshold
  const color = dir === "buy" ? settings.buy_color : settings.sell_color
  const thresholdKey = dir === "buy" ? "buy_threshold" : "sell_threshold"
  const colorKey = dir === "buy" ? "buy_color" : "sell_color"

  return (
    <div
      className={cn(
        "rounded-md border border-[var(--border)] p-2.5 space-y-2 transition-opacity",
        !enabled && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-sm font-medium"
          style={{ color: enabled ? color : undefined }}
        >
          {label}
        </span>
        <Toggle
          checked={enabled}
          onChange={() => toggleDirection(dir)}
          aria-label={`${label}开关`}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--text-muted)] shrink-0">
          阈值 ≥
        </span>
        <Input
          type="number"
          min={1}
          max={100000}
          value={threshold}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v >= 1) {
              updateSettings({ [thresholdKey]: Math.floor(v) })
            }
          }}
          className="h-7 w-20 text-xs"
        />
        <span className="text-xs text-[var(--text-muted)]">手</span>
      </div>
      <ColorPicker
        value={color}
        onChange={(c) => updateSettings({ [colorKey]: c })}
      />
    </div>
  )
}

/** 提醒方式行 */
function AlertRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1">
      <div>
        <p className="text-sm text-[var(--text-secondary)]">{label}</p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} aria-label={label} />
    </div>
  )
}

/** 大单预警设置弹窗 */
export function BigOrderSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}): React.JSX.Element {
  const settings = useBigOrderStore((s) => s.settings)
  const updateSettings = useBigOrderStore((s) => s.updateSettings)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,400px)] max-w-none gap-0 p-0">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <DialogTitle className="text-sm font-medium text-[var(--text-primary)]">
            大单预警设置
          </DialogTitle>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-3 space-y-3">
          <DirectionRow dir="buy" label="多单大单（主动买）" />
          <DirectionRow dir="sell" label="空单大单（主动卖）" />

          <div className="pt-1 border-t border-[var(--border)]">
            <p className="text-xs text-[var(--text-muted)] py-1.5">提醒方式</p>
            <AlertRow
              label="弹窗通知"
              description="右下角弹窗显示 10 秒"
              checked={settings.popup_enabled}
              onChange={(v) => updateSettings({ popup_enabled: v })}
            />
            <AlertRow
              label="提示音"
              description="大单出现时播放提示音"
              checked={settings.sound_enabled}
              onChange={(v) => updateSettings({ sound_enabled: v })}
            />
            <AlertRow
              label="语音播报"
              description="朗读合约/方向/手数"
              checked={settings.voice_enabled}
              onChange={(v) => updateSettings({ voice_enabled: v })}
            />
          </div>

          <p className="text-[10px] text-[var(--text-muted)] pt-1">
            设置即时保存。大单出现时，成交列表行加粗高亮；命中阈值的大单记录到下方「大单历史」，每晚 20:30 自动清空。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 便捷 hook：挂载时从后端加载设置（在行情页/交易页调用） */
export function useBigOrderSettingsBootstrap(): void {
  const loadFromServer = useBigOrderStore((s) => s.loadFromServer)
  useEffect(() => {
    void loadFromServer()
  }, [loadFromServer])
}
