import type { WaveSample } from "./equity-wave-data"
export interface WaveDay { from: number; to: number }
const DAY = 86400000, OFFSET = 28800000
export function waveDayRange(now: number): WaveDay {
  const from = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET
  return { from, to: from + DAY }
}
export function dayWaveSamples(samples: WaveSample[], day: WaveDay | null): WaveSample[] {
  return day ? samples.filter(p => p.time >= day.from && p.time < day.to) : []
}
/** Pick real min/max points per two horizontal pixels; never smooth away a data outage. */
export function displayWaveSamples(samples: WaveSample[], width: number, day: WaveDay): WaveSample[] {
  if (samples.length < 3) return samples
  const buckets = new Map<number, { min: number; max: number }>()
  const keep = new Set([0, samples.length - 1])
  samples.forEach((point, i) => {
    const bucket = Math.floor((point.time - day.from) / (day.to - day.from) * Math.max(1, width) / 2)
    const old = buckets.get(bucket)
    if (!old) buckets.set(bucket, { min: i, max: i })
    else {
      if (point.value < samples[old.min].value) old.min = i
      if (point.value > samples[old.max].value) old.max = i
    }
    if (point.breakBefore) { keep.add(i); if (i > 0) keep.add(i - 1) }
  })
  for (const bucket of buckets.values()) { keep.add(bucket.min); keep.add(bucket.max) }
  return [...keep].sort((a, b) => a - b).map(i => samples[i])
}
