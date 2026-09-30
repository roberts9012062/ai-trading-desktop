/**
 * 冠军种子库 —— G2 冻结证据中通过全部合格门的冠军公式(token 形式)。
 *
 * 来源:tests/native_engine/fixtures/champion-qualification.json.gz(G2 黄金
 * 套件,CPU/native 两引擎逐位一致验证过的合格冠军,2026-09 冻结)。种子经
 * seed_tokens 注入后:原生 GPU 路径开跑前会对种子立即跑一次完整精算
 * (native-gpu-core.ts precise(seedTokens)),CPU/WebGPU 内核把种子放进初始
 * 种群头部并作 v2 因子族模板(20%~30% 初始种群)。
 *
 * 跨周期迁移:token 里的窗口是"根数"口径,60m 冠军用作 15m 种子时同一
 * 公式的回看窗对应的自然时间缩短 4 倍——结构(慢信号+平滑算子堆叠)保留,
 * 由进化在新周期上重新适配参数。跨币迁移已有先例:ADA 与 BNB 共用同一条
 * 合格公式。
 */

export interface ChampionSeed {
  tokens: number[]
  text: string
  /** 冻结证据里的合格组合 */
  symbol: string
  timeframe: string
}

export const CHAMPION_SEED_LIBRARY: readonly ChampionSeed[] = [
  {
    tokens: [6, 75, 106, 111, 111, 79, 79],
    text: "20周期均值(20周期均值(20周期信噪比(20周期信噪比(10周期线性衰减(S型(量能波动))))))",
    symbol: "ADAUSDT",
    timeframe: "30m",
  },
  {
    tokens: [43, 83, 97, 98, 84],
    text: "10周期最低(20周期去均值(60周期分位(20周期最高(UTC星期余弦))))",
    symbol: "ADAUSDT",
    timeframe: "30m",
  },
  {
    tokens: [43, 83, 97, 98, 84],
    text: "10周期最低(20周期去均值(60周期分位(20周期最高(UTC星期余弦))))",
    symbol: "BNBUSDT",
    timeframe: "30m",
  },
  {
    tokens: [21, 20, 64, 80, 94, 84],
    text: "10周期最低(60周期均值(10周期标准差((上影线 + 收盘位置))))",
    symbol: "BTCUSDT",
    timeframe: "30m",
  },
  {
    tokens: [21, 20, 64, 80, 94, 84],
    text: "10周期最低(60周期均值(10周期标准差((上影线 + 收盘位置))))",
    symbol: "BTCUSDT",
    timeframe: "60m",
  },
  {
    tokens: [9, 81, 43, 89, 68, 98, 107, 113, 9, 80, 49, 35, 65, 100, 72, 111, 78, 69],
    text: "取大(120周期Z值(20周期线性衰减(20周期去均值(取小(20周期标准差(RSI), 五阶差分(UTC星期余弦))))), 10周期均值(20周期信噪比(符号(20周期残差(…)))))",
    symbol: "LTCUSDT",
    timeframe: "60m",
  },
  {
    tokens: [20, 92, 47, 64, 92, 77, 94, 114],
    text: "24根差分(60周期均值(5周期均值(滞后5根((滞后5根(收盘位置) + 20根收益波动)))))",
    symbol: "LTCUSDT",
    timeframe: "60m",
  },
  // 2026-09-30 全周期验证批次(ETHUSDT 1d,五年 Binance 永续归档,CPU 内核
  // 600×40 种子注入实跑合格;全部原生引擎兼容,无 EMA/稳健化算子)
  {
    tokens: [10, 112, 83, 10, 64, 80, 96, 89, 10, 68, 94],
    text: "60周期均值(取小(五阶差分(60周期Z值(10周期标准差((20周期最高(60周期信噪比(收益自相关)) + 收益自相关)))), 收益自相关))",
    symbol: "ETHUSDT",
    timeframe: "1d",
  },
  {
    tokens: [5, 11, 65, 94, 54, 69, 89, 113, 10, 68, 89, 10, 68, 94],
    text: "60周期均值(取小(五阶差分(取小(120周期Z值(五阶差分(取大(60周期均值((ATR波动 - 量比)), 主动买卖量不平衡))), 收益自相关)), 收益自相关))",
    symbol: "ETHUSDT",
    timeframe: "1d",
  },
  {
    tokens: [10, 83, 10, 112, 64, 80, 96, 98, 10, 68, 94, 75],
    text: "S型(60周期均值(取小(20周期去均值(60周期Z值(10周期标准差((20周期最高(收益自相关) + 60周期信噪比(收益自相关))))), 收益自相关)))",
    symbol: "ETHUSDT",
    timeframe: "1d",
  },
  // 2026-09-30 原生 m3.3 验证批次(BTCUSDT 1d,原生引擎 600×40 实跑合格;
  // 首个用到 ROBUST_ZSCORE_20(m3.3 新算子)的合格冠军)
  {
    tokens: [10, 96, 89, 108, 10, 80, 96, 89, 96, 10, 68, 68, 94],
    text: "60周期均值(取小(20周期稳健Z值(五阶差分(60周期Z值(收益自相关))), 取小(60周期Z值(五阶差分(60周期Z值(10周期标准差(收益自相关)))), 收益自相关)))",
    symbol: "BTCUSDT",
    timeframe: "1d",
  },
]

const byExact = new Map<string, ChampionSeed[]>()
const byTimeframe = new Map<string, ChampionSeed[]>()
for (const seed of CHAMPION_SEED_LIBRARY) {
  const key = `${seed.symbol.trim().toLowerCase()}|${seed.timeframe}`
  const exact = byExact.get(key) ?? []
  exact.push(seed)
  byExact.set(key, exact)
  const tf = byTimeframe.get(seed.timeframe) ?? []
  tf.push(seed)
  byTimeframe.set(seed.timeframe, tf)
}

/** 短周期(≤15m)慢因子搜索的先验算子权重见 gpu/gp.ts slowBiasedOpSets */

export interface SeedSelection {
  seeds: ChampionSeed[]
  /** 给用户看的命中说明 */
  note: string
}

/** 选种子:精确(币+周期) > 同周期跨币 > 全库(跨周期族迁移)。去重同 token。 */
export function championSeedsFor(symbol: string, timeframe: string): SeedSelection {
  const norm = symbol.trim().toLowerCase()
  const exact = byExact.get(`${norm}|${timeframe}`)
  if (exact?.length) {
    return { seeds: dedupe(exact), note: `命中 ${exact.length} 条同币种同周期合格冠军种子` }
  }
  const sameTf = dedupe(byTimeframe.get(timeframe) ?? [])
  if (sameTf.length) {
    const symbols = [...new Set(sameTf.map(s => s.symbol))].join("/")
    return { seeds: sameTf, note: `无同币种种子,注入同周期跨币种子 ${sameTf.length} 条(${symbols})` }
  }
  const all = dedupe([...CHAMPION_SEED_LIBRARY])
  return { seeds: all, note: `注入跨周期族迁移种子 ${all.length} 条(30m/60m 合格冠军,窗口按根数在新周期上重新适配)` }
}

function dedupe(seeds: ChampionSeed[]): ChampionSeed[] {
  const seen = new Set<string>()
  return seeds.filter(s => {
    const key = s.tokens.join(",")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
