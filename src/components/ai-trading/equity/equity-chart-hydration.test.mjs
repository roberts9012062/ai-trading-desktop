import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const sourceUrl = new URL("./equity-chart.tsx", import.meta.url)

test("equity chart defers clock-derived session text until after hydration", async () => {
  const source = await readFile(sourceUrl, "utf8")

  assert.match(
    source,
    /const \[session, setSession\] = useState<TradeSessionRange \| null>\(null\)/,
    "the server and the first client render must share a null session",
  )
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setSession\(getTradeSessionRange\(Date\.now\(\), axisMode\)\)\s*\}, \[axisMode\]\)/,
    "the clock-derived session must be set after hydration",
  )
  assert.doesNotMatch(
    source,
    /const session = getTradeSessionRange\(Date\.now\(\), axisMode\)/,
    "rendering must not derive display text from Date.now()",
  )
})
