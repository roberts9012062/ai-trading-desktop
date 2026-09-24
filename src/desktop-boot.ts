/**
 * 桌面端(Tauri)启动前置 —— 必须是 main.tsx 的第一个 import。
 *
 * lib/api.ts 等 16 个模块在模块初始化阶段读取 API 基址(vite.config.ts 已把
 * process.env.NEXT_PUBLIC_* define 替换为 globalThis.__QH_*),本模块负责在
 * 所有业务模块求值之前把这些全局设置好。
 *
 * - 普通浏览器 dev(pnpm dev):window.__TAURI_INTERNALS__ 不存在,什么都不做,
 *   一切走同域相对路径 + vite proxy(与原 Next dev 的 rewrites 行为一致);
 * - Tauri(tauri dev / 打包后):注入 API/WS/SSE 三个基址,直连服务器。
 *
 * 服务器地址优先级:localStorage["atd_desktop_server"](用户覆盖)
 *   > VITE_DEFAULT_SERVER_BASE(构建注入) > 内置兜底(公网入口 b.00n.top)
 */

const DEFAULT_SERVER_BASE = "https://b.00n.top"

/** 历史默认值迁移:统一迁到公网入口 https://b.00n.top(WS 升级已实测可用) */
const LEGACY_SERVER_MIGRATIONS: Record<string, string> = {
  "http://143.47.108.63:3001": "https://b.00n.top",
  "http://143.47.108.63:8002": "https://b.00n.top",
}

export function resolveDesktopServerBase(): string {
  let override = ""
  try {
    override = localStorage.getItem("atd_desktop_server") ?? ""
    if (override && LEGACY_SERVER_MIGRATIONS[override]) {
      override = LEGACY_SERVER_MIGRATIONS[override]
      localStorage.setItem("atd_desktop_server", override)
    }
  } catch {
    // localStorage 不可用时静默回落默认值
  }
  const base =
    (override || import.meta.env.VITE_DEFAULT_SERVER_BASE || DEFAULT_SERVER_BASE).replace(
      /\/$/,
      "",
    )
  return base
}

async function boot(): Promise<void> {
  if (!window.__TAURI_INTERNALS__) {
    // 浏览器 dev(pnpm dev):显式置空,等价于原 frontend/.env.local 的
    // NEXT_PUBLIC_API_URL=""(同域相对路径 → vite proxy),并跳过 WS 覆盖
    window.__QH_API_BASE__ = ""
    window.__QH_WS_BASE__ = ""
    window.__QH_STREAM_BASE__ = ""
    return
  }

  const base = resolveDesktopServerBase()
  window.__QH_API_BASE__ = base
  window.__QH_WS_BASE__ = base.replace(/^http/i, "ws")
  window.__QH_STREAM_BASE__ = base

  // 用 Rust 侧 fetch 替换 webview fetch:后端 CORS 只放行 Web 端源
  // (localhost:3000/33/58),桌面端源是 http://tauri.localhost 会被预检 400
  // 拒绝("Failed to fetch")。plugin-http 在 Rust 进程内发请求,不受 CORS 约束,
  // 业务代码无需改动(仍调用全局 fetch)。WS 不受 CORS 限制,保持原生 WebSocket。
  //
  // 关键:必须保留原生 fetch 并放行 http://ipc.* —— Tauri 插件的 fetch-IPC
  // 传输通道内部也调用全局 fetch,若被一并替换成插件版会自递归,登录等
  // 带请求体的调用会永远挂起(实测卡"登录中...")。
  const originalFetch = window.fetch.bind(window)
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http")
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url.startsWith("http://ipc.")) {
      return originalFetch(input as RequestInfo, init)
    }
    return tauriFetch(input as Parameters<typeof tauriFetch>[0], init as Parameters<typeof tauriFetch>[1])
  }
}

await boot()
