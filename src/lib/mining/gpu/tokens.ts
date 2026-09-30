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
/** GPU 每候选指标槽数:0-8 同 evaluate_factor(槽8=composite),9/10 = 训练段分块稳健性
 * (正 sortino 块占比 / 最差块 sortino)。与 eval-vm.wgsl 的 base = p*11u 同步 */
export const METRIC_STRIDE = 11

export type OpKind =
  | "add" | "sub" | "mul" | "div" | "min" | "max"
  | "abs" | "neg" | "sign" | "sqrt" | "signed_log" | "sigmoid" | "tanh"
  | "ts_ma" | "ts_std" | "ts_max" | "ts_min" | "ts_rank" | "ts_zscore"
  | "delta" | "lag" | "atr_norm"
  | "corr" | "beta" | "resid" | "demean"
  | "step" | "ema" | "ts_crank" | "decay_linear"
  | "robust_zscore" | "winsor"
  | "vol_scale" | "snr"

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
  { name: "TS_CRANK_20", arity: 1, kind: "ts_crank", win: 20 },
  { name: "TS_CRANK_60", arity: 1, kind: "ts_crank", win: 60 },
  { name: "DECAY_LINEAR_10", arity: 1, kind: "decay_linear", win: 10 },
  { name: "DECAY_LINEAR_20", arity: 1, kind: "decay_linear", win: 20 },
  // 批次3(crypto_local_v2 稳健变换):排序类滚动统计,WGSL 未实现 → GPU 不支持,
  // 含这些算子的候选由 GP 生成时排除/历史种子走 CPU 精算回落
  { name: "ROBUST_ZSCORE_20", arity: 1, kind: "robust_zscore", win: 20 },
  { name: "WINSOR_20", arity: 1, kind: "winsor", win: 20 },
  // 批次4(加密波动率自适应/长周期):均为 MA/STD 族与差分的组合,WGSL 已实现
  { name: "VOL_SCALE_20", arity: 1, kind: "vol_scale", win: 20 },
  { name: "SNR_20", arity: 1, kind: "snr", win: 20 },
  { name: "SNR_60", arity: 1, kind: "snr", win: 60 },
  { name: "TS_ZSCORE_120", arity: 1, kind: "ts_zscore", win: 120 },
  { name: "DELTA_24", arity: 1, kind: "delta", n: 24 },
] as const

export const OP_INDEX: ReadonlyMap<string, number> = new Map(
  OPS.map((o, i) => [o.name, i]),
)

/** EMA 串行递推无法在 WGSL 并行化(v1 不支持);robust_zscore/winsor 为
 * 排序类滚动统计,WGSL 尚未实现(v2 批次3),同样不支持。其余全部支持。
 * 原生 Taichi 引擎(m3.3)与 CPU 内核已实现全部 51 算子——这两条路径
 * 传 fullOps=true 跳过 WGSL 限制。
 */
export const GPU_UNSUPPORTED_KINDS: ReadonlySet<OpKind> =
  new Set(["ema", "robust_zscore", "winsor"])

/** token 序列是否全部落在执行引擎支持范围(算子不支持/超长/栈深超限 → 回落)
 *  fullOps=true 时仅校验结构,不限算子种类(原生 m3.3+/CPU 内核)。 */
export function tokensGpuSupported(tokens: number[], featCount: number, fullOps = false): boolean {
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
      if (!fullOps && GPU_UNSUPPORTED_KINDS.has(op.kind)) return false
      if (sp < op.arity) return false
      sp -= op.arity - 1
    }
  }
  return sp === 1 && maxSp <= STACK_LEVELS
}
