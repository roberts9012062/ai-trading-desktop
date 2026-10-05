/**
 * 黄金夹具导出（服务器 S1 门依赖）。
 *
 * 夹具 = {tick 流样本(digest/1 字节), forming bar 规格, cadence, 公式集,
 * 期望分数序列(f64 位模式十六进制)} + manifest SHA。服务器 FormulaEvaluator
 * 对全部夹具逐位一致才可上线。
 *
 * 分数以 f64 位模式序列化（规避 JSON 浮点解析差异）；libm 敏感算子
 * （exp/log/tanh/log1p）在 manifest 中声明——服务器需按位复现桌面(V8)行为。
 */

import { decodeDigest, digestSha256, encodeDigest, sha256Hex, type TickBucket } from "./digest"
import { replayBits, replayScores, f64Bits } from "./replay"
import { FORMING_BAR_SPEC, SHORTLINE_EVAL_VERSION, type CadenceSeconds, type ShortlineTimeframe } from "./spec"

export interface GoldenCase {
  name: string
  symbol: string
  timeframe: ShortlineTimeframe
  cadence_seconds: CadenceSeconds
  digest_sha256: string
  tick_stream: {
    format: "digest/1"
    bytes_base64: string
    count: number
    first_ts_sec: number
    last_ts_sec: number
  }
  formulas: number[][]
  expected: {
    /** 每 cadence 步：t(毫秒)、各冠军分数与组合分的 f64 位模式 */
    steps: Array<{ t: number, scores: string[], combo: string }>
  }
}

export interface GoldenFixture {
  format: "shortline-golden-fixture/1"
  eval_version: string
  forming_bar_spec: string
  score_mapping: "tanh(causal_v2_z)"
  f64_serialization: "little-endian-bit-pattern-hex"
  libm_sensitive_ops: string[]
  cases: GoldenCase[]
}

export interface FixtureManifest {
  format: "shortline-fixture-manifest/1"
  files: Array<{ name: string, sha256: string }>
  manifest_sha256: string
}

export interface FixtureBundle {
  fixture: GoldenFixture
  manifest: FixtureManifest
}

/** 单个案例生成（digest 尾部切片作为 tick 流样本） */
export function buildGoldenCase(args: {
  name: string
  symbol: string
  timeframe: ShortlineTimeframe
  cadence: CadenceSeconds
  buckets: readonly TickBucket[]
  formulas: ReadonlyArray<readonly number[]>
  /** digest 尾部取样桶数（默认 3600 = 1 小时秒桶上限） */
  sampleTail?: number
}): GoldenCase {
  const tail = args.sampleTail ?? 3600
  const buckets = args.buckets.slice(Math.max(0, args.buckets.length - tail))
  const sha = digestSha256(buckets)
  const bytes = encodeDigest(buckets)
  const replay = replayScores(buckets, {
    timeframe: args.timeframe,
    cadence: args.cadence,
    champions: args.formulas.map((tokens) => ({ tokens })),
  }, sha)
  // 自校验：解码 roundtrip 后重放仍逐位一致（冻结数据集协议）
  const restored = decodeDigest(bytes)
  const replay2 = replayScores(restored, {
    timeframe: args.timeframe,
    cadence: args.cadence,
    champions: args.formulas.map((tokens) => ({ tokens })),
  }, sha)
  if (replayBits(replay) !== replayBits(replay2)) {
    throw new Error("夹具自校验失败：digest roundtrip 后重放不一致")
  }
  return {
    name: args.name,
    symbol: args.symbol,
    timeframe: args.timeframe,
    cadence_seconds: args.cadence,
    digest_sha256: sha,
    tick_stream: {
      format: "digest/1",
      bytes_base64: toBase64(bytes),
      count: buckets.length,
      first_ts_sec: buckets[0]?.ts ?? 0,
      last_ts_sec: buckets[buckets.length - 1]?.ts ?? 0,
    },
    formulas: args.formulas.map((t) => [...t]),
    expected: {
      steps: replay.steps.map((s) => ({
        t: s.t,
        scores: s.scores.map((v) => f64Bits(v)),
        combo: f64Bits(s.combo),
      })),
    },
  }
}

/** 涉及超越函数的算子名（manifest 声明，服务器 S1 需按位复现） */
export const LIBM_SENSITIVE_OPS = new Set(["TANH", "SIGMOID", "SIGNED_LOG"])

function libmOpsUsed(formulas: ReadonlyArray<readonly number[]>): string[] {
  const names = new Set<string>()
  const nameOf = (opId: number) =>
    ["ADD","SUB","MUL","DIV","MIN","MAX","ABS","NEG","SIGN","SQRT","SIGNED_LOG","SIGMOID","TANH",
     "TS_MA_5","TS_MA_10","TS_MA_20","TS_STD_10","TS_STD_20","TS_MAX_10","TS_MAX_20","TS_MIN_10",
     "TS_RANK_10","TS_RANK_20","TS_ZSCORE_20","DELTA_1","DELTA_5","TS_ATR_NORM","LAG_1","LAG_5",
     "CORR_20","TS_MA_60","TS_STD_60","TS_ZSCORE_60","TS_RANK_60","TS_DEMEAN_20","BETA_20","RESID_20",
     "STEP","EMA_5","EMA_20","TS_CRANK_20","TS_CRANK_60","DECAY_LINEAR_10","DECAY_LINEAR_20",
     "ROBUST_ZSCORE_20","WINSOR_20","VOL_SCALE_20","SNR_20","SNR_60","TS_ZSCORE_120","DELTA_24"][opId]
  for (const tokens of formulas) {
    for (const t of tokens) {
      if (t >= 64 && t < 115) {
        const name = nameOf(t - 64)
        if (name && LIBM_SENSITIVE_OPS.has(name)) names.add(name)
      }
    }
  }
  return [...names].sort()
}

export function buildFixtureBundle(
  symbol: string,
  cases: GoldenCase[],
  formulas: ReadonlyArray<readonly number[]>,
  evalVersion: string = SHORTLINE_EVAL_VERSION,
): FixtureBundle {
  const fixture: GoldenFixture = {
    format: "shortline-golden-fixture/1",
    eval_version: evalVersion,
    forming_bar_spec: FORMING_BAR_SPEC,
    score_mapping: "tanh(causal_v2_z)",
    f64_serialization: "little-endian-bit-pattern-hex",
    libm_sensitive_ops: libmOpsUsed(formulas),
    cases,
  }
  const fixtureJson = JSON.stringify(fixture)
  const files = [{ name: "shortline-golden-fixture.json", sha256: sha256Hex(new TextEncoder().encode(fixtureJson)) }]
  const manifestBody = JSON.stringify({ format: "shortline-fixture-manifest/1", files })
  const manifest: FixtureManifest = {
    format: "shortline-fixture-manifest/1",
    files,
    manifest_sha256: sha256Hex(new TextEncoder().encode(manifestBody)),
  }
  return { fixture, manifest }
}

function toBase64(bytes: Uint8Array): string {
  let bin = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64")
}
