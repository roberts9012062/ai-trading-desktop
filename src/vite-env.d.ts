/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Tauri 打包默认连接的服务器基址(见 .env.production),运行时可用 localStorage["qh_desktop_server"] 覆盖 */
  readonly VITE_DEFAULT_SERVER_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** desktop-boot 注入的运行时全局(vite.config.ts define 把 process.env.NEXT_PUBLIC_* 替换到这里) */
declare global {
  interface Window {
    /** Tauri 注入(页面任何脚本执行前存在),用于区分浏览器 dev 与桌面端 */
    __TAURI_INTERNALS__?: unknown
    __QH_API_BASE__?: string
    __QH_WS_BASE__?: string
    __QH_STREAM_BASE__?: string
  }
}

export {}
