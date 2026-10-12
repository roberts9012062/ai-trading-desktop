import {expect,it} from "vitest"
import {renderToStaticMarkup} from "react-dom/server"
import {EvolutionProgressPanel} from "./evolution-progress"
import type {EvolutionJob} from "@/lib/factor-evolution-api"
const job = {status:"ready", round:3, max_rounds:20, reports:[{round:2}]} as EvolutionJob
it("uses completed rounds rather than the started round for overall progress and shows fold progress", () => {
  const html=renderToStaticMarkup(<EvolutionProgressPanel job={job} running progress={{phase:"walk_forward",message:"Walk-Forward 样本外验证",round:3,completed_rounds:2,current:1,total:3}} />)
  expect(html).toContain("已完成 2 / 20 轮")
  expect(html).toContain('aria-valuenow="10"')
  expect(html).toContain("第 3 轮")
  expect(html).toContain("1 / 3 折")
  expect(html).toContain("sticky")
})
it("shows activity without inventing a percentage for unlimited rounds or model calls", () => {
  const html=renderToStaticMarkup(<EvolutionProgressPanel job={{...job,max_rounds:0}} running progress={{phase:"model",message:"LLM 优化配方",round:3,completed_rounds:2,current:0,total:0}} />)
  expect(html).toContain("无限迭代")
  expect(html).toContain("LLM 优化配方")
  expect(html).toContain("animate-pulse")
  expect(html).not.toContain("aria-valuenow")
})
it("shows preparation before there is a server job and preserves the terminal status", () => {
  const prep=renderToStaticMarkup(<EvolutionProgressPanel job={null} running={false} preparing stage="下载 ADA 历史行情" />)
  expect(prep).toContain("下载 ADA 历史行情")
  expect(prep).toContain("准备进化数据")
  const paused=renderToStaticMarkup(<EvolutionProgressPanel job={{...job,status:"paused"}} running={false} progress={{phase:"paused",message:"已暂停",round:3,completed_rounds:3,current:0,total:0}} />)
  expect(paused).toContain("已暂停")
  expect(paused).not.toContain("animate-pulse")
})
