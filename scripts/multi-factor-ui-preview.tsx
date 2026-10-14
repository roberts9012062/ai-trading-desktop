/** Real components with fixture-only APIs. Never creates a trading task. */
import {useState} from "react"
import {createRoot} from "react-dom/client"
import {MemoryRouter} from "react-router-dom"
import "../src/app/globals.css"
import {MultiFactorParams} from "@/components/ai-trading/form/multi-factor-params"
import {MiningFeatureSettings} from "@/components/factor-lab/mining-feature-settings"
import {ShortlineFavoritesPanel} from "@/components/strategy-favorites/shortline-favorites-panel"
import {StrategyTypePicker} from "@/components/ai-trading/form/strategy-type-picker"
import {DEFAULT_QUANT_PARAMS} from "@/lib/quant-strategy"
import {ALL_MINING_FEATURE_IDS} from "@/lib/mining/feature-selection"

if (location.hostname !== "127.0.0.1" || location.port !== "5193") throw new Error("仅限本机隔离验收端口")
const fixture = [
  {id:"a",name:"动量延续",symbol:"btcusdt",timeframe:"15m",tokens:[0,135,135],text:"RET",metrics:{ann_ret:.25},folder_id:"trend"},
  {id:"b",name:"价格反转",symbol:"btcusdt",timeframe:"60m",tokens:[8,135],text:"NEG(DEV)",metrics:{ann_ret:-.1},folder_id:null},
  {id:"c",name:"量价流向",symbol:"btcusdt",timeframe:"240m",tokens:[13,135,135],text:"PV_CORR",metrics:{ann_ret:1.2},folder_id:null},
]
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin)
  if (url.pathname === "/api/factor-lab/favorites") return Response.json({items:fixture})
  if (url.pathname === "/api/factor-lab/similarity") {
    const body = JSON.parse(String(init?.body))
    return Response.json({symbol:body.symbol,timeframe:body.timeframe,bars:600,factors:[],verdict:"低契合度",pairs:[{i:0,j:1,similarity:2.4,value_corr:.2,pnl_corr:.27,win_overlap_pct:20,level:"low"}]})
  }
  if (url.pathname === "/api/strategy-folders") return Response.json({items:[{id:"trend",name:"趋势短线",kind:"shortline"}]})
  if (url.pathname === "/api/shortline/favorites") return Response.json({items:fixture})
  if (url.pathname.startsWith("/api/shortline/favorites/") && init?.method === "PATCH") {
    const f = fixture.find(f => url.pathname.endsWith(f.id))!
    Object.assign(f, JSON.parse(String(init.body)))
    return Response.json(f)
  }
  throw new Error("隔离验收禁止外部API："+url.pathname)
}
function Preview() {
  const [quant,setQuant] = useState({...DEFAULT_QUANT_PARAMS,quantKind:"multi_factor" as const})
  const [selected,setSelected] = useState([...ALL_MINING_FEATURE_IDS])
  return <main className="max-w-6xl mx-auto p-6 space-y-6">
    <h1 className="text-xl">多因子协作与收藏 · 隔离验收</h1>
    <StrategyTypePicker value={quant.quantKind} onChange={kind => setQuant({...quant,quantKind:kind as "multi_factor"})}/>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section className="rounded-lg border border-[var(--border)] p-4"><h2 className="text-sm mb-3">多因子协作量化</h2><MultiFactorParams quant={quant} onQuant={q => setQuant({...q,quantKind:"multi_factor"})} symbol="btcusdt" timeframe="15m"/></section>
      <section><MiningFeatureSettings selected={selected} onChange={setSelected}/></section>
    </div>
    <section className="h-[460px] border border-[var(--border)] rounded-lg"><ShortlineFavoritesPanel/></section>
  </main>
}
createRoot(document.getElementById("root")!).render(<MemoryRouter><Preview/></MemoryRouter>)
