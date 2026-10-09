/** Read-only live smoke test of the production adapter (no login/account APIs). */
import { createRequire } from "node:module"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.resolve("vite"))
const { build } = require("esbuild")
const root = resolve(import.meta.dirname, "..")
const temp = await mkdtemp(join(tmpdir(), "cyclepilot-snippet-smoke-"))
const option = key => { const at = process.argv.indexOf(key); return at >= 0 ? process.argv[at + 1] : undefined }
const symbols = option("--symbols-file") ? JSON.parse(await readFile(option("--symbols-file"), "utf8")) : ["adausdt", "btcusdt", "ethusdt"]
const report = { startedAt: new Date().toISOString(), requestedPrices: symbols.length, opened: 0, pongs: 0, subscriptions: 0, protocolErrors: [], priceUpdates: 0, candleUpdates: 0, priceSymbols: new Set(), candlePeriods: new Set(), states: [], snapshots: {} }
const Native = globalThis.WebSocket
globalThis.WebSocket = class extends Native {
  constructor(url) {
    super(url)
    this.addEventListener("open", () => { report.opened++ })
    this.addEventListener("message", event => {
      if (event.data === "pong") { report.pongs++; return }
      try {
        const data = JSON.parse(event.data)
        if (data.event === "subscribe") report.subscriptions++
        if (data.event === "error") report.protocolErrors.push({ code: data.code, msg: data.msg, arg: data.arg })
      } catch { /* Adapter validates JSON independently. */ }
    })
  }
}
let ws
try {
  await build({ entryPoints: [join(root, "src/lib/okx-snippet-ws.ts")], outfile: join(temp, "adapter.mjs"), bundle: true, format: "esm", platform: "browser", target: "es2022" })
  const { OkxSnippetWebSocket } = await import(pathToFileURL(join(temp, "adapter.mjs")))
  ws = new OkxSnippetWebSocket()
  ws.onStateChange(state => report.states.push({ kind: "candles", state }))
  ws.onQuoteStateChange(state => report.states.push({ kind: "prices", state }))
  ws.onMessage(message => {
    for (const item of message.data) {
      if (message.type === "quote") { report.priceUpdates++; report.priceSymbols.add(item.symbol) }
      else if (message.type === "chart_kline") { report.candleUpdates++; report.candlePeriods.add(item.period); report.snapshots[item.period] = item.bar }
    }
  })
  ws.setQuoteSymbols(symbols)
  ws.setChartSubscription(["1m", "5m", "15m", "30m", "60m", "240m", "1d"].map(period => ({ symbol: "adausdt", period })))
  ws.connect(); ws.connect()
  await new Promise(resolve => setTimeout(resolve, 40000))
  report.freshPriceCount = ws.freshQuoteSymbols().length
  report.freshAda15m = ws.hasFreshCandle("adausdt", "15m")
  ws.disconnect()
  report.finishedAt = new Date().toISOString()
  report.priceSymbols = [...report.priceSymbols].sort(); report.candlePeriods = [...report.candlePeriods].sort()
  report.priceSymbolsUsingServerFallback = symbols.filter(symbol => !report.priceSymbols.includes(symbol))
  report.completePriceCoverage = report.priceSymbolsUsingServerFallback.length === 0
  report.ok = report.opened === 2 && report.pongs >= 2 && report.priceSymbols.includes("adausdt") && report.candlePeriods.length === 7 && report.freshAda15m
  const json = JSON.stringify(report, null, 2)
  if (option("--out")) await writeFile(option("--out"), json)
  console.log(json)
  if (!report.ok) process.exitCode = 1
} finally {
  ws?.disconnect(); globalThis.WebSocket = Native
  await rm(temp, { recursive: true, force: true })
}
