/** Isolated real selectors with read-only fixtures, no account or order API. */
import { createRoot } from "react-dom/client"
import { useState } from "react"
import { SymbolPicker } from "@/components/ai-trading/form/symbol-picker"
import { SymbolCombobox } from "@/components/factor-lab/symbol-combobox"
import { MiningSymbolCombobox } from "@/components/super-factor/mining-symbol-combobox"
import { HunterSymbolMultiSelect } from "@/components/hunter/symbol-multi-select"
import { ContractSearchDialog } from "@/components/market/contract-search-dialog"
import { useAppStore } from "@/stores/app"
import { checkForUpdate, downloadUpdate } from "@/lib/updater"
import "../src/app/globals.css"

if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("仅限本地隔离验收")
const contracts = [{ symbol: "btcusdt", name: "比特币", exchange: "OKX" }, { symbol: "ethusdt", name: "以太坊", exchange: "OKX" }, { symbol: "avaxusdt", name: "雪崩", exchange: "OKX" }]
let requests = 0
let failNext = false
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  if (String(input).startsWith("http://ipc.")) return nativeFetch(input, init)
  if (init?.method && init.method !== "GET") throw new Error("验收禁止写入")
  requests++
  if (failNext) { failNext = false; return new Response("fixture error", { status: 503 }) }
  const url = String(input)
  const data = url.includes("by-code") ? {} : url.includes("search") ? { contracts: contracts.filter(c => c.symbol.includes(new URL(url, location.origin).searchParams.get("q") ?? "")) } : contracts
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })
}
function Preview() {
  const [symbol, setSymbol] = useState("btcusdt")
  const [name, setName] = useState("比特币")
  const [symbols, setSymbols] = useState(["btcusdt"])
  const kind = new URLSearchParams(location.search).get("kind") ?? "factor"
  return <main className="dark p-8 max-w-xl bg-[var(--bg-primary)] min-h-screen text-[var(--text-primary)] space-y-6">
    <h1>合约下拉验收 · {kind}</h1>
    {kind === "factor" && <SymbolCombobox value={symbol} onChange={setSymbol} contracts={contracts} />}
    {kind === "ai" && <SymbolPicker symbol={symbol} symbolName={name} onChange={(code, label) => { setSymbol(code); setName(label) }} />}
    {kind === "mining" && <MiningSymbolCombobox value={symbol} onChange={setSymbol} />}
    {kind === "hunter" && <HunterSymbolMultiSelect id="fixture-hunter" label="猎手" value={symbols} onChange={setSymbols} options={contracts} max={3} loading={false} error={null} onRetry={() => { requests++ }} hint="本地验收" />}
    {kind === "search" && <><button onClick={() => useAppStore.getState().setSearchOpen(true)}>打开合约列表</button><ContractSearchDialog /></>}
    <output data-testid="selected">已选 {symbol}</output>
    <div className="flex gap-3"><button onClick={() => alert(String(requests))}>请求数</button><button onClick={() => { failNext = true }}>下次请求失败</button></div>
  </main>
}
createRoot(document.getElementById("root")!).render(<Preview />)

if (new URLSearchParams(location.search).get("smoke") === "native" && window.__TAURI_INTERNALS__) {
  void (async () => {
    let result: Record<string, unknown>
    try {
      const update = await checkForUpdate()
      if (!update) throw new Error("验收必须发现更新")
      let bytes = 0
      await downloadUpdate(update, progress => { bytes = progress.downloaded })
      result = { native_check: true, version: update.version, verified_download: bytes > 60000000, bytes, installed: false }
      await update.close()
    } catch (error) {
      result = { error: String(error), installed: false }
    }
    await nativeFetch("http://127.0.0.1:5188/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) })
  })()
}
