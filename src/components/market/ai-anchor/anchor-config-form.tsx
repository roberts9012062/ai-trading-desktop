"use client"

/**
 * AI 看盘主播配置表单 —— 模型/品种/分时段/根数/间隔/技术线 → 看盘
 */

import { withNumericValidation } from "@/lib/numeric-input"
import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { ChevronDown, Play } from "lucide-react"
import { getContractsApi, type ContractItem } from "@/lib/api"
import { SymbolCombobox } from "@/components/factor-lab/symbol-combobox"
import { AnchorIndicatorPicker } from "./anchor-indicator-picker"
import { useAiAnchorStore } from "@/stores/ai-anchor"
import { useAISettingsStore } from "@/stores/ai-settings"
import { MAX_TIMEFRAMES, type AnchorHorizon } from "@/lib/ai-anchor-api"
import type { AnchorDraft } from "@/lib/ai-anchor-persist"
import type { AIModel } from "@/types"

/** 分时K线段选项（不含 tick/日线） */
const TIMEFRAMES: Array<{ value: string; label: string }> = [
  { value: "1m", label: "1分" },
  { value: "5m", label: "5分" },
  { value: "15m", label: "15分" },
  { value: "30m", label: "30分" },
  { value: "60m", label: "60分" },
  { value: "240m", label: "4小时" },
]

/** 播放间隔选项（分钟，5-30） */
const INTERVALS = [5, 10, 15, 20, 25, 30]

/** 方向偏好选项 */
const DIRECTIONS: Array<{ value: "any" | "long" | "short"; label: string }> = [
  { value: "any", label: "不限" },
  { value: "long", label: "只做多" },
  { value: "short", label: "只做空" },
]

/** 交易风格选项（持仓周期维度，与运行视图的操盘风格正交） */
const HORIZONS: Array<{ value: AnchorHorizon; label: string }> = [
  { value: "short", label: "短线" },
  { value: "mid", label: "中线" },
  { value: "long", label: "长线" },
]

function Label({ text }: { text: string }): React.JSX.Element {
  return <div className="text-[10px] text-[var(--text-muted)]">{text}</div>
}

