/**
 * 桌面端更新状态(仅 Tauri 环境使用)
 *
 * 启动静默检查 / 手动检查把发现的新版本 Update 资源对象放到这里,
 * 侧边栏「检查更新」控件据渲染绿色版本角标,更新弹窗据其展示版本与更新内容。
 * Update 持有 Rust 侧资源(rid),替换时必须 close 旧对象释放;
 * 已下载的包挂在 Update.downloadedBytes 上,因此同版本重复检查时保留旧对象
 * (避免丢失已下载的安装包),只关闭新对象。
 */

import { create } from "zustand"
import type { Update } from "@tauri-apps/plugin-updater"

interface UpdateState {
  /** 检测到的新版本(null = 当前已是最新) */
  update: Update | null
  /** update 的安装包是否已下载完成(弹窗据此直接进入安装确认) */
  downloaded: boolean
  /** 登记新发现的更新;同版本且已下载时保留旧资源(下载成果不丢) */
  setAvailableUpdate: (update: Update | null) => void
  setDownloaded: (downloaded: boolean) => void
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  update: null,
  downloaded: false,
  setAvailableUpdate: (next) => {
    const prev = get().update
    if (prev && next && prev.version === next.version && get().downloaded) {
      void next.close().catch(() => {})
      return
    }
    if (prev) void prev.close().catch(() => {})
    set({ update: next, downloaded: false })
  },
  setDownloaded: (downloaded) => set({ downloaded }),
}))
