/**
 * 50 步分数环形缓冲（契约：历史只暴露最近 50 步；陈旧分数带过期标记）。
 * 重放证据导出与流式预览共用。
 */

import { SCORE_RING_STEPS } from "./spec"

export interface ScoreSample {
  /** 采样时刻（毫秒） */
  t: number
  scores: Array<number | null>
  combo: number | null
  /** 接收/生成该步的本地时刻（仅 UI 陈旧判定用；不进确定性指纹） */
  localMs: number
  stale: boolean
}

export class ScoreRingBuffer {
  private items: ScoreSample[] = []

  push(sample: ScoreSample): void {
    this.items.push(sample)
    if (this.items.length > SCORE_RING_STEPS) {
      this.items.splice(0, this.items.length - SCORE_RING_STEPS)
    }
  }

  /** 最近 N 步（默认全部留存 ≤50） */
  list(): readonly ScoreSample[] {
    return this.items
  }

  get length(): number {
    return this.items.length
  }

  /** 按陈旧规则标记（age > staleMultiplier × cadence → stale） */
  markStale(nowMs: number, cadenceSeconds: number, staleMultiplier = 2.0): void {
    const limit = staleMultiplier * cadenceSeconds * 1000
    for (const item of this.items) {
      if (nowMs - item.localMs > limit) item.stale = true
    }
  }
}
