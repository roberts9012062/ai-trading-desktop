"use client"

/**
 * 任务预警设置弹窗（AI 看盘行情）
 *
 * 镜像大单预警设置弹窗结构：无阈值概念，仅开仓/平仓两类事件开关 +
 * 提醒方式（弹窗/提示音/语音）。设置即时保存（localStorage + 防抖同步后端）。
 */

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"
import { useTaskAlertStore } from "@/stores/task-alert"

/** 开仓/平仓事件设置行 */
function EventRow({
  label,
  description,
  color,
  field,
}: {
  label: string
  description: string
  color: string
  field: "open_enabled" | "close_enabled"
}): React.JSX.Element {
  const settings = useTaskAlertStore((s) => s.settings)
  const updateSettings = useTaskAlertStore((s) => s.updateSettings)
  const enabled = settings[field]

  return (
    <div
      className={cn(
        "rounded-md border border-[var(--border)] p-2.5 space-y-1 transition-opacity",
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
          onChange={() => updateSettings({ [field]: !enabled })}
          aria-label={`${label}开关`}
        />
      </div>
      <p className="text-xs text-[var(--text-muted)]">{description}</p>
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

/** 任务预警设置弹窗 */
export function TaskAlertSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}): React.JSX.Element {
  const settings = useTaskAlertStore((s) => s.settings)
  const updateSettings = useTaskAlertStore((s) => s.updateSettings)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[min(94vw,400px)] max-w-none gap-0 p-0"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <DialogTitle className="text-sm font-medium text-[var(--text-primary)]">
            任务预警设置
          </DialogTitle>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-3 space-y-3">
          <EventRow
            label="开仓预警（任务下单）"
            description="AI/量化任务开多（红）/开空（绿）成交时提醒"
            color="#ef4444"
            field="open_enabled"
          />
          <EventRow
            label="平仓预警"
            description="任务平仓成交时提醒（橙色）"
            color="#f59e0b"
            field="close_enabled"
          />

          <div className="pt-1 border-t border-[var(--border)]">
            <p className="text-xs text-[var(--text-muted)] py-1.5">提醒方式</p>
            <AlertRow
              label="弹窗通知"
              description="右下角弹窗显示 10 秒（全站生效）"
              checked={settings.popup_enabled}
              onChange={(v) => updateSettings({ popup_enabled: v })}
            />
            <AlertRow
              label="提示音"
              description="任务成交时播放提示音"
              checked={settings.sound_enabled}
              onChange={(v) => updateSettings({ sound_enabled: v })}
            />
            <AlertRow
              label="语音播报"
              description="朗读动作/合约/手数"
              checked={settings.voice_enabled}
              onChange={(v) => updateSettings({ voice_enabled: v })}
            />
          </div>

          <p className="text-[10px] text-[var(--text-muted)] pt-1">
            设置即时保存。任务下单与平仓成交时会像大单预警一样弹窗提醒，同时在 K 线上留下对应标记。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
