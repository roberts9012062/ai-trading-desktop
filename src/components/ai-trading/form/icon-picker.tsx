"use client"

/**
 * 任务图标选择器 —— 九宫格弹窗，分组浏览中美/量化因子图标
 */

import { useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  AI_ICONS,
  iconSrc,
  type IconEntry,
  type IconGroup,
} from "@/lib/ai-icons-manifest"
import { cn } from "@/lib/utils"

interface IconPickerProps {
  value: string | null | undefined
  onChange: (slug: string | null) => void
  children: React.ReactNode
}

const GROUPS: Array<{ key: IconGroup; label: string }> = [
  { key: "common", label: "常用" },
  { key: "us", label: "美国" },
  { key: "cn", label: "中国" },
  { key: "quant", label: "量化·因子" },
]

const NAME_OF: Record<string, string> = Object.fromEntries(
  AI_ICONS.map((e) => [e.slug, e.name]),
)

/** 图标选择弹窗 */
export function IconPicker({
  value,
  onChange,
  children,
}: IconPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<IconGroup>("common")

  const list = useMemo(
    () => AI_ICONS.filter((e) => e.group === group),
    [group],
  )

  function pick(slug: string | null): void {
    onChange(slug)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>选择任务图标</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-[var(--text-muted)]">
          用于收益对比图等位置的头像。选「自动」则按模型/策略匹配。
        </p>

        <div className="flex flex-wrap gap-1 mb-2">
          {GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setGroup(g.key)}
              className={cn(
                "px-2.5 py-1 rounded text-[11px] border transition-colors",
                group === g.key
                  ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-4 gap-2">
          <IconCell
            active={value === null || value === undefined}
            onClick={() => pick(null)}
            name="自动"
            subtitle="按模型匹配"
            render={<AutoCell />}
          />
          {list.map((e) => (
            <IconCell
              key={e.slug}
              active={value === e.slug}
              onClick={() => pick(e.slug)}
              name={shortName(e)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={iconSrc(e.slug)}
                alt={e.name}
                width={36}
                height={36}
                className="w-9 h-9 object-cover rounded-full"
              />
            </IconCell>
          ))}
        </div>

        {value && NAME_OF[value] && (
          <p className="text-[11px] text-[var(--text-secondary)] mt-2">
            当前：{NAME_OF[value]}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function shortName(e: IconEntry): string {
  return e.name.length > 8 ? e.name.slice(0, 7) + "…" : e.name
}

interface IconCellProps {
  active: boolean
  onClick: () => void
  name: string
  subtitle?: string
  children?: React.ReactNode
  render?: React.ReactNode
}

function IconCell(props: IconCellProps): React.JSX.Element {
  const { active, onClick, name, subtitle, children, render } = props
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 p-1.5 rounded-md border text-[10px] transition-colors",
        active
          ? "border-[var(--primary)] bg-[var(--primary)]/10"
          : "border-transparent hover:bg-[var(--bg-tertiary)]",
      )}
    >
      <span className="w-9 h-9 flex items-center justify-center">
        {children ?? render}
      </span>
      <span className="text-[var(--text-secondary)] leading-tight text-center break-all">
        {name}
        {subtitle && (
          <span className="block text-[9px] text-[var(--text-muted)]">
            {subtitle}
          </span>
        )}
      </span>
    </button>
  )
}

function AutoCell(): React.JSX.Element {
  return (
    <span className="w-9 h-9 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border)] inline-flex items-center justify-center text-[11px] font-semibold text-[var(--text-secondary)]">
      AI
    </span>
  )
}
