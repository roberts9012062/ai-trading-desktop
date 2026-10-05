import { listDayDigestMetadata, loadDayDigest } from "./backfill/pipeline"
import { closedBarsFromDigest, replayScores } from "./replay"
import { requiredWarmupBars } from "./mount"
import { TIMEFRAME_SECONDS } from "./spec"
import { digestSha256, sha256Hex } from "./digest"
import type { ShortlineBar } from "./forming-bar"
import { boundedReviewDays, type ExecutionObservation, type ReviewWorkerRequest } from "./execution-review"
import { readCachedOkxFunding,okxArchiveDayStart } from "@/lib/okx-history"

self.onmessage = async ({ data }: MessageEvent<ReviewWorkerRequest>) => {
  try {
    const days = boundedReviewDays(data.days, data.cadence)
    const source = data.source ?? "binance_usdt"
    const dayStart = (day:string) => source === "okx" ? okxArchiveDayStart(day) : Date.parse(`${day}T00:00:00Z`)
    const entries = await listDayDigestMetadata(data.symbol,source)
    const need = requiredWarmupBars(data.champions.map((c) => c.tokens), data.timeframe)
    const warmDays = Math.ceil(need * TIMEFRAME_SECONDS[data.timeframe] / 86400) + 1
    if (entries.length < warmDays + days) throw new Error(`历史不足：需要${warmDays}天预热＋${days}天复核，当前${entries.length}天`)
    const selected = entries.slice(-(warmDays + days))
    const firstSelected = dayStart(selected[0]!.day)
    if (selected.some((entry, i) => dayStart(entry.day) !== firstSelected + i * 86400000)) {
      throw new Error("预热或复核日期不连续，请补齐缺失归档")
    }
    const firstReview = dayStart(selected[warmDays]!.day)
    const lastReview = firstReview + days * 86400000
    if (dayStart(selected.at(-1)!.day) !== lastReview - 86400000) {
      throw new Error("复核日期不连续，请补齐缺失归档")
    }
    let history: ShortlineBar[] = []
    const observations: ExecutionObservation[] = []
    const hashes: string[] = [source]
    const funding = source === "okx" ? await readCachedOkxFunding(data.symbol,firstReview,lastReview) : []
    hashes.push(`funding:${JSON.stringify(funding)}`)
    let fundingIndex = 0
    while (fundingIndex < funding.length && funding[fundingIndex]!.t < firstReview) fundingIndex++
    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i]!
      const buckets = await loadDayDigest(data.symbol, entry.day,source)
      if (!buckets?.length) throw new Error(`${entry.day}归档缺失`)
      const actualSha = digestSha256(buckets)
      if (actualSha !== entry.sha256) throw new Error(`${entry.day}归档校验失败`)
      hashes.push(`${entry.day}:${actualSha}`)
      const start = dayStart(entry.day)
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
          let fundingRate = 0
          while (fundingIndex < funding.length && funding[fundingIndex]!.t <= step.t) fundingRate += funding[fundingIndex++]!.r
          observations.push({ t: step.t, price: step.price, score: stale ? null : step.combo,
            ...(fundingRate ? {funding_rate:fundingRate} : {}) })
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
