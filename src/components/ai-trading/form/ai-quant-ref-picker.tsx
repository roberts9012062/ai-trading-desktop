"use client"

/**
 * AI 任务多选量化策略参考 —— 勾选后可按需调整每个策略的参数，
 * 信号注入 quant_ref_signals；不勾选：纯 AI，prompt 不含量化策略参考内容
 */

import { useState } from "react"
import { Label } from "@/components/ui/label"
import { KindParams } from "@/components/ai-trading/form/create-quant-params"
import {
  DEFAULT_QUANT_PARAMS,
  QUANT_KIND_OPTIONS,
  buildStrategyParams,
  paramsToQuantState,
  type QuantKind,
  type QuantParamsState,
} from "@/lib/quant-strategy"

/** 一条参考策略（kind + 平铺参数，后端 quant_ref 校验白名单后使用） */
export interface QuantRefStrategy {
  kind: QuantKind
  params: Record<string, unknown>
}

interface AiQuantRefPickerProps {
  value: QuantRefStrategy[]
  onChange: (list: QuantRefStrategy[]) => void
}

/** 可选参考策略：6 个规则量化策略（factor 走独立挂载入口，不在此列） */
const REF_KINDS: QuantKind[] = [
  "n_breakout",
  "ma_cross",
  "macd_cross",
  "kdj_cross",
  "band_swing",
  "swing_pivot",
]

const KIND_LABEL: Record<string, string> = Object.fromEntries(
  QUANT_KIND_OPTIONS.map((o) => [o.value, o.label]),
)

/** AI 任务量化策略参考多选（按钮组 + 展开参数面板） */
export function AiQuantRefPicker({
  value,
  onChange,
}: AiQuantRefPickerProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<QuantKind | null>(null)

  const toggle = (kind: QuantKind): void => {
    if (value.some((v) => v.kind === kind)) {
      onChange(value.filter((v) => v.kind !== kind))
      setExpanded((cur) => (cur === kind ? null : cur))
    } else {
      onChange([
        ...value,
        {
          kind,
          params: buildStrategyParams({
            ...DEFAULT_QUANT_PARAMS,
            quantKind: kind,
          }),
        },
      ])
      setExpanded(kind)
    }
  }

  const updateParams = (kind: QuantKind, state: QuantParamsState): void => {
    onChange(
      value.map((v) =>
        v.kind === kind ? { kind, params: buildStrategyParams(state) } : v,
      ),
    )
  }

  return (
    <div className="space-y-1.5 rounded-md border border-[var(--border)] p-2.5">
      <Label className="text-xs text-[var(--text-secondary)]">
        量化策略参考（可选多选）
      </Label>
      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        勾选后按所选参数计算信号注入 prompt 作为量化参考（与量化任务同口径）；点已选策略可调整参数；不勾选则纯 AI。
      </p>
      <div className="grid grid-cols-3 gap-1.5">
        {REF_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => toggle(kind)}
            className={`h-8 rounded-md border text-[11px] transition-colors ${
              value.some((v) => v.kind === kind)
                ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            }`}
          >
            {KIND_LABEL[kind]}
          </button>
        ))}
      </div>
      {value.map((item) => {
        const state = paramsToQuantState(item.kind, item.params)
        return (
          <div
            key={item.kind}
            className="rounded-md border border-[var(--border)] p-2 space-y-1"
          >
            <button
              type="button"
              className="text-[11px] font-medium text-[var(--text-secondary)] flex items-center justify-between w-full"
              onClick={() =>
                setExpanded((cur) => (cur === item.kind ? null : item.kind))
              }
            >
              <span>{KIND_LABEL[item.kind]} · 参数</span>
              <span>{expanded === item.kind ? "收起" : "调整"}</span>
            </button>
            {expanded === item.kind && (
              <KindParams
                quant={state}
                onQuant={(next) => updateParams(item.kind, next)}
                symbol=""
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
