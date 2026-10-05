import { listDayDigestMetadata, loadDayDigest } from "./backfill/pipeline"
import { closedBarsFromDigest, replayScores } from "./replay"
import { requiredWarmupBars } from "./mount"
import { TIMEFRAME_SECONDS } from "./spec"
import { digestSha256, sha256Hex } from "./digest"
import type { ShortlineBar } from "./forming-bar"
import { boundedReviewDays, type ExecutionObservation, type ReviewWorkerRequest } from "./execution-review"

self.onmessage = async ({ data }: MessageEvent<ReviewWorkerRequest>) => {
  try {
    const days = boundedReviewDays(data.days, data.cadence)
    const entries = await listDayDigestMetadata(data.symbol)
    const need = requiredWarmupBars(data.champions.map((c) => c.tokens), data.timeframe)
    const warmDays = Math.ceil(need * TIMEFRAME_SECONDS[data.timeframe] / 86400) + 1
    if (entries.length < warmDays + days) throw new Error(`历史不足：需要${warmDays}天预热＋${days}天复核，当前${entries.length}天`)
    const selected = entries.slice(-(warmDays + days))
    const firstSelected = Date.parse(`${selected[0]!.day}T00:00:00Z`)
    if (selected.some((entry, i) => Date.parse(`${entry.day}T00:00:00Z`) !== firstSelected + i * 86400000)) {
      throw new Error("预热或复核日期不连续，请补齐缺失归档")
    }
    const firstReview = Date.parse(`${selected[warmDays]!.day}T00:00:00Z`)
    const lastReview = firstReview + days * 86400000
    if (Date.parse(`${selected.at(-1)!.day}T00:00:00Z`) !== lastReview - 86400000) {
      throw new Error("复核日期不连续，请补齐缺失归档")
    }
    let history: ShortlineBar[] = []
    const observations: ExecutionObservation[] = []
    const hashes: string[] = []
    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i]!
      const buckets = await loadDayDigest(data.symbol, entry.day)
      if (!buckets?.length) throw new Error(`${entry.day}归档缺失`)
      const actualSha = digestSha256(buckets)
      if (actualSha !== entry.sha256) throw new Error(`${entry.day}归档校验失败`)
      hashes.push(`${entry.day}:${actualSha}`)
      const start = Date.parse(`${entry.day}T00:00:00Z`)
      self.postMessage({ progress: `预热/回放 ${i + 1}/${selected.length} 天 · ${entry.day}` })
      if (start >= firstReview) {
        const result = replayScores(buckets, {
          timeframe: data.timeframe, cadence: data.cadence, champions: data.champions,
          initialClosedBars: history, minWarmupBars: need,
          onProgress: (t) => self.postMessage({ progress: `回放 ${entry.day} · ${new Date(t).toISOString().slice(11, 16)}` }),
        }, actualSha)
        for (const step of result.steps) {
          if (step.t >= lastReview || step.price == null || !Number.isFinite(step.price) || step.price <= 0) continue
          const stale = step.priceTs == null || step.t - step.priceTs > data.cadence * 2000
          observations.push({ t: step.t, price: step.price, score: stale ? null : step.combo })
        }
      }
      history = [...history, ...closedBarsFromDigest(buckets, data.timeframe, start, start + 86400000)].slice(-need)
    }
    if (observations.length < 4) throw new Error("预热后无有效回放样本")
    const datasetSha = sha256Hex(new TextEncoder().encode(hashes.join("\n")))
    self.postMessage({ done: true, observations, datasetSha, from: firstReview, to: lastReview })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
