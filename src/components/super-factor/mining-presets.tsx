"use client"

/**
 * 挖掘力度预设 —— 一键填入搜索参数组合(深挖强化 M2)
 *
 * 三档:标准(与旧默认一致)/深度/极限。大种群+岛模型是本地 GPU 粗排
 * 的甜点区(WGSL 吞吐 ~512 候选/批);CPU/服务端路径也能跑但耗时按
 * 试验数线性增长,预设文案明示「建议本地 GPU」。
 */

import { cn } from "@/lib/utils"

export interface MiningPreset {
  id: string
  label: string
  /** 一句话说明(按钮 title + 自定义态提示) */
  desc: string
  population: number
  generations: number
  islands: number
  maxDepth: number
}

export const MINING_PRESETS: readonly MiningPreset[] = [
  {
    id: "standard",
    label: "标准",
    desc: "种群40×30代·单岛·深4 —— 与旧默认一致,分钟级完成",
    population: 40,
    generations: 30,
    islands: 1,
    maxDepth: 4,
  },
  {
    id: "deep",
    label: "深度",
    desc: "种群600×80代·4岛·深5 —— 约4.8万次试验,建议本地GPU,十分钟级",
    population: 600,
    generations: 80,
    islands: 4,
    maxDepth: 5,
  },
  {
    id: "ultra",
    label: "极限",
    desc: "种群10000×80代·8岛·深6 —— 80万次试验;RTX 5060 Ti实测约2分钟(粗排390万评估/秒,瓶颈在内核精算),显存~1.3GB",
    population: 10000,
    generations: 80,
    islands: 8,
    maxDepth: 6,
  },
]

interface PresetPickerProps {
  /** 当前命中的预设 id;参数被手动改动后为 null(自定义) */
  value: string | null
  onPick: (p: MiningPreset) => void
}

export function PresetPicker(props: PresetPickerProps): React.JSX.Element {
  const { value, onPick } = props
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-[var(--text-secondary)]">
        搜索力度
      </label>
      <div className="flex flex-wrap gap-1">
        {MINING_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.desc}
            onClick={() => onPick(p)}
            className={cn(
              "px-2 py-1 rounded text-[11px] border transition-colors",
              value === p.id
                ? "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
            )}
          >
            {p.label}
          </button>
        ))}
        {value == null && (
          <span className="px-2 py-1 rounded text-[11px] border border-dashed border-[var(--border)] text-[var(--text-muted)]">
            自定义
          </span>
        )}
      </div>
      <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
        {value != null
          ? MINING_PRESETS.find((p) => p.id === value)?.desc
          : "已手动修改参数(自定义);大种群建议本地 GPU 挖掘。"}
      </p>
    </div>
  )
}
