import { championSeedsFor, CHAMPION_SEED_LIBRARY } from "./champion-seeds"
import type { MiningConfig } from "./types"

const library = new Set(CHAMPION_SEED_LIBRARY.map(seed => seed.tokens.join(",")))

export function automaticLibrarySeeds(config: Pick<MiningConfig, "symbol" | "timeframe" | "seed_tokens" | "seed_origin">): boolean {
  const seeds = config.seed_tokens ?? []
  if (!seeds.length || config.seed_origin === "custom") return false
  if (config.seed_origin === "champion_library") return seeds.every(seed => library.has(seed.join(",")))
  // Older saved requests predate the origin field. Recognize the complete
  // automatic selection, rather than treating arbitrary library subsets as auto.
  const expected = championSeedsFor(config.symbol,config.timeframe).seeds.map(seed => seed.tokens.join(",")).sort()
  const actual = seeds.map(seed => seed.join(",")).sort()
  return expected.length === actual.length && expected.every((key,i) => key === actual[i])
}

/** Only training availability decides admission. Never substitute missing inputs. */
export function compatibleTrainingSeeds(config: MiningConfig, active: readonly number[], names: readonly string[]) {
  const input = config.seed_tokens ?? []
  const allowed = new Set(active)
  const missing = (tokens: number[]) => [...new Set(tokens.filter(t => t < 64 && !allowed.has(t)))]
  const rejected = input.map((tokens,index) => ({index,missing:missing(tokens)})).filter(row => row.missing.length)
  const label = (id: number) => {
    const name = names[id] ?? `特征 #${id}`
    return id === 54 ? `${name}（主动买卖量不平衡）` : name
  }
  const unavailable = [...new Set(rejected.flatMap(row => row.missing))].map(label).join("、")
  if (rejected.length && !automaticLibrarySeeds(config)) {
    throw new Error(`种子依赖当前训练数据不可用的特征：${unavailable}。请更换种子或使用包含这些特征且训练段有效的数据`)
  }
  const seeds = input.filter(tokens => !missing(tokens).length)
  const warning = rejected.length
    ? `自动种子适配：使用 ${seeds.length}/${input.length} 条，跳过 ${rejected.length} 条（${unavailable} 在训练段缺失或无变化）`
    : undefined
  return {seeds,warning,rejected}
}
