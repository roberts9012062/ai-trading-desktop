import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { parseStrategyFile, missingTransferModels, strategyTransfer, TransferError, type StrategyFile, type TransferPreview } from "./strategy-transfer"

const file: StrategyFile = { format:"cyclepilot-strategies", version:1, items:[{kind:"task",encoding:"server-v3",config:{name:"任务",symbol:"btcusdt",strategy_type:"ai",leverage:7,margin_per_trade:125,extra_timeframes:["60m"],close_rules:{profit_lock:{enabled:true}}}}] }
const preview: TransferPreview = {models:[],items:[{index:0,kind:"task",name:"任务",symbol:"btcusdt",timeframe:"15m",category:"AI 交易",folder:"AI 交易",conflict:false,requires_model:true,model_row_id:null}]}
const fetchMock=vi.fn()
beforeEach(()=>{ vi.stubGlobal("localStorage",{getItem:()=>"test-token"}); vi.stubGlobal("fetch",fetchMock); fetchMock.mockReset(); fetchMock.mockResolvedValue(new Response(JSON.stringify({imported:1,duplicates:0,items:[]}))) })
afterEach(()=>vi.unstubAllGlobals())

it("round-trips full task settings and tolerates a UTF-8 BOM",()=>{
  const parsed=parseStrategyFile("\uFEFF"+JSON.stringify(file))
  expect(parsed).toEqual(file)
  expect(parsed.items[0].config.leverage).toBe(7)
  expect(parsed.items[0].config.extra_timeframes).toEqual(["60m"])
})
it("keeps shortline and ordinary factors in their own explicit dialects",()=>{
  const mixed={...file,items:[{kind:"factor",encoding:"server-v3",config:{tokens:[52,0,128]}},{kind:"shortline",encoding:"desktop-shortline-v1",config:{tokens:[52,0,128]}}]}
  expect(parseStrategyFile(JSON.stringify(mixed)).items.map(i=>i.kind)).toEqual(["factor","shortline"])
  mixed.items[1].encoding="server-v3"
  expect(()=>parseStrategyFile(JSON.stringify(mixed))).toThrow("编码")
})
it("rejects invalid JSON, empty files, unknown versions and unclassified entries",()=>{
  for(const data of ["invalid","null",JSON.stringify({...file,version:2}),JSON.stringify({...file,items:[]}),JSON.stringify({...file,items:[{kind:"other",config:{}}]})]) expect(()=>parseStrategyFile(data)).toThrow()
})
it("requires an execution model only for task entries that need one",()=>{
  expect(missingTransferModels(file,preview,{})).toBe(true)
  expect(missingTransferModels(file,preview,{"0":"owned-model"})).toBe(false)
  expect(missingTransferModels(file,{...preview,items:[{...preview.items[0],requires_model:false}]},{})).toBe(false)
})
it("never activates tasks during favorite import, even if a previous run choice was selected",async()=>{
  await strategyTransfer.import(file,"favorites",true,{})
  const options=fetchMock.mock.calls[0][1] as RequestInit
  expect(JSON.parse(String(options.body))).toMatchObject({destination:"favorites",auto_start:false,file})
  expect(options.headers).toMatchObject({Authorization:"Bearer test-token"})
})
it("sends the user's explicit task run choice without altering the exported configuration",async()=>{
  await strategyTransfer.import(file,"tasks",false,{"0":"owned-model"})
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({auto_start:false,models:{"0":"owned-model"},file})
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({imported:1,duplicates:0,items:[]})))
  await strategyTransfer.import(file,"tasks",true,{"0":"owned-model"})
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).auto_start).toBe(true)
})
it("returns conflict symbols so a late collision offers saving to favorites",async()=>{
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({detail:{code:"symbol_conflict",symbols:["btcusdt"],message:"相同币种已存在"}}),{status:409}))
  const error=await strategyTransfer.import(file,"tasks",false,{}).catch(e=>e)
  expect(error).toBeInstanceOf(TransferError)
  expect(error.symbols).toEqual(["btcusdt"])
})
