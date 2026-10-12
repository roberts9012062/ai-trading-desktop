import { useAuthStore } from "@/stores/auth"
import { getEvolutionJob, resumeEvolutionJob, stepEvolutionJob, stopEvolutionJob, type EvolutionJob } from "./factor-evolution-api"

type Snapshot = {job: EvolutionJob | null; running: boolean; error: string | null; stage: string}
let snapshot: Snapshot = {job: null, running: false, error: null, stage: ""}
const listeners = new Set<() => void>()
let sequence = 0
let owner = ""
function scope() { const user = useAuthStore.getState().user; return `${user?.id || ""}:${user?.trading_mode || ""}` }
function storageKey() { return `factor-evolution-job:${scope()}` }
function publish(change: Partial<Snapshot>) {
  snapshot = {...snapshot, ...change}
  listeners.forEach(fn => fn())
}
export const subscribeEvolution = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener)}}
export const evolutionSnapshot = () => snapshot
export const evolutionRunning = (job: EvolutionJob) => job.status === "ready" || job.status === "context"
export function showEvolutionJob(job: EvolutionJob) {
  owner = scope()
  publish({job, error: null})
  try { localStorage.setItem(storageKey(), job.id) } catch { /* server copy remains available */ }
}
export async function restoreEvolution() {
  if (owner === scope() && snapshot.job) return
  ++sequence
  owner = scope()
  publish({job: null, running: false, error: null, stage: ""})
  const id = localStorage.getItem(storageKey())
  if (!id) return
  const expectedOwner = owner
  try { const job = await getEvolutionJob(id); if (scope() === expectedOwner) showEvolutionJob(job) }
  catch (error) { if (scope() === expectedOwner) publish({error: error instanceof Error ? error.message : String(error)}) }
}
export async function runEvolution(job: EvolutionJob, resume = false) {
  if (snapshot.running) return
  const ticket = ++sequence
  owner = scope()
  const expectedOwner = owner
  showEvolutionJob(job)
  publish({running: true, error: null})
  try {
    if (resume) { job = await resumeEvolutionJob(job.id); showEvolutionJob(job) }
    while (ticket === sequence && scope() === expectedOwner && evolutionRunning(job)) {
      const read = Object.values(job.coverage).reduce((s, c) => s + c.read, 0)
      const total = Object.values(job.coverage).reduce((s, c) => s + c.total, 0)
      publish({stage: job.status === "context" ? `模型复盘历史记录 ${read}/${total}` : `第 ${job.round + 1} 轮 · LLM 优化 → 训练/验证 → Walk-Forward`})
      job = await stepEvolutionJob(job.id)
      if (ticket !== sequence || scope() !== expectedOwner) return
      showEvolutionJob(job)
    }
  } catch (error) {
    if (ticket === sequence && scope() === expectedOwner) publish({error: error instanceof Error ? error.message : String(error)})
  } finally {
    if (ticket === sequence) publish({running: false, stage: ""})
  }
}
export async function stopEvolution() {
  const job = snapshot.job
  if (!job) return
  // Server stop flag is independent of the in-flight model request. Its current
  // step may finish, but no further paid iteration starts.
  await stopEvolutionJob(job.id)
  ++sequence
  publish({running: false, stage: "已请求停止；当前模型调用结束后可刷新或恢复"})
}
useAuthStore.subscribe(() => {
  if (owner && owner !== scope()) { ++sequence; owner = ""; publish({job: null, running: false, error: null, stage: ""}) }
})
