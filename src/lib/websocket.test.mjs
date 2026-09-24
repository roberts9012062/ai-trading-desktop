import assert from "node:assert/strict"
import test from "node:test"

import * as websocketModule from "./websocket.ts"

test("public deployment fallback uses the 3051 WebSocket proxy", () => {
  assert.equal(typeof websocketModule.resolveWsBase, "function")
  assert.equal(
    websocketModule.resolveWsBase(
      { protocol: "https:", hostname: "uusb.eu.org" },
      "",
    ),
    "wss://uusb.eu.org:3051",
  )
})

test("内网/测试环境按 hostname 直连本地 backend，忽略构建时注入的公网地址", () => {
  // hostname 判定优先：即使 NEXT_PUBLIC_WS_URL 残留 uusb:3051，内网 IP 也连本地 8002
  assert.equal(
    websocketModule.resolveWsBase(
      { protocol: "http:", hostname: "192.168.6.33" },
      "wss://uusb.eu.org:3051",
    ),
    "ws://192.168.6.33:8002",
  )
})