/** 模型下拉（自绘，样式对齐 SymbolCombobox）—— 一级渠道商分组，二级模型 */
function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: AIModel[]
  value: string
  onChange: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = models.find((m) => m.id === value)
  // 按渠道商分组（保持渠道首次出现顺序）
  const groups = useMemo(() => {
    const map = new Map<string, AIModel[]>()
    for (const m of models) {
      const key = m.provider_name?.trim() || "其它渠道"
      const list = map.get(key)
      if (list) list.push(m)
      else map.set(key, [m])
    }
    return Array.from(map.entries())
  }, [models])

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [])

  if (models.length === 0) {
    return (
      <div className="text-[11px] text-[var(--text-muted)]">
        暂无可用模型，先去{" "}
        <Link href="/ai-settings" className="text-[var(--primary)] hover:underline">
          AI 设置
        </Link>{" "}
        添加渠道与模型
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-9 px-3 text-xs rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] flex items-center justify-between gap-2 cursor-pointer hover:border-[var(--primary)]"
      >
        <span className="truncate">
          {selected ? `${selected.provider_name} · ${selected.display_name}` : "选择主播模型"}
        </span>
        <ChevronDown className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] shadow-lg">
          {groups.map(([providerName, items]) => (
            <div key={providerName}>
              <div className="px-3 py-1 text-[10px] font-medium text-[var(--text-muted)] bg-[var(--bg-tertiary)]">
                {providerName}
              </div>
              {items.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onChange(m.id)
                    setOpen(false)
                  }}
                  className={
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] flex items-center justify-between gap-2 cursor-pointer " +
                    (m.id === value ? "bg-[var(--bg-tertiary)]" : "")
                  }
                >
                  <span className="text-[var(--text-primary)] truncate">{m.display_name}</span>
                  {m.id === value && (
                    <span className="text-[var(--primary)] text-[10px] shrink-0">当前</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AnchorConfigForm({
  initialDraft,
  submitLabel,
  onDone,
}: {
  /** 编辑模式（暂停调参）：以任务当前配置初始化的本地草稿，不写 localStorage */
  initialDraft?: AnchorDraft
  /** 提交按钮文案（默认"看盘"，编辑模式传"保存并继续"） */
  submitLabel?: string
  /** 编辑模式保存成功后的回调（如关闭弹窗并刷新状态） */
  onDone?: () => void
}): React.JSX.Element {
  const storeDraft = useAiAnchorStore((s) => s.draft)
  const patchDraft = useAiAnchorStore((s) => s.patchDraft)
  const indicatorSchema = useAiAnchorStore((s) => s.indicatorSchema)
  const acting = useAiAnchorStore((s) => s.acting)
  const error = useAiAnchorStore((s) => s.error)
  const start = useAiAnchorStore((s) => s.start)
  const fetchStatus = useAiAnchorStore((s) => s.fetchStatus)
  const models = useAISettingsStore((s) => s.models)
  const fetchModels = useAISettingsStore((s) => s.fetchModels)
  const [contracts, setContracts] = useState<ContractItem[]>([])
  const [validation, setValidation] = useState<string | null>(null)
  const isEdit = initialDraft !== undefined
  const [editDraft, setEditDraft] = useState<AnchorDraft>(initialDraft ?? storeDraft)
  // 读取/写入统一入口：编辑模式走本地态，创建模式走 store 草稿
  const draft = isEdit ? editDraft : storeDraft
  const setDraft = (patch: Partial<AnchorDraft>): void => {
    if (isEdit) setEditDraft((prev) => ({ ...prev, ...patch }))
    else patchDraft(patch)
  }

  /** 多选分时段：未选则追加（上限3），已选则移除（至少保留1个） */
  function toggleTimeframe(tf: string): void {
    const selected = draft.timeframes
    if (selected.includes(tf)) {
      if (selected.length <= 1) return // 至少保留一个
      setDraft({ timeframes: selected.filter((v) => v !== tf) })
    } else if (selected.length < MAX_TIMEFRAMES) {
      setDraft({ timeframes: [...selected, tf] })
    }
  }

  useEffect(() => {
    if (models.length === 0) void fetchModels()
    let cancelled = false
    void (async () => {
      try {
        const items = await getContractsApi()
        if (!cancelled) setContracts(items)
      } catch {
        // 合约列表拉取失败：仍可手输 symbol
      }
    })()
    return () => {
      cancelled = true
    }
  }, [models.length, fetchModels])

  function handleStart(): void {
    if (!draft.modelRowId) {
      setValidation("请选择主播模型")
      return
    }
    if (!draft.symbol.trim()) {
      setValidation("请选择看盘品种")
      return
    }
    if (draft.timeframes.length === 0) {
      setValidation("请至少选择一个分时K线段")
      return
    }
    if (draft.indicators.length === 0) {
      setValidation("请至少选择一条技术线")
      return
    }
    setValidation(null)
    void (async () => {
      const ok = await start(
        isEdit
          ? {
              model_row_id: editDraft.modelRowId,
              symbol: editDraft.symbol.trim().toLowerCase(),
              timeframes: editDraft.timeframes,
              direction_mode: editDraft.directionMode,
              horizon: editDraft.horizon,
              bar_count: editDraft.barCount,
              interval_minutes: editDraft.intervalMinutes,
              indicators: editDraft.indicators,
            }
          : undefined,
      )
      if (ok) {
        if (isEdit) {
          // upsert 响应不带播报历史，补拉一次状态恢复历史列表
          await fetchStatus()
          onDone?.()
        }
      }
    })()
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      <div className="space-y-1">
        <Label text="主播模型（技术看盘专家）" />
        <ModelSelect
          models={models}
          value={draft.modelRowId}
          onChange={(id) => setDraft({ modelRowId: id })}
        />
      </div>

      <div className="space-y-1">
        <Label text="看盘品种" />
        <SymbolCombobox
          value={draft.symbol}
          onChange={(symbol) => setDraft({ symbol })}
          contracts={contracts}
        />
      </div>

      <div className="space-y-1">
        <Label text={`分时K线段（可多选，最多 ${MAX_TIMEFRAMES} 个，已选 ${draft.timeframes.length} 个）`} />
        <div className="flex gap-1">
          {TIMEFRAMES.map((tf) => {
            const order = draft.timeframes.indexOf(tf.value)
            const selected = order >= 0
            const disabled = !selected && draft.timeframes.length >= MAX_TIMEFRAMES
            return (
              <button
                key={tf.value}
                type="button"
                onClick={() => toggleTimeframe(tf.value)}
                disabled={disabled}
                title={
                  selected
                    ? order === 0
                      ? "主分析时段（点击移除）"
                      : `第 ${order + 1} 时段（点击移除）`
                    : disabled
                      ? `最多选择 ${MAX_TIMEFRAMES} 个时段`
                      : "点击添加"
                }
                className={
                  "flex-1 h-7 rounded text-[11px] border transition-colors " +
                  (selected
                    ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]") +
                  (disabled ? " opacity-40 cursor-not-allowed" : " cursor-pointer")
                }
              >
                {tf.label}
                {selected && <span className="ml-0.5 opacity-70">{order + 1}</span>}
              </button>
            )
          })}
        </div>
        <div className="text-[10px] text-[var(--text-muted)]">
          多时段综合多周期共振分析；第 1 个时段为主分析时段（用于持仓计价与播报周期）
        </div>
      </div>

      <div className="space-y-1">
        <Label text={`K线根数（每时段最新一根往历史，各 ${draft.barCount} 根）`} />
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={30}
            max={100}
            step={1}
            value={draft.barCount}
            onChange={(e) => setDraft({ barCount: Number(e.target.value) })}
            className="flex-1 accent-[var(--primary)]"
          />
          <span className="text-xs font-num text-[var(--text-primary)] w-8 text-right">
            {draft.barCount}
          </span>
        </div>
        <div className="text-[10px] text-[var(--text-muted)]">范围 30-100 根</div>
      </div>

      <div className="space-y-1">
        <Label text="交易风格（持仓周期）" />
        <div className="flex gap-1">
          {HORIZONS.map((hz) => (
            <button
              key={hz.value}
              type="button"
              onClick={() => setDraft({ horizon: hz.value })}
              className={
                "flex-1 h-7 rounded text-[11px] border cursor-pointer transition-colors " +
                (draft.horizon === hz.value
                  ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              {hz.label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-[var(--text-muted)]">
          短线=分钟级快进快出 / 中线=波段数小时到数天 / 长线=趋势数天到数周
        </div>
      </div>

      <div className="space-y-1">
        <Label text="方向偏好" />
        <div className="flex gap-1">
          {DIRECTIONS.map((dir) => (
            <button
              key={dir.value}
              type="button"
              onClick={() => setDraft({ directionMode: dir.value })}
              className={
                "flex-1 h-7 rounded text-[11px] border cursor-pointer transition-colors " +
                (draft.directionMode === dir.value
                  ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              {dir.label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-[var(--text-muted)]">
          选择只做多/只做空后,主播只在该方向寻找机会
        </div>
      </div>

      <div className="space-y-1">
        <Label text="播放间隔（分钟）" />
        <div className="flex gap-1">
          {INTERVALS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              onClick={() => setDraft({ intervalMinutes: minutes })}
              className={
                "flex-1 h-7 rounded text-[11px] font-num border cursor-pointer transition-colors " +
                (draft.intervalMinutes === minutes
                  ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
              }
            >
              {minutes}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <Label text="技术线（可多选，点击条目调参数）" />
        <AnchorIndicatorPicker
          value={draft.indicators}
          schema={indicatorSchema}
          onChange={(indicators) => setDraft({ indicators })}
        />
      </div>

      {(validation ?? error) && (
        <div className="text-[11px] text-red-400">{validation ?? error}</div>
      )}

      <button
        type="button"
        disabled={acting || models.length === 0}
        onClick={withNumericValidation(handleStart)}
        className="w-full h-9 rounded-md bg-[var(--primary)] text-white text-xs font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5 cursor-pointer"
      >
        <Play className="w-3.5 h-3.5" />
        {acting ? (isEdit ? "保存中…" : "启动中…") : (submitLabel ?? "看盘")}
      </button>
      <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        {isEdit
          ? "保存后立即恢复运行并触发新一轮播报；历史播报保留。"
          : "启动后主播按间隔自动分析播报；闭盘时间不播报，开盘自动恢复；跳转其他页面不影响播报。"}
      </div>
    </div>
  )
}
