/**
 * token 空间与算子注册表 —— public/pykernel/factor_lab 的 TS 镜像
 *
 * 顺序/名称/元数/窗口必须与 ops.py 的 OPS_CONFIG 及 token_encoding.py
 * 逐条一致(算子 token = FEAT_OFFSET + 下标;特征 token = 特征 id)。
 * 改动任何一侧都要同步另一侧——这是 GPU 粗排能与内核对齐的前提。
 *
 * GPU 支持分级(文档 2.8):EMA 为串行递推,无法在 WGSL 中并行化,v1 不支持;
 * 含 EMA 的候选不进 GPU(GP 生成时排除,历史种子走 Pyodide 精算回落)。
 */

export const MAX_FEATURES = 64
export const FEAT_OFFSET = 64
/** 单候选 token 上限(GPU tokens buffer 定长;超长公式回落 CPU 精算) */
export const MAX_TOKENS = 32
/** 栈式求值的最大栈深(树深 ≤ max_depth=6 → 栈深 ≤ 7,留 1 余量) */
export const STACK_LEVELS = 8
export const TOKEN_PAD = 0xffffffff

export type OpKind =
  | "add" | "sub" | "mul" | "div" | "min" | "max"
  | "abs" | "neg" | "sign" | "sqrt" | "signed_log" | "sigmoid" | "tanh"
  | "ts_ma" | "ts_std" | "ts_max" | "ts_min" | "ts_rank" | "ts_zscore"
  | "delta" | "lag" | "atr_norm"
  | "corr" | "beta" | "resid" | "demean"
  | "step" | "ema"

export interface OpDef {
  name: string
  arity: 1 | 2
  kind: OpKind
  /** 滚动窗口大小(时序算子) */
  win?: number
  /** 滞后/差分阶数 */
  n?: number
}

/** 与 OPS_CONFIG 同序(id = 数组下标) */
export const OPS: readonly OpDef[] = [
  { name: "ADD", arity: 2, kind: "add" },
  { name: "SUB", arity: 2, kind: "sub" },
  { name: "MUL", arity: 2, kind: "mul" },
  { name: "DIV", arity: 2, kind: "div" },
  { name: "MIN", arity: 2, kind: "min" },
  { name: "MAX", arity: 2, kind: "max" },
  { name: "ABS", arity: 1, kind: "abs" },
  { name: "NEG", arity: 1, kind: "neg" },
  { name: "SIGN", arity: 1, kind: "sign" },
  { name: "SQRT", arity: 1, kind: "sqrt" },
  { name: "SIGNED_LOG", arity: 1, kind: "signed_log" },
  { name: "SIGMOID", arity: 1, kind: "sigmoid" },
  { name: "TANH", arity: 1, kind: "tanh" },
  { name: "TS_MA_5", arity: 1, kind: "ts_ma", win: 5 },
  { name: "TS_MA_10", arity: 1, kind: "ts_ma", win: 10 },
  { name: "TS_MA_20", arity: 1, kind: "ts_ma", win: 20 },
  { name: "TS_STD_10", arity: 1, kind: "ts_std", win: 10 },
  { name: "TS_STD_20", arity: 1, kind: "ts_std", win: 20 },
  { name: "TS_MAX_10", arity: 1, kind: "ts_max", win: 10 },
  { name: "TS_MAX_20", arity: 1, kind: "ts_max", win: 20 },
  { name: "TS_MIN_10", arity: 1, kind: "ts_min", win: 10 },
  { name: "TS_RANK_10", arity: 1, kind: "ts_rank", win: 10 },
  { name: "TS_RANK_20", arity: 1, kind: "ts_rank", win: 20 },
  { name: "TS_ZSCORE_20", arity: 1, kind: "ts_zscore", win: 20 },
  { name: "DELTA_1", arity: 1, kind: "delta", n: 1 },
  { name: "DELTA_5", arity: 1, kind: "delta", n: 5 },
  { name: "TS_ATR_NORM", arity: 1, kind: "atr_norm" },
  { name: "LAG_1", arity: 1, kind: "lag", n: 1 },
  { name: "LAG_5", arity: 1, kind: "lag", n: 5 },
  { name: "CORR_20", arity: 2, kind: "corr", win: 20 },
  { name: "TS_MA_60", arity: 1, kind: "ts_ma", win: 60 },
  { name: "TS_STD_60", arity: 1, kind: "ts_std", win: 60 },
  { name: "TS_ZSCORE_60", arity: 1, kind: "ts_zscore", win: 60 },
  { name: "TS_RANK_60", arity: 1, kind: "ts_rank", win: 60 },
  { name: "TS_DEMEAN_20", arity: 1, kind: "demean", win: 20 },
  { name: "BETA_20", arity: 2, kind: "beta", win: 20 },
  { name: "RESID_20", arity: 2, kind: "resid", win: 20 },
  { name: "STEP", arity: 1, kind: "step" },
  { name: "EMA_5", arity: 1, kind: "ema", win: 5 },
  { name: "EMA_20", arity: 1, kind: "ema", win: 20 },
] as const

export const OP_INDEX: ReadonlyMap<string, number> = new Map(
  OPS.map((o, i) => [o.name, i]),
)

/** EMA 串行递推无法在 WGSL 并行化(v1 不支持);其余全部支持 */
export const GPU_UNSUPPORTED_KINDS: ReadonlySet<OpKind> = new Set(["ema"])

/** token 序列是否全部落在 GPU 支持范围(算子不支持/超长/栈深超限 → 回落) */
export function tokensGpuSupported(tokens: number[], featCount: number): boolean {
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return false
  // 栈深上界:特征压栈 +1,算子弹栈 arity 再压 1 → 用 tokens_to_tree 同款追踪
  let sp = 0
  let maxSp = 0
  for (const t of tokens) {
    if (t < FEAT_OFFSET) {
      if (t < 0 || t >= featCount) return false
      sp += 1
      maxSp = Math.max(maxSp, sp)
    } else {
      const op = OPS[t - FEAT_OFFSET]
      if (!op) return false
      if (GPU_UNSUPPORTED_KINDS.has(op.kind)) return false
      if (sp < op.arity) return false
      sp -= op.arity - 1
    }
  }
  return sp === 1 && maxSp <= STACK_LEVELS
}
