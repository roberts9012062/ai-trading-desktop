import assert from "node:assert/strict"
import test from "node:test"

import {
  formatDepthValue,
  presentField,
  priceSelectionIntent,
  isDepthDegraded,
} from "./market-depth-data.mjs"

test("missing market depth values render as a double dash", () => {
  assert.equal(formatDepthValue(null, "price", 2), "--")
  assert.equal(formatDepthValue(undefined, "lots", 0), "--")
})

test("prices preserve the contract decimal precision", () => {
  assert.equal(formatDepthValue(101.5, "price", 3), "101.500")
  assert.equal(formatDepthValue(2650, "price", 0), "2650")
})

test("lots and money use compact Chinese units", () => {
  assert.equal(formatDepthValue(879700, "lots", 0), "87.97万")
  assert.equal(formatDepthValue(23_188_000_000, "amount", 0), "231.88亿")
  assert.equal(formatDepthValue(-16038, "lots", 0), "-1.60万")
})

test("percentages include a percent sign", () => {
  assert.equal(formatDepthValue(3.08, "percent", 0), "3.08%")
})

test("estimated fields expose a separate estimate flag", () => {
  assert.deepEqual(
    presentField(
      { value: 120, source: "derived", quality: "estimated" },
      "lots",
      0,
    ),
    { text: "120", estimated: true },
  )
  assert.deepEqual(
    presentField(
      { value: null, source: "missing", quality: "missing" },
      "price",
      2,
    ),
    { text: "--", estimated: false },
  )
})

test("clicking ask or bid creates a manual limit-price intent", () => {
  assert.deepEqual(priceSelectionIntent("ask", 8501), {
    mode: "price",
    direction: "buy",
    price: 8501,
  })
  assert.deepEqual(priceSelectionIntent("bid", 8499), {
    mode: "price",
    direction: "sell",
    price: 8499,
  })
  assert.equal(priceSelectionIntent("ask", 0), null)
})

test("a fresh Sina fallback still reports SimNow degradation", () => {
  assert.equal(isDepthDegraded(false, true), true)
  assert.equal(isDepthDegraded(true, false), true)
  assert.equal(isDepthDegraded(false, false), false)
})
