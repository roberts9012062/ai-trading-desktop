/** Opt-in read-only smoke: raw account rows remain in child-process pipes. */
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { expect, it } from "vitest"
import { queryDailyPnl, createDailyPnlHistory } from "./desktop-daily-pnl"

it.skipIf(!process.env.CYCLEPILOT_SMOKE_EXE)("paginates actual native-signed Snippet bills and calculates local account earnings", async () => {
  const child = spawn(process.env.CYCLEPILOT_SMOKE_EXE!, ["--ignored", "--nocapture", "okx_analytics::tests::analytics_rpc_probe"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const lines = createInterface({ input: child.stdout })
  let pending: { resolve: (data: { rows: Record<string, unknown>[]; demo: boolean }) => void; reject: (error: Error) => void } | null = null
  let reads = 0
  lines.on("line", line => {
    const marker = line.indexOf("CYCLEPILOT_JSON:")
    if (marker < 0) return
    const data = JSON.parse(line.slice(marker + "CYCLEPILOT_JSON:".length))
    const request = pending; pending = null
    if (data.error) request?.reject(new Error(data.error))
    else request?.resolve(data)
  })
  child.on("exit", () => pending?.reject(new Error("Native probe exited")))
  child.on("error", error => pending?.reject(error))
  try {
    const history = createDailyPnlHistory()
    // Two independent native requests can be active; match FIFO messages in
    // the native bridge by serializing pipe access (production IPC is keyed).
    let serial = Promise.resolve()
    const read = (path: string) => {
      const result = serial.then(() => new Promise<{ rows: Record<string, unknown>[]; demo: boolean }>((resolve, reject) => {
      reads++; if (reads % 25 === 0) console.log(JSON.stringify({ progress_reads: reads, route: path.split("?")[0] }))
      pending = { resolve, reject: error => { console.log(JSON.stringify({ failed_route: path.split("?")[0], requests: reads })); reject(error) } }; child.stdin.write(JSON.stringify(path) + "\n")
      }))
      serial = result.then(() => {}, () => {})
      return result
    }
    const local = await queryDailyPnl(read, 90, Date.now(), undefined, history)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(local.summary).not.toBeNull()
    expect(local.days.every(r => Number.isFinite(r.net_after_costs))).toBe(true)
    expect(local.summary!.total_trades).toBe(local.days.reduce((sum, r) => sum + r.trades, 0))
    console.log(JSON.stringify({ native_snippet_reads: reads, days: local.days.length, records: local.summary!.total_trades,
      source: "desktop-native-signing-and-local-aggregation", writes: 0 }))
    const before = reads
    const warm = await queryDailyPnl(read, 90, Date.now(), undefined, history)
    expect(warm.summary).not.toBeNull()
    console.log(JSON.stringify({ incremental_reads: reads - before, writes: 0 }))
  } finally { child.stdin.end(); child.kill(); lines.close() }
}, 360_000)
