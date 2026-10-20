import {expect,it} from 'vitest'
import {manualChapters} from './manual-content'

it('does not expose deferred features through the searchable manual or old screenshots',()=>{
  expect(JSON.stringify(manualChapters)).not.toMatch(/hunter|猎手/i)
  for(const id of ['ai-trading','profit-lock','quant','strategy-transfer']){
    const chapter=manualChapters.find(row=>row.id===id)
    expect(chapter?.steps.length).toBeGreaterThan(0)
    expect(chapter?.image).toBe('')
  }
})
