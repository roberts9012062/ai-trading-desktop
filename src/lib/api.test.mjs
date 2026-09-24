/**
 * api.ts 401 处理测试
 *
 * 重点验证：
 *  - 登录/注册等「获取凭证」端点 401（凭据错误）时，直接抛出后端错误，
 *    不刷新 token、不硬跳 /login（修复前会被整页踢回登录页）。
 *  - 普通受保护端点 401 且刷新失败时，仍保留跳 /login 的过期兜底（回归保护）。
 *
 * 由于 request() 未 export，这里通过已 export 的 loginApi / getMeApi 间接驱动。
 * 本文件本身为纯 JS（.mjs），通过 Node 22 原生 TS 支持直接 import ./api.ts。
 */

import assert from "node:assert/strict"
import test from "node:test"

// ---- mock 基础设施：localStorage / window.location ----
// request() 依赖 localStorage 取/写 token，401 兜底依赖 window.location.href 跳转。
const storage = new Map()

const localStorageMock = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
}

globalThis.localStorage = localStorageMock
globalThis.window = { location: { href: "" } }

// ---- fetch 路由 mock ----
// 按请求 URL 返回不同响应：登录、/me、refresh 各自独立。
let routeTable = []

function resetRoutes() {
  routeTable = []
}

function setRoute(match, respond) {
  routeTable.push({ match, respond })
}

globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.toString()
  for (const route of routeTable) {
    if (route.match.test(url)) {
      const { status, json } = route.respond()
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => json ?? {},
      }
    }
  }
  throw new Error(`[test] 未配置 fetch 路由: ${url}`)
}

function resetEnv() {
  storage.clear()
  resetRoutes()
  globalThis.window.location.href = ""
}

// ---- 用例 ----

test("loginApi: 401（密码错误）抛出后端错误且不跳转 /login", async () => {
  resetEnv()
  setRoute(/\/api\/auth\/login$/, () => ({
    status: 401,
    json: { detail: "用户名或密码错误" },
  }))

  const { loginApi } = await import("./api.ts")

  await assert.rejects(
    () => loginApi({ account: "admin", password: "wrong", trading_mode: "live" }),
    /用户名或密码错误/,
    "应抛出后端返回的错误文案",
  )

  // 关键断言：没有清掉 token、没有硬跳 /login
  assert.equal(globalThis.window.location.href, "", "不应触发 window.location 跳转")
  assert.equal(storage.has("access_token"), false, "不应清写 access_token")
})

test("loginApi: 非 401 错误（如 500）正常抛错不跳转", async () => {
  resetEnv()
  setRoute(/\/api\/auth\/login$/, () => ({
    status: 500,
    json: { detail: "服务器内部错误" },
  }))

  const { loginApi } = await import("./api.ts")

  await assert.rejects(
    () => loginApi({ account: "admin", password: "x", trading_mode: "live" }),
    /服务器内部错误/,
  )
  assert.equal(globalThis.window.location.href, "", "500 不应触发跳转")
})

test("getMeApi（受保护端点）: 401 且刷新失败时仍跳 /login（回归保护）", async () => {
  resetEnv()
  // /me 返回 401
  setRoute(/\/api\/auth\/me$/, () => ({ status: 401, json: { detail: "无效的认证凭据" } }))
  // refresh 也失败（无 refresh_token 时根本不会发 refresh 请求，这里兜底配置）
  setRoute(/\/api\/auth\/refresh$/, () => ({ status: 401, json: { detail: "refresh 失败" } }))

  const { getMeApi } = await import("./api.ts")

  await assert.rejects(
    () => getMeApi(),
    /认证过期/,
    "受保护端点刷新失败应抛出「认证过期」",
  )
  // 关键回归断言：普通端点的 401 兜底跳转逻辑必须保留
  assert.equal(
    globalThis.window.location.href,
    "/login",
    "受保护端点 401 刷新失败时仍应硬跳 /login",
  )
})

test("loginApi: 登录成功不抛错、不跳转", async () => {
  resetEnv()
  setRoute(/\/api\/auth\/login$/, () => ({
    status: 200,
    json: { access_token: "tok-abc", refresh_token: "ref-xyz" },
  }))

  const { loginApi } = await import("./api.ts")

  const res = await loginApi({ account: "admin", password: "ok", trading_mode: "live" })
  assert.equal(res.access_token, "tok-abc")
  assert.equal(globalThis.window.location.href, "", "登录成功不应跳转")
})
