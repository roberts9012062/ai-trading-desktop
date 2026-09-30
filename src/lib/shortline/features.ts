/**
 * live 特征镜像 —— 与 public/pykernel/factor_lab/features.py 的 live 可计算
 * 子集逐条对齐（id 表见 spec.ts LIVE_BASE_FEATURES + v4）。
 *
 * 输入为求值窗口内的 bar 序列（closed…+forming），输出 featureId → 序列。
 * 语义：v2 口径（zscore_window = 头部 bar 间距推导；52+/v4 族 masked zscore
 * 固定窗口）。重放/流式共用（同一实现，禁止第二套）。
 */

import type { ShortlineBar } from "./forming-bar"
import { binaryMap, delta, Series, tsCorr, tsMax, tsMean, tsMin, tsStd, unaryMap } from "./ops"
import { SHORTLINE_ZSCORE_WINDOW } from "./spec"

/** 与 research_context.norm_window_for_bars 同构（头部 ≤5 个间距取中位数） */
export function normWindowForBars(bars: readonly { timeMs: number }[]): number {
  if (bars.length < 3) return 200
  const gaps: number[] = []
  for (let i = 1; i < Math.min(6, bars.length); i++) {
    const sec = (bars[i]!.timeMs - bars[i - 1]!.timeMs) / 1000
    if (sec > 0) gaps.push(sec)
  }
  if (!gaps.length) return 200
  const gap = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!
  const perDay = 86400 / gap
  return Math.max(200, Math.ceil(perDay - 1e-9))
}

function col(bars: readonly ShortlineBar[], pick: (b: ShortlineBar) => number): Series {
  const out = new Float64Array(bars.length)
  for (let i = 0; i < bars.length; i++) out[i] = pick(bars[i]!)
  return out
}

function ret(close: Series, n: number): Series {
  const out = new Float64Array(close.length)
  for (let i = n; i < close.length; i++) {
    out[i] = (close[i]! - close[i - n]!) / Math.max(Math.abs(close[i - n]!), 1e-9)
  }
  return out
}

/** 因果 zscore clip ±5（_zscore_causal） */
function zscoreCausal(x: Series, w: number): Series {
  const m = tsMean(x, w)
  const s = tsStd(x, w)
  const out = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    out[i] = Math.min(Math.max((x[i]! - m[i]!) / Math.max(s[i]!, 1e-8), -5), 5)
  }
  return out
}

/** v2 掩码因果 zscore：窗内任一缺失 → NaN；全缺失 → 全 NaN（_masked_zscore_causal） */
function maskedZscoreCausal(x: Series, w: number): Series {
  const n = x.length
  const out = new Float64Array(n).fill(NaN)
  let anyGood = false
  for (let i = 0; i < n; i++) if (Number.isFinite(x[i]!)) { anyGood = true; break }
  if (!anyGood) return out
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w + 1)
    const len = i - lo + 1
    let full = true
    let s = 0, s2 = 0
    for (let j = lo; j <= i; j++) {
      const v = x[j]!
      if (!Number.isFinite(v)) { full = false; break }
      s += v; s2 += v * v
    }
    if (!full) continue
    const mean = s / len
    const variance = Math.max(s2 / len - mean * mean, 0)
    const std = Math.sqrt(variance)
    out[i] = Math.min(Math.max((x[i]! - mean) / Math.max(std, 1e-8), -5), 5)
  }
  return out
}

/** 掩码因果均值：窗内缺失 → NaN（_masked_mean） */
function maskedMean(x: Series, w: number): Series {
  const n = x.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w + 1)
    const len = i - lo + 1
    let s = 0, ok = true
    for (let j = lo; j <= i; j++) {
      if (!Number.isFinite(x[j]!)) { ok = false; break }
      s += x[j]!
    }
    out[i] = ok ? s / len : NaN
  }
  return out
}

function isoWeekday(d: Date): number {
  return (d.getUTCDay() + 6) % 7
}

/** np.round(v, 7)（.5 边界与 JS 舍入偶有差异，在交叉对拍容差内） */
function round7(v: number): number {
  return Math.round(v * 1e7) / 1e7
}

/**
 * 计算 live 特征序列（featureId → Series）。只算请求的 id 集合以省算力。
 * v4（token 115-122）由 bars[i].sl 原始值经 masked zscore 300 产出。
 */
