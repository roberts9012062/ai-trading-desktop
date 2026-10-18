import { describe, expect, it } from 'vitest'
import { economicResearchSeeds, withEconomicResearchSeeds } from './economic-seeds'
import type { MiningConfig } from './types'

const names = Array.from({ length: 64 }, (_, i) => `f${i}`)
names[46] = 'CRYPTO_MOM24'
names[59] = 'FUNDING_MEAN24'
names[60] = 'OI_TREND24'
names[61] = 'TAKER_IMB24'
const active = [46, 59, 60, 61]

describe('bounded economic research hypotheses', () => {
  it('uses existing IDs and rotates families before opposite directions', () => {
    expect(economicResearchSeeds(active, names)).toEqual([
      [61, 46, 65, 94], [61, 59, 65, 94], [60, 61, 66, 94],
      [61, 46, 100, 79], [59, 46, 100, 71, 79],
      [61, 46, 65, 94, 71], [61, 59, 65, 94, 71], [60, 61, 66, 94, 71],
      [61, 46, 100, 79, 71], [59, 46, 100, 71, 79, 71],
    ])
  })
  it('never substitutes absent OI or funding, and requires actual registry names', () => {
    expect(economicResearchSeeds([46, 61], names)).toHaveLength(4)
    expect(economicResearchSeeds([46, 59, 60], names)).toEqual([[59,46,100,71,79],[59,46,100,71,79,71]])
    expect(economicResearchSeeds(active, ['unknown'])).toEqual([])
  })
  it('keeps user seeds first and limits additions to a quarter, with two random slots', () => {
    const cfg = { research_profile: 'crypto_local_v2', population: 12, economic_seed_research: true } as MiningConfig
    expect(withEconomicResearchSeeds(cfg, [[0]], active, names)).toEqual([
      [0], [61, 46, 65, 94], [61, 59, 65, 94], [60, 61, 66, 94],
    ])
    expect(withEconomicResearchSeeds({ ...cfg, population: 3 }, [[0]], active, names)).toEqual([[0]])
    expect(withEconomicResearchSeeds({ ...cfg, economic_seed_research: false }, [[0]], active, names)).toEqual([[0]])
    expect(withEconomicResearchSeeds({ ...cfg, research_profile: 'legacy' } as unknown as MiningConfig,
      [[0]], active, names)).toEqual([[0]])
  })
})
