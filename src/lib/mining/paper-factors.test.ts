import {describe,it,expect} from 'vitest'
import {paperFactorSeeds,paperFactorCatalog} from './paper-factors'
import {MINING_FEATURES} from './feature-selection'
import {economicResearchSeeds} from './economic-seeds'
import {tokensGpuSupported} from './gpu/tokens'
import {readFileSync} from 'node:fs'
const FEATURE_NAMES=MINING_FEATURES.slice(0,64).map(row=>row.name)

describe('paper inspired research registry',()=>{
  it('keeps all recipes cited and unapproved with unchanged 64 feature slots',()=>{
    expect(FEATURE_NAMES).toHaveLength(64)
    expect(paperFactorCatalog.factors).toHaveLength(6)
    for(const row of paperFactorCatalog.factors){
      expect(row.sources.length).toBeGreaterThan(0)
      expect(row.promotion_eligible).toBe(false)
    }
  })
  it('filters on actual feature availability and diversifies before opposite directions',()=>{
    const active=[0,46,48,50]
    const rows=paperFactorSeeds(active,FEATURE_NAMES)
    expect(rows).toHaveLength(6)
    expect(new Set(rows.map(t=>t.join(','))).size).toBe(6)
    expect(rows[3]).toEqual([...rows[0],71])
    expect(paperFactorSeeds([],FEATURE_NAMES)).toEqual([])
    expect(paperFactorSeeds(active,['unknown'])).toEqual([])
  })
  it('actually joins the GPU and native research seed entry point',()=>{
    const active=FEATURE_NAMES.map((_,i)=>i)
    const paper=paperFactorSeeds(active,FEATURE_NAMES)
    const all=economicResearchSeeds(active,FEATURE_NAMES)
    expect(paper).toHaveLength(12)
    expect(all).toHaveLength(18)
    for(const row of paper){expect(all).toContainEqual(row);expect(tokensGpuSupported(row,64)).toBe(true)}
  })
  it('ships the JSON dependency in both Pyodide loading modes',()=>{
    const manifest=JSON.parse(readFileSync('public/pykernel/kernel-files.json','utf8'))
    expect(manifest.files).toContain('factor_lab/paper_factor_catalog.json')
    expect(manifest.factorFiles).toContain('factor_lab/paper_factor_catalog.json')
  })
})
