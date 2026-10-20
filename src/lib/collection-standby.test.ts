import {describe,it,expect} from 'vitest'
import {collectionStandbyEntitled,type CollectionGrant} from './collection-config'

const now=Date.UTC(2026,9,19)
const grant:CollectionGrant={markets:['crypto'],capabilities:['okx_private'],expires_at:new Date(now+60_000).toISOString(),connections:2,rpm:60}

describe('standby package display',()=>{
  it('does not infer standby from private or public market access',()=>{
    expect(collectionStandbyEntitled([grant],now)).toBe(false)
    expect(collectionStandbyEntitled([{...grant,standby_executor:false}],now)).toBe(false)
  })
  it('requires explicit standby, crypto private access and a live expiry',()=>{
    expect(collectionStandbyEntitled([{...grant,standby_executor:true}],now)).toBe(true)
    expect(collectionStandbyEntitled([{...grant,standby_executor:true,expires_at:new Date(now).toISOString()}],now)).toBe(false)
    expect(collectionStandbyEntitled([{...grant,standby_executor:true,capabilities:['history']}],now)).toBe(false)
    expect(collectionStandbyEntitled([{...grant,standby_executor:true,markets:['a_stock']}],now)).toBe(false)
    expect(collectionStandbyEntitled([{...grant,standby_executor:true,expires_at:'invalid'}],now)).toBe(false)
  })
})
