# AI Trading Desktop

加密货币交易系统（Decentralized Transactions）的 Windows 桌面客户端。工程骨架、打包与自动更新链路整体继承自 `qihuo-desktop`（Tauri 2 壳 + Vite SPA），业务前端从 DT 的 Next.js `frontend/` 移植，因子实验室 / 超级因子直接复用 qihuo-desktop 的桌面版（Pyodide 本地计算）。

## 技术栈（与 qihuo-desktop 同构）

- 壳：Tauri 2（Rust，`src-tauri/`，仅 http/process/updater/log 四插件）
- UI：React 19 + TypeScript + Vite 6 SPA + Tailwind CSS v4 + lightweight-charts v5 + Zustand
- 路由：react-router-dom v7（Next App Router 目录 → `src/router.tsx` 机械映射）
- 本地存储：IndexedDB（`src/lib/idb.ts` 单库 `ai-trading-desktop`，唯一版本升级点）
- 本地计算：Pyodide Worker（回测 / 因子 / 挖掘复用 Python 代码）
- 行情数据源（规划）：Binance 公开数据接口
  - 最新 K 线：`https://data-api.binance.vision/api/v3/klines`
  - Tick 成交：`https://data-api.binance.vision/api/v3/aggTrades`
  - 历史逐笔全量（zip 直链）：`https://data.binance.vision/data/spot/monthly/trades/...`

## 开发

```bash
pnpm install
pnpm dev          # 浏览器开发(走 vite proxy → 本机后端)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm build        # vite 生产构建
pnpm tauri dev    # 桌面壳开发(需 Rust 工具链)
pnpm tauri build  # 打包 Windows 安装包(nsis)
```

前置条件（Rust 工具链 / VS Build Tools / WebView2）与国内 NSIS 下载踩坑记录见 qihuo-desktop README。

## 自动更新链路（与 qihuo-desktop 同款）

- 插件：tauri-plugin-updater（minisign 签名，公钥在 `src-tauri/tauri.conf.json`，私钥 `证书/ai-trading-desktop-updater.key`，**永不入库，丢失即无法再发更新**）
- 发版：改 `src-tauri/tauri.conf.json` 的 version → commit → 打 tag `v{version}` → push
- CI（`.github/workflows/release.yml`）：签名构建 → GitHub Release（私有，exe + .sig）→ `latest.json`（api.github.com 资产 URL 版）→ secret gist 清单更新
- 客户端 endpoint：gist raw（国内 CDN 可达）→ 资产下载走 api.github.com + 内嵌只读 token
- 本地发版（不走 CI）：`UPDATE_TOKEN=<token> pnpm make-update "更新说明"`

## 目录结构

```
src/            前端 SPA(Next → Vite 迁移,shims 兼容 next/*)
src-tauri/      Tauri 壳(Rust)
scripts/        发版脚本(make-update / gh-release-finalize)与验证脚本
证书/           更新签名密钥(gitignored)
update-dist/    本地发版产物(gitignored)
```
