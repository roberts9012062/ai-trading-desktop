import { fileURLToPath, URL as FsURL } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

/// <reference types="vitest/config" />

// 浏览器 dev 模式的后端反代目标(与 frontend/.env.local 的 BACKEND_URL 对应)
const DEV_BACKEND = process.env.VITE_DEV_BACKEND ?? "http://127.0.0.1:8002"

/**
 * Next.js → Vite 迁移要点:
 * 1. next/link / next/image / next/navigation 通过别名替换为 src/shims 下的
 *    react-router 实现,业务源码零改动;
 * 2. 源码里的 process.env.NEXT_PUBLIC_* 用 define 替换为运行时全局,
 *    这些全局由 src/desktop-boot.ts 在 Tauri 环境下注入(见 main.tsx 首行 import);
 * 3. dev 模式沿用同域相对路径 + vite proxy,行为与 Next rewrites 一致。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new FsURL("./src", import.meta.url)),
      "next/link": fileURLToPath(new FsURL("./src/shims/next-link.tsx", import.meta.url)),
      "next/image": fileURLToPath(new FsURL("./src/shims/next-image.tsx", import.meta.url)),
      "next/navigation": fileURLToPath(new FsURL("./src/shims/next-navigation.ts", import.meta.url)),
    },
  },
  // define 值只能是实体名/字面量;源码里 token 后均自带 ?? / ?. 兜底,这里替换为裸实体名即可
  define: {
    "process.env.NEXT_PUBLIC_API_URL": "globalThis.__QH_API_BASE__",
    "process.env.NEXT_PUBLIC_WS_URL": "globalThis.__QH_WS_BASE__",
    "process.env.NEXT_PUBLIC_STREAM_URL": "globalThis.__QH_STREAM_BASE__",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 与 next.config.ts rewrites 对齐;timeout 放开以覆盖 factor-lab 的长耗时请求
      // (原先由 Next Route Handler 承担的 5 分钟超时代理,这里由 vite proxy 直接承担)
      "/api": {
        target: DEV_BACKEND,
        changeOrigin: true,
        timeout: 300000,
      },
      "/ws": {
        target: DEV_BACKEND,
        changeOrigin: true,
        ws: true,
      },
      // vision 归档域无 CORS 头:dev/preview 浏览器经同源代理访问
      // (桌面端不受影响——desktop-boot 已把 fetch 换成 plugin-http)
      "/__vision__": {
        target: "https://data.binance.vision",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__vision__/, ""),
      },
      // Browser preview only, on this PC. Packaged Tauri downloads directly.
      "/__okx_archive__": {
        target: "https://dfccd2aelcoyz.cloudfront.net",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__okx_archive__/, ""),
      },
      "/__okx_static__": {
        target: "https://static.okx.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__okx_static__/, ""),
      },
    },
  },
  build: {
    // es2022 支持 top-level await(desktop-boot 的 fetch 补丁);WebView2 为常青 Chromium
    target: "es2022",
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // 只收集 .ts 测试;frontend 拷来的 *.test.mjs 是 node 独立脚本,非 vitest 套件
    include: ["src/**/*.test.ts"],
  },
})
