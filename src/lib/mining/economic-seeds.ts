import { FEAT_OFFSET, OPS } from './gpu/tokens'
import type { MiningConfig } from './types'

/** Mirror of factor_lab.economic_templates: hypotheses, not approved strategies. */
export function economicResearchSeeds(active: readonly number[], names: readonly string[]): number[][] {
  const allowed = new Set(active)
  const op = (name: string) => {
    const id = OPS.findIndex(row => row.name === name)
    if (id < 0) throw new Error(`Unknown operator: ${name}`)
    return FEAT_OFFSET + id
  }
  const specs = [
    ['TAKER_IMB24', 'CRYPTO_MOM24', 'SUB'],
    ['TAKER_IMB24', 'FUNDING_MEAN24', 'SUB'],
    ['OI_TREND24', 'TAKER_IMB24', 'MUL'],
  ]
  const pairs = specs.flatMap(([left, right, combine]) => {
    const a = names.indexOf(left), b = names.indexOf(right)
    if (a < 0 || b < 0 || !allowed.has(a) || !allowed.has(b)) return []
    const tokens = [a, b, op(combine), op('TS_MA_60')]
    return [[tokens, [...tokens, op('NEG')]]]
  })
  return [0, 1].flatMap(i => pairs.map(pair => pair[i]))
}

export function withEconomicResearchSeeds(config: MiningConfig, seeds: number[][],
  active: readonly number[], names: readonly string[]): number[][] {
  if (config.research_profile !== 'crypto_local_v2' || !config.economic_seed_research) return seeds
  const seen = new Set(seeds.map(tokens => tokens.join(',')))
  const quota = Math.max(0, Math.min(Math.round(config.population * .25), config.population - seeds.length - 2))
  const additions = economicResearchSeeds(active, names).filter(tokens => !seen.has(tokens.join(','))).slice(0, quota)
  return [...seeds, ...additions]
}
