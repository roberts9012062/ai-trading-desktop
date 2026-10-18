import registry from '../../../public/pykernel/factor_lab/paper_factor_catalog.json'
import {FEAT_OFFSET,OPS} from './gpu/tokens'

export const paperFactorCatalog=registry

/** Active IDs come from training coverage, not a hard-coded all-features list. */
export function paperFactorSeeds(active:readonly number[],names:readonly string[]):number[][] {
  const allowed=new Set(active)
  const op=(name:string)=>OPS.findIndex(row=>row.name===name)
  const pairs=registry.factors.flatMap(row=>{
    if(row.features.some(name=>!allowed.has(names.indexOf(name))))return []
    const tokens=row.rpn.map(name=>{
      const i=names.indexOf(name)
      if(i>=0&&i<FEAT_OFFSET)return i
      const operator=op(name)
      if(operator<0)throw new Error(`Unknown paper-factor token: ${name}`)
      return FEAT_OFFSET+operator
    })
    return [[tokens,[...tokens,FEAT_OFFSET+op('NEG')]]]
  })
  return [0,1].flatMap(direction=>pairs.map(pair=>pair[direction]))
}
