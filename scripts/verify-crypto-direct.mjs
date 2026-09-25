// Live public API smoke test. Does not require keys, write to exchanges or publish.
import { createRequire } from "node:module"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const { build } = createRequire(import.meta.resolve("vite"))("esbuild")
const dir = await mkdtemp(join(tmpdir(), "crypto-direct-"))
async function bundle(entry, name) {
  const outfile = join(dir, name + ".mjs")
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile })
  return import(pathToFileURL(outfile))
}
const gate = await bundle("src/lib/gate-futures.ts", "gate")
const direct = await bundle("src/lib/crypto-direct.ts", "direct")
const report = { checked_at: new Date().toISOString(), history: [], books: [] }
for (const timeframe of ["1m", "5m", "60m", "1d"]) {
  const page = await gate.getGateFuturesKlineApi("BTCUSDT", timeframe, { limit: timeframe === "1d" ? 170 : 36 })
  const bars = await gate.enrichGateBars("BTCUSDT", timeframe, page.bars)
  if (bars.some(b => !(b.funding_time < b.open_time && b.derivatives_time < b.open_time && b.open_interest > 0))) throw new Error("Noncausal or missing supplemental history")
  const older = await gate.getGateFuturesKlineApi("BTCUSDT", timeframe, { limit: 3, endTime: bars[0].time })
  if (older.bars.at(-1).time !== bars[0].time || older.bars.length !== 3) throw new Error("Pagination boundary drift")
  report.history.push({ timeframe, count: bars.length, from: bars[0].time, to: bars.at(-1).time, funding_coverage: 1, oi_coverage: 1, pagination: "pass" })
}
for (const channel of ["gate_usdt", "gate_spot", "binance_spot"]) {
  const b = await direct.fetchBookSnapshot(channel, "BTCUSDT")
  report.books.push({ channel, levels: b.levels, spread_bps: b.spread_bps, exchange_timestamp: b.exchange_at !== null })
}
console.log(JSON.stringify(report, null, 2))
