"use client"

/**
 * AI 看盘主播技术线选择器 —— 多选 + 每条可调参数
 *
 * 交互：指标按钮组选择 → 参数输入 → 添加；已选 chip 可点击回填编辑、✕ 删除；
 * 同一指标可重复添加（如 MA20 + MA60 两条均线）。
 */

import { NumericInput } from "@/components/ui/numeric-input"
import { withNumericValidation } from "@/lib/numeric-input"
import { useState } from "react"
import { X } from "lucide-react"
import type { AnchorIndicatorItem, AnchorParamSpec } from "@/lib/ai-anchor-api"

interface AnchorIndicatorPickerProps {
  value: AnchorIndicatorItem[]
  schema: Record<string, AnchorParamSpec[]>
  onChange: (items: AnchorIndicatorItem[]) => void
}

/** chip 简短标签：MA(20) / MACD(12,26,9) */
function chipLabel(item: AnchorIndicatorItem, specs: AnchorParamSpec[] | undefined): string {
  const keys = specs ? specs.map((s) => s.key) : Object.keys(item.params)
  const values = keys.map((key) => item.params[key])
  return `${item.name}(${values.join(",")})`
}

/** 编辑器初始参数：schema 默认值或已选条目参数 */
function initParams(
  name: string,
  specs: AnchorParamSpec[] | undefined,
  base: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const spec of specs ?? []) {
    out[spec.key] = base?.[spec.key] ?? spec.default
  }
  return out
}

export function AnchorIndicatorPicker({
  value,
  schema,
  onChange,
}: AnchorIndicatorPickerProps): React.JSX.Element {
  const names = Object.keys(schema)
  const [editName, setEditName] = useState<string>("")
  // 编辑中条目下标：null=新增模式，数字=修改第 index 条
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [params, setParams] = useState<Record<string, number>>({})

  const specs = editName ? schema[editName] : undefined

  function beginAdd(name: string): void {
    setEditName(name)
    setEditIndex(null)
    setParams(initParams(name, schema[name], undefined))
  }

  function beginEdit(index: number): void {
    const item = value[index]
    setEditName(item.name)
    setEditIndex(index)
    setParams(initParams(item.name, schema[item.name], item.params))
  }

  function commit(): void {
    if (!editName) return
    const item: AnchorIndicatorItem = { name: editName, params: { ...params } }
    const next = [...value]
    if (editIndex == null) {
      if (next.length >= 12) return // 后端上限 12 条
      next.push(item)
    } else {
      next[editIndex] = item
    }
    onChange(next)
    setEditName("")
    setEditIndex(null)
    setParams({})
  }

  function removeAt(index: number): void {
    onChange(value.filter((_, i) => i !== index))
    if (editIndex === index) {
      setEditName("")
      setEditIndex(null)
    }
  }

  return (
    <div className="space-y-1.5">
      {/* 指标按钮组 */}
      <div className="flex flex-wrap gap-1">
        {names.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => (editName === name ? setEditName("") : beginAdd(name))}
            className={
              "px-2 py-0.5 rounded text-[11px] border cursor-pointer transition-colors " +
              (editName === name
                ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]")
            }
          >
            {name}
          </button>
        ))}
      </div>

      {/* 参数编辑器 */}
      {editName && specs && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-tertiary)] p-2 space-y-1.5">
          {specs.map((spec) => (
            <div key={spec.key} className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--text-muted)] w-16 shrink-0">
                {spec.label}
              </span>
              <NumericInput
                type="number"
                value={params[spec.key] ?? spec.default}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v)) {
                    setParams({ ...params, [spec.key]: v })
                  }
                }}
                className="w-20 px-2 py-0.5 text-[11px] font-num rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
              />
              <span className="text-[10px] font-num text-[var(--text-muted)]">
                {spec.min}-{spec.max}
              </span>
            </div>
          ))}
          <div className="flex gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={withNumericValidation(commit)}
              className="px-2.5 py-0.5 rounded text-[11px] bg-[var(--primary)] text-white hover:opacity-90 cursor-pointer"
            >
              {editIndex == null ? "添加" : "更新"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditName("")
                setEditIndex(null)
              }}
              className="px-2.5 py-0.5 rounded text-[11px] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 已选 chips */}
      <div className="flex flex-wrap gap-1">
        {value.map((item, index) => (
          <span
            key={`${item.name}-${index}`}
            className={
              "inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-num border cursor-pointer " +
              (editIndex === index
                ? "border-[var(--primary)] text-[var(--primary)]"
                : "border-[var(--border)] text-[var(--text-primary)] bg-[var(--bg-tertiary)]")
            }
            onClick={() => beginEdit(index)}
          >
            {chipLabel(item, schema[item.name])}
            <X
              className="w-3 h-3 text-[var(--text-muted)] hover:text-red-400"
              onClick={(e) => {
                e.stopPropagation()
                removeAt(index)
              }}
            />
          </span>
        ))}
        {value.length === 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">
            至少选择一条技术线
          </span>
        )}
      </div>
    </div>
  )
}
