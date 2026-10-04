import { expect, it } from "vitest"
import type { AITradingTask } from "../ai-trading-api"
import type { Opportunity, Hunter } from "./api"
import { visibleHunterOpportunities, activeHunterChild, hunterNeedsTaskPoll } from "./task-visibility"
it("removes completed rows but preserves a still open stopped task",()=>{
 const ops=[{task_id:"done",finished_at:"x"},{task_id:"open",finished_at:"x"},{task_id:"waiting",finished_at:null}] as Opportunity[]
 const tasks=[{id:"done",status:"stopped",position_qty:0},{id:"open",status:"stopped",position_qty:2}] as AITradingTask[]
 expect(visibleHunterOpportunities(ops,tasks).map(o=>o.task_id)).toEqual(["open","waiting"])
 expect(activeHunterChild(tasks[0])).toBe(false); expect(activeHunterChild(tasks[1])).toBe(true)
})
it("polls new mounts while a hunter searches even with no existing tasks",()=>{
 expect(hunterNeedsTaskPoll([{status:"running",opportunities:[]}] as unknown as Hunter[])).toBe(true)
 expect(hunterNeedsTaskPoll([{status:"stopped",opportunities:[{finished_at:null}]}] as unknown as Hunter[])).toBe(true)
 expect(hunterNeedsTaskPoll([{status:"stopped",opportunities:[]}] as unknown as Hunter[])).toBe(false)
})
