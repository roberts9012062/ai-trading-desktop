import { beforeEach, expect, it, vi } from "vitest"
import type { EvolutionJob } from "./factor-evolution-api"

const mocks = vi.hoisted(() => ({step: vi.fn(), resume: vi.fn(), stop: vi.fn(), user: {id: "u", trading_mode: "virtual"}, listeners: [] as Array<() => void>}))
vi.mock("@/stores/auth", () => ({useAuthStore: {getState: () => ({user: mocks.user}), subscribe: (fn: () => void) => mocks.listeners.push(fn)}}))
vi.mock("./factor-evolution-api", () => ({getEvolutionJob: vi.fn(), stepEvolutionJob: mocks.step, resumeEvolutionJob: mocks.resume, stopEvolutionJob: mocks.stop}))
import { evolutionSnapshot, runEvolution, stopEvolution } from "./factor-evolution-runner"
const job = (): EvolutionJob => ({id: "j", status: "ready", round: 0, max_rounds: 0, coverage: {}, sealed_used: false} as EvolutionJob)

beforeEach(() => {mocks.step.mockReset(); mocks.resume.mockReset(); mocks.stop.mockReset(); vi.stubGlobal("localStorage", {setItem: vi.fn(), getItem: vi.fn()})})
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