export function computeLiveFeatures(bars: readonly ShortlineBar[], wanted: Iterable<number>): Map<number, Series> {
  const n = bars.length
  const W = normWindowForBars(bars)
  const close = col(bars, (b) => b.close)
  const high = col(bars, (b) => b.high)
  const low = col(bars, (b) => b.low)
  const open = col(bars, (b) => b.open)
  const volume = col(bars, (b) => b.volume)
  const out = new Map<number, Series>()

  const r1 = ret(close, 1)
  const ma20 = tsMean(close, 20)
  const std20 = tsStd(close, 20)
  const ma60 = tsMean(close, 60)
  const std60 = tsStd(close, 60)
  const volMa20 = tsMean(volume, 20)
  const volStd20 = tsStd(volume, 20)

  const need = new Set<number>(wanted)
  const has = (id: number) => need.has(id)
  const put = (id: number, s: Series) => out.set(id, s)
  const putZ = (id: number, s: Series) => put(id, zscoreCausal(s, W))

  if (has(0)) putZ(0, r1)
  if (has(1)) putZ(1, ret(close, 5))
  if (has(2)) putZ(2, ret(close, 20))
  if (has(3)) putZ(3, binaryMap(close, ma20, (c, m) => (c - m) / Math.max(Math.abs(m), 1e-9)))
  if (has(4)) putZ(4, binaryMap(delta(ma20, 5), ma20, (v, m) => v / Math.max(Math.abs(m), 1e-9)))
  if (has(5)) {
    const tr = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const pc = i === 0 ? close[0]! : close[i - 1]!
      tr[i] = Math.max(high[i]! - low[i]!, Math.max(Math.abs(high[i]! - pc), Math.abs(low[i]! - pc)))
    }
    putZ(5, binaryMap(tsMean(tr, 14), close, (a, c) => a / Math.max(c, 1e-9)))
  }
  if (has(6)) putZ(6, binaryMap(volStd20, volMa20, (s, m) => s / Math.max(m, 1e-9)))
  if (has(7)) putZ(7, binaryMap(binaryMap(high, low, (h, l) => h - l), close, (v, c) => v / Math.max(c, 1e-9)))
  if (has(8)) {
    const dev = new Float64Array(n)
    for (let i = 0; i < n; i++) dev[i] = (close[i]! - ma20[i]!) / Math.max(std20[i]!, 1e-8)
    putZ(8, dev)
  }
  if (has(9)) {
    const up = new Float64Array(n), dn = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const prev = i === 0 ? close[0]! : close[i - 1]!
      const d = close[i]! - prev
      up[i] = d > 0 ? d : 0
      dn[i] = d < 0 ? -d : 0
    }
    putZ(9, binaryMap(tsMean(up, 14), tsMean(dn, 14), (u, d) => {
      const rs = u / Math.max(d, 1e-9)
      return (100 - 100 / (1 + rs) - 50) / 50
    }))
  }
  if (has(10)) {
    const ac = new Float64Array(n)
    for (let i = 1; i < n; i++) {
      const lo = Math.max(0, i - 20)
      const len = i - lo + 1
      if (len < 2) continue
      let ma = 0, mb = 0
      for (let j = lo; j < i; j++) ma += r1[j]!
      for (let j = lo + 1; j <= i; j++) mb += r1[j]!
      ma /= len - 1; mb /= len - 1
      let saa = 0, sbb = 0, cab = 0
      for (let j = lo; j < i; j++) {
        const a = r1[j]! - ma
        saa += a * a
      }
      for (let j = lo + 1; j <= i; j++) {
        const b = r1[j]! - mb
        sbb += b * b
      }
      for (let j = lo; j < i; j++) cab += (r1[j]! - ma) * (r1[j + 1]! - mb)
      const sa = Math.sqrt(saa / (len - 1)), sb = Math.sqrt(sbb / (len - 1))
      if (sa < 1e-9 || sb < 1e-9) continue
      ac[i] = cab / (len - 1) / (sa * sb)
    }
    putZ(10, ac)
  }
  if (has(11)) putZ(11, binaryMap(volume, volMa20, (v, m) => v / Math.max(m, 1e-9)))
  if (has(12)) {
    const vz = new Float64Array(n)
    for (let i = 0; i < n; i++) vz[i] = (volume[i]! - volMa20[i]!) / Math.max(volStd20[i]!, 1e-8)
    putZ(12, vz)
  }
  if (has(13)) putZ(13, tsCorr(r1, volume, 20))

  if (has(17) || has(18)) {
    const tod = new Float64Array(n), night = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const d = new Date(bars[i]!.timeMs)
      const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
      const elapsed = ((minutes - 21 * 60) % 1440 + 1440) % 1440
      tod[i] = Math.min(elapsed / (18 * 60), 1) * 2 - 1
      night[i] = minutes >= 21 * 60 || minutes < 3 * 60 ? 1 : 0
    }
    if (has(17)) put(17, tod)
    if (has(18)) put(18, night)
  }
  if (has(19)) {
    const gap = new Float64Array(n)
    for (let i = 1; i < n; i++) gap[i] = (open[i]! - close[i - 1]!) / Math.max(Math.abs(close[i - 1]!), 1e-9)
    putZ(19, gap)
  }
  if (has(20)) {
    const cp = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      cp[i] = (close[i]! - low[i]!) / Math.max(high[i]! - low[i]!, 1e-9)
    }
    putZ(20, cp)
  }
  if (has(21) || has(22)) {
    const upper = new Float64Array(n), lower = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      upper[i] = (high[i]! - Math.max(open[i]!, close[i]!)) / Math.max(close[i]!, 1e-9)
      lower[i] = (Math.min(open[i]!, close[i]!) - low[i]!) / Math.max(close[i]!, 1e-9)
    }
    if (has(21)) putZ(21, upper)
    if (has(22)) putZ(22, lower)
  }
  if (has(23)) putZ(23, binaryMap(close, open, (c, o) => (c - o) / Math.max(c, 1e-9)))
  if (has(24)) putZ(24, ret(close, 60))
  if (has(25)) putZ(25, binaryMap(close, ma60, (c, m) => (c - m) / Math.max(Math.abs(m), 1e-9)))
  if (has(26)) putZ(26, binaryMap(std20, std60, (a, b) => a / Math.max(b, 1e-9)))

  if (has(31) || has(32)) {
    const skew = new Float64Array(n), kurt = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - 19)
      const len = i - lo + 1
      let m = 0
      for (let j = lo; j <= i; j++) m += r1[j]!
      m /= len
      let s = 0
      for (let j = lo; j <= i; j++) {
        const d = r1[j]! - m
        s += d * d
      }
      s = Math.sqrt(s / len)
      if (s < 1e-12) continue
      let m3 = 0, m4 = 0
      for (let j = lo; j <= i; j++) {
        const d = r1[j]! - m
        const d2 = d * d
        m3 += d2 * d; m4 += d2 * d2
      }
      m3 /= len; m4 /= len
      skew[i] = m3 / (s * s * s)
      kurt[i] = m4 / (s * s * s * s)
    }
    if (has(31)) putZ(31, skew)
    if (has(32)) putZ(32, kurt)
  }
  if (has(33) || has(34)) {
    const dow = new Float64Array(n), dom = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const d = new Date(bars[i]!.timeMs)
      dow[i] = (isoWeekday(d) - 2) / 2
      dom[i] = (d.getUTCDate() - 15.5) / 15.5
    }
    if (has(33)) put(33, dow)
    if (has(34)) put(34, dom)
  }

  if (has(36)) {
    const s = new Float64Array(n)
    let runSign = 0, runLen = 0
    for (let i = 1; i < n; i++) {
      const sg = close[i]! > close[i - 1]! ? 1 : close[i]! < close[i - 1]! ? -1 : 0
      if (sg === 0) runLen = 0
      else if (sg === runSign) runLen++
      else { runSign = sg; runLen = 1 }
      s[i] = runSign * Math.min(runLen, 12)
    }
    putZ(36, unaryMap(s, (v) => v / 12))
  }
  if (has(37)) {
    const tpv = new Float64Array(n)
    for (let i = 0; i < n; i++) tpv[i] = ((high[i]! + low[i]! + close[i]!) / 3) * volume[i]!
    const vwap = binaryMap(tsMean(tpv, 20), volMa20, (a, b) => a / Math.max(b, 1e-9))
    putZ(37, binaryMap(close, vwap, (c, v) => (c - v) / Math.max(Math.abs(v), 1e-9)))
  }
  if (has(38)) {
    const up2 = new Float64Array(n), dn2 = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      up2[i] = r1[i]! > 0 ? r1[i]! * r1[i]! : 0
      dn2[i] = r1[i]! < 0 ? r1[i]! * r1[i]! : 0
    }
    putZ(38, binaryMap(tsMean(up2, 20), tsMean(dn2, 20), (a, b) => (a - b) / Math.max(a + b, 1e-12)))
  }
  if (has(39) || has(51)) {
    const hh = tsMax(high, 20), ll = tsMin(low, 20)
    const cp = new Float64Array(n)
    for (let i = 0; i < n; i++) cp[i] = ((close[i]! - ll[i]!) / Math.max(hh[i]! - ll[i]!, 1e-9)) * 2 - 1
    if (has(39)) putZ(39, cp)
    if (has(51)) put(51, zscoreCausal(cp, 200))
  }

  if ([40, 41, 42, 43, 44].some(has)) {
    const hs = new Float64Array(n), hc = new Float64Array(n), ws = new Float64Array(n), wc = new Float64Array(n), we = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const d = new Date(bars[i]!.timeMs)
      const phaseH = (2 * Math.PI * (d.getUTCHours() * 60 + d.getUTCMinutes())) / 1440
      const wd = isoWeekday(d)
      const phaseW = (2 * Math.PI * wd) / 7
      hs[i] = round7(Math.sin(phaseH)); hc[i] = round7(Math.cos(phaseH))
      ws[i] = round7(Math.sin(phaseW)); wc[i] = round7(Math.cos(phaseW))
      we[i] = wd >= 5 ? 1 : 0
    }
    if (has(40)) put(40, hs)
    if (has(41)) put(41, hc)
    if (has(42)) put(42, ws)
    if (has(43)) put(43, wc)
    if (has(44)) put(44, we)
  }

  if ([45, 46, 47, 48, 49, 50].some(has)) {
    const vol20 = tsStd(r1, 20)
    if (has(45)) {
      out.set(45, zscoreCausal(binaryMap(ret(close, 6), vol20, (v, s) => v / Math.max(s * Math.sqrt(6), 1e-8)), 200))
    }
    if (has(46)) {
      out.set(46, zscoreCausal(binaryMap(ret(close, 24), vol20, (v, s) => v / Math.max(s * Math.sqrt(24), 1e-8)), 200))
    }
    if (has(47)) out.set(47, zscoreCausal(vol20, 200))
    if (has(48)) {
      const ratio = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        ratio[i] = Math.abs(r1[i]!) / Math.max(close[i]! * volume[i]!, 1e-9)
      }
      out.set(48, zscoreCausal(unaryMap(tsMean(ratio, 20), (v) => Math.log(Math.max(v, 1e-30))), 200))
    }
    if (has(49)) {
      const sv = new Float64Array(n)
      for (let i = 0; i < n; i++) sv[i] = Math.sign(r1[i]!) * volume[i]!
      out.set(49, zscoreCausal(binaryMap(tsMean(sv, 20), volMa20, (a, b) => a / Math.max(b, 1e-9)), 200))
    }
    if (has(50)) {
      const mn = new Float64Array(n), sq = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        mn[i] = r1[i]! < 0 ? r1[i]! * r1[i]! : 0
        sq[i] = r1[i]! * r1[i]!
      }
      out.set(50, zscoreCausal(binaryMap(tsMean(mn, 20), tsMean(sq, 20), (a, b) => a / Math.max(b, 1e-12)), 200))
    }
  }

  // 直连 live 族（54/55/58/61；masked zscore 200）
  const flow = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    const v = bars[i]!.volume, buy = bars[i]!.takerBuyVolume
    if (v >= 0 && buy >= 0 && buy <= v) flow[i] = v > 0 ? (2 * buy) / v - 1 : 0
  }
  if (has(54)) out.set(54, maskedZscoreCausal(flow, 200))
  if (has(55)) {
    const quote = col(bars, (b) => b.quoteVolume)
    const illiqArr = new Float64Array(n)
    const valid = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const q = quote[i]!
      const ok = Number.isFinite(q) && q >= 0
      valid[i] = ok ? 1 : 0
      illiqArr[i] = Math.abs(r1[i]!) / Math.max(ok ? q : 0, 1e-9)
    }
    const illiq = tsMean(illiqArr, 20)
    const validMean = tsMean(valid, 20)
    const lnIlliq = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      lnIlliq[i] = validMean[i]! < 1 ? NaN : Math.log(Math.max(illiq[i]!, 1e-30))
    }
    out.set(55, maskedZscoreCausal(lnIlliq, 200))
  }
  if (has(58)) {
    const quote = col(bars, (b) => b.quoteVolume)
    const count = col(bars, (b) => b.tradeCount)
    const avg = new Float64Array(n).fill(NaN)
    for (let i = 0; i < n; i++) {
      if (count[i]! > 0) avg[i] = quote[i]! / count[i]!
      else if (count[i]! === 0 && quote[i]! === 0) avg[i] = 0
    }
    out.set(58, maskedZscoreCausal(avg, 200))
  }
  if (has(61)) out.set(61, maskedZscoreCausal(maskedMean(flow, 24), 200))

  // v4（token 115-122）：原始值 masked zscore 300
  for (let k = 0; k < 8; k++) {
    if (need.has(115 + k)) {
      const raw = new Float64Array(n)
      for (let i = 0; i < n; i++) raw[i] = bars[i]!.sl[k]!
      out.set(115 + k, maskedZscoreCausal(raw, SHORTLINE_ZSCORE_WINDOW))
    }
  }

  return out
}
