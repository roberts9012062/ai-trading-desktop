import {createRoot} from "react-dom/client"
import "../src/app/globals.css"
import ShortlineLabPageV2 from "@/components/shortline-lab/shortline-lab-page-v2"
import {saveDayDigest} from "@/lib/shortline/backfill/pipeline"
import {okxArchiveDayStart} from "@/lib/okx-history"
if (location.hostname !== "127.0.0.1" || location.port !== "5187") throw new Error("只允许本机隔离验收")
globalThis.fetch = async () => {throw new Error("隔离页面禁止网络和交易")}
const day = "2026-09-28", ts = okxArchiveDayStart(day)/1000
const bucket = {ts,open:100,high:100,low:100,close:100,vol:1,quote:100,takerBuyVol:1,takerBuyQuote:100,count:1}
await saveDayDigest("ETHUSDT",day,[bucket],"okx")
await saveDayDigest("ETHUSDT",day,[bucket])
await saveDayDigest("ETHUSDT","2026-09-29",[{...bucket,ts:ts+86400}])
createRoot(document.getElementById("root")!).render(<ShortlineLabPageV2/> )
