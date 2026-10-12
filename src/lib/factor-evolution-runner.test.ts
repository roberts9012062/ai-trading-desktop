import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { EvolutionJob } from "./factor-evolution-api"

const mocks = vi.hoisted(() => ({step: vi.fn(), progress: vi.fn(), resume: vi.fn(), stop: vi.fn(), user: {id: "u", trading_mode: "virtual"}, listeners: [] as Array<() => void>}))
vi.mock("@/stores/auth", () => ({useAuthStore: {getState: () => ({user: mocks.user}), subscribe: (fn: () => void) => mocks.listeners.push(fn)}}))
vi.mock("./factor-evolution-api", () => ({getEvolutionJob: vi.fn(), getEvolutionProgress: mocks.progress, stepEvolutionJob: mocks.step, resumeEvolutionJob: mocks.resume, stopEvolutionJob: mocks.stop}))
import { evolutionSnapshot, runEvolution, stopEvolution } from "./factor-evolution-runner"
const job = (): EvolutionJob => ({id: "j", status: "ready", round: 0, max_rounds: 0, coverage: {}, sealed_used: false} as EvolutionJob)

beforeEach(() => {mocks.step.mockReset(); mocks.progress.mockReset(); mocks.resume.mockReset(); mocks.stop.mockReset(); vi.stubGlobal("localStorage", {setItem: vi.fn(), getItem: vi.fn()})})
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals()})
it("0 continues through failed rounds and stops at the first complete pass", async () => {
  mocks.step.mockResolvedValueOnce({...job(), round: 1}).mockResolvedValueOnce({...job(), round: 2, status: "passed", sealed_used: true})
  await runEvolution(job())
  expect(mocks.step).toHaveBeenCalledTimes(2)
  expect(evolutionSnapshot().running).toBe(false)
  expect(evolutionSnapshot().job?.round).toBe(2)
})
it("a stop during an in-flight call prevents another paid iteration", async () => {
  let finish: (value: EvolutionJob) => void = () => {}
  mocks.step.mockImplementation(() => new Promise<EvolutionJob>(resolve => {finish = resolve}))
  mocks.stop.mockResolvedValue({status: "stopping"})
  const running = runEvolution(job())
  await stopEvolution()
  finish({...job(), round: 1})
  await running
  expect(mocks.step).toHaveBeenCalledTimes(1)
  expect(evolutionSnapshot().running).toBe(false)
})
it("sealed failure is terminal even with unlimited rounds", async () => {
  mocks.step.mockResolvedValue({...job(), round: 1, status: "sealed_failed", sealed_used: true})
  await runEvolution(job())
  expect(mocks.step).toHaveBeenCalledTimes(1)
})

it("polls real phases while the step is pending and discards late progress after completion", async () => {
  vi.useFakeTimers()
  let finish!: (value: EvolutionJob) => void
  let finishPoll!: (value: unknown) => void
  mocks.step.mockImplementation(() => new Promise<EvolutionJob>(resolve => {finish = resolve}))
  mocks.progress.mockResolvedValueOnce({progress: {phase:"walk_forward",message:"Walk-Forward 样本外验证",round:1,completed_rounds:0,current:2,total:3}})
    .mockImplementationOnce(() => new Promise(resolve => {finishPoll = resolve}))
  const running = runEvolution(job())
  await vi.advanceTimersByTimeAsync(2000)
  expect(evolutionSnapshot().progress?.phase).toBe("walk_forward")
  expect(evolutionSnapshot().progress?.current).toBe(2)
  expect(evolutionSnapshot().stepStartedAt).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(2000)
  finish({...job(), round:1, status:"passed", progress:{phase:"passed",message:"验收通过",round:1,completed_rounds:1,current:0,total:0}})
  await running
  finishPoll({progress:{phase:"model",message:"过期状态",round:1}})
  await vi.advanceTimersByTimeAsync(10000)
  expect(evolutionSnapshot().progress?.phase).toBe("passed")
  expect(mocks.progress).toHaveBeenCalledTimes(2)
})

it("a failed progress read does not cancel the real iteration and stop prevents more polling", async () => {
  vi.useFakeTimers()
  let finish!: (value: EvolutionJob) => void
  mocks.step.mockImplementation(() => new Promise<EvolutionJob>(resolve => {finish = resolve}))
  mocks.progress.mockRejectedValue(new Error("temporary network failure"))
  mocks.stop.mockResolvedValue({status:"stopping"})
  const running = runEvolution(job())
  await vi.advanceTimersByTimeAsync(2000)
  expect(evolutionSnapshot().running).toBe(true)
  expect(evolutionSnapshot().error).toBeNull()
  await stopEvolution()
  await vi.advanceTimersByTimeAsync(10000)
  expect(mocks.progress).toHaveBeenCalledTimes(1)
  finish({...job(), round:1})
  await running
})
