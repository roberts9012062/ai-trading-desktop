/** Opt-in public-data smoke test. No credentials, trading or LLM calls.
 * node scripts/test-okx-backup-live.mjs [--symbol ADAUSDT] [--day 2026-07-29]
 */
import {createRequire} from "node:module"
import {mkdir,writeFile} from "node:fs/promises"
import {resolve} from "node:path"
import {pathToFileURL} from "node:url"
import {indexedDB,IDBKeyRange} from "fake-indexeddb"
const require=createRequire(import.meta.resolve("vite")),{build}=require("esbuild")
const option=k=>{const i=process.argv.indexOf(k);return i>=0?process.argv[i+1]:undefined}
const symbol=option("--symbol")??"ADAUSDT",day=option("--day")??"2026-07-29"
const dir=resolve(".local-data/okx-backup-live");await mkdir(dir,{recursive:true})
await build({entryPoints:["src/lib/okx-history.ts"],outfile:resolve(dir,"history.mjs"),bundle:true,format:"esm",platform:"browser",target:"es2023",define:{"import.meta.env.DEV":"false","process.env.NEXT_PUBLIC_API_URL":"\"\""},tsconfig:"tsconfig.json"})
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange
const nativeFetch=globalThis.fetch,requests=[]
globalThis.fetch=async(url,init)=>{
  const u=String(url);if(!u.startsWith("https://"))throw new Error("Unexpected non-public request: "+u)
  requests.push(u)
  try { return await nativeFetch(url,init) }
  catch(e) { console.error("Public request failed:",u,e.cause?.code??e.message);throw e }
}
const h=await import(pathToFileURL(resolve(dir,"history.mjs")))
const start=h.okxArchiveDayStart(day),end=start+86400000-1,progress=msg=>console.log(msg)
const archive=await h.fetchOkxArchive("candles",symbol,day)
if(!archive)throw new Error("No reference official archive available")
const original=h.parseOkxCandles(h.archiveCsv(archive),symbol),original15=h.resampleOkxBars(original,"15m")
const backup=await h.fetchOkxHistoryRange(symbol,"1m",start,end,progress,{source:"rest"})
if(backup.length!==1440)throw new Error("REST day incomplete")
const byTime=new Map(backup.map(b=>[b.open_time,b]))
for(const bar of original) {
  const rest=byTime.get(bar.open_time)
  if(!rest||["open","high","low","close","volume","quote_volume"].some(k=>rest[k]!==bar[k]))throw new Error("Archive/REST conflict at "+bar.open_time)
}
const auto=await h.fetchOkxHistoryRange(symbol,"15m",start,end,progress,{source:"auto"})
if(auto.length!==96)throw new Error("Automatic backup did not produce complete 15m day")
const before=requests.filter(u=>u.includes("/api/v5/market/history-candles")).length
await h.fetchOkxHistoryRange(symbol,"15m",start,end,undefined,{source:"rest"})
if(requests.filter(u=>u.includes("/api/v5/market/history-candles")).length!==before)throw new Error("REST day cache missed")
const result={passed:true,symbol,day,official_archive_minutes:original.length,official_archive_15m:original15.length,backup_minutes:backup.length,automatic_15m:auto.length,missing_minutes:backup.filter(b=>!original.some(a=>a.open_time===b.open_time)).map(b=>b.open_time),overlap_fields_match:true,cache_reused:true,history_api_pages:before,origins:[...new Set(requests.map(u=>new URL(u).origin))]}
await writeFile(resolve(dir,"verification.json"),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
