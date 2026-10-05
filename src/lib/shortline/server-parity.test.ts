import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { expect, it } from "vitest"
import { scoreAtWindow } from "./evaluator"
import { enhancedShortlineSearch } from "./search-profile"
import { desktopTokensToServerV3 } from "../factor-access"
import type { ShortlineBar } from "./forming-bar"

const backend = resolve(process.cwd(), "../Decentralized transactions/backend")
const python = resolve(backend, ".venv/Scripts/python.exe")
it.skipIf(!existsSync(python))("new shortline evaluator agrees with desktop causal scoring", { timeout: 30000 }, () => {
  for (const minutes of [1, 15]) {
    const bars: ShortlineBar[] = Array.from({length:1600}, (_,i) => {
      const open = 100 + Math.sin(i*.08)*4 + i*.003
      const close = open + Math.sin(i*.3)*.7
      return {timeMs:Date.UTC(2026,0,1) + i*minutes*60000, open,close,
        high:Math.max(open,close)+.2,low:Math.min(open,close)-.2,volume:200+Math.cos(i*.12)*70,
        quoteVolume:0,takerBuyVolume:0,takerBuyQuoteVolume:0,tradeCount:0,sl:[],forming:false}
    })
    const profile = enhancedShortlineSearch(1)
    const formulas = [...profile.seed_tokens, ...profile.search_feature_ids.map(id=>[id,71,71])]
    const expected = scoreAtWindow(bars, formulas.map(tokens=>({tokens}))).scores
    expect(expected.every(v=>v!==null)).toBe(true)
    const serverBars = bars.map(b=>({time:new Date(b.timeMs+8*3600000).toISOString().slice(0,19).replace("T"," "),
      open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume}))
    const script = `import json,sys\nfrom app.services.shortline.evaluator import FormulaEvaluator\nfrom app.services.shortline.contract import Champion\np=json.load(sys.stdin)\ncs=tuple(Champion(i+1,tuple(t),1/len(p['tokens'])) for i,t in enumerate(p['tokens']))\ne=FormulaEvaluator(cs,eval_version='shortline-eval-v2')\nr=e.evaluate(p['bars'][:-1],p['bars'][-1])\nprint(json.dumps(list(r['champions'].values())))`
    const result = JSON.parse(execFileSync(python, ["-c",script], {cwd:backend,
      input:JSON.stringify({tokens:formulas.map(desktopTokensToServerV3),bars:serverBars}), encoding:"utf8"})) as number[]
    result.forEach((v,i)=>expect(v, `tf=${minutes} formula=${formulas[i]}`).toBeCloseTo(expected[i]!,6))
  }
})
