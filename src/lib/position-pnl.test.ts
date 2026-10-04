import { expect, it } from "vitest"
import type { PaperPositionItem } from "./paper-api"
import { positionDisplay } from "./position-pnl"
const pos={direction:"short",quantity:2,avg_price:5,multiplier:1,margin:2,mark_price:4.8,unrealized_pnl:.37} as PaperPositionItem
it("keeps exchange mark and pnl when desktop has no quote",()=>{
  const view=positionDisplay(pos,"live",undefined)
  expect(view.last).toBe(4.8); expect(view.pnl).toBe(.37); expect(view.pct).toBeCloseTo(3.7)
  expect(positionDisplay({...pos,mark_price:undefined},"live",undefined).pnl).toBe(.37)
  expect(positionDisplay({...pos,mark_price:undefined},"live",undefined).last).toBeNull()
})
it("uses real quotes and base coin quantity in virtual mode",()=>{
  const view=positionDisplay(pos,"virtual",4.7)
  expect(view.last).toBe(4.7); expect(view.pnl).toBeCloseTo(.6); expect(view.pct).toBeCloseTo(6)
})
