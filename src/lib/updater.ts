/**
 * 桌面端更新器 + 崩溃/错误上报(仅 Tauri 环境生效,浏览器 dev 为 no-op)
 *
 * 更新流程拆为三步,由更新弹窗(src/components/layout/update-dialog.tsx)驱动:
 *   checkForUpdate()  仅检查,返回 Update(含新版本号/更新说明)或 null
 *   downloadUpdate()  下载安装包,带进度回调
 *   installUpdate()   安装并重启
 * 启动静默检查(silentCheckForUpdate)只检测不安装:发现新版本时置入
 * 全局 store,侧边栏「检查更新」按钮渲染绿色版本角标提醒用户,由用户
 * 点击后走完整弹窗流程(签名公钥在 tauri.conf.json;私钥不入库)。
 * JS 全局错误/unhandled rejection → tauri-plugin-log 落盘
 * (日志文件:%APPDATA%/../com.aitrading.desktop/logs/ai-trading-desktop.log)
 */

import { checkChannel, type DesktopUpdate } from "@/lib/native-updater"
import { updateChannels, type UpdateChannel } from "@/lib/update-channels"
import { useUpdateStore } from "@/stores/update"

let errorReportingAttached = false

/** 用户的自定义 HTTP 传输代理；默认使用免费 GitHub 反向代理池。 */
const PROXY_KEY = "atd_update_proxy"

/**
 * 用户的 HTTP 传输代理，未指定时由免费反向代理池处理。
 * 存储三态:键不存在 → 免费池;存空串 → 直连;存 URL → 自定义优先。
 */
export function getUpdateProxy(): string | undefined {
  try {
    const v = localStorage.getItem(PROXY_KEY)
    if (v === null) return undefined
    return v === "" ? undefined : v
  } catch {
    return undefined
  }
}

/** 用户自存的代理原文(不回退内置值;null=未设置过,空串=旧版直连标记)。
 *  UI 只展示这个——内置默认代理的地址不在界面上显示。 */
export function getStoredUpdateProxy(): string | null {
  try {
    return localStorage.getItem(PROXY_KEY)
  } catch {
    return null
  }
}

/** 保存更新代理:传 undefined 恢复默认;传 "" 直连;传 URL 自定义 */
export function setUpdateProxy(value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(PROXY_KEY)
    else localStorage.setItem(PROXY_KEY, value)
  } catch {
    // 隐私模式等写失败时忽略
  }
}

/** 把 JS 错误落到 Rust 日志文件(幂等) */
export function attachErrorReporting(): void {
  if (errorReportingAttached || !window.__TAURI_INTERNALS__) return
  errorReportingAttached = true
  const report = (kind: string, message: string) => {
    void import("@tauri-apps/plugin-log")
      .then(({ error }) => error(`${kind}: ${message}`))
      .catch(() => {})
  }
  window.addEventListener("error", (ev) => {
    report(
      "JS_ERROR",
      `${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}${
        ev.error instanceof Error ? ` | ${ev.error.stack ?? ""}` : ""
      }`,
    )
  })
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason instanceof Error ? `${ev.reason.message} | ${ev.reason.stack ?? ""}` : String(ev.reason)
    report("UNHANDLED_REJECTION", reason)
  })
}

function logInfo(msg: string): void {
  void import("@tauri-apps/plugin-log")
    .then(({ info }) => info(`[updater] ${msg}`))
    .catch(() => {})
}

function logWarn(msg: string): void {
  void import("@tauri-apps/plugin-log")
    .then(({ warn }) => warn(`[updater] ${msg}`))
    .catch(() => {})
}

/** 每次请求使用独立通道，下载失败也会切换；不会提前安装。 */
function configuredChannels(): UpdateChannel[] {
  return getStoredUpdateProxy() === "" ? [{}] : updateChannels(getUpdateProxy())
}

async function findUpdate(channels: UpdateChannel[]): Promise<{ update: DesktopUpdate | null; index: number }> {
  let last: unknown
  for (let index = 0; index < channels.length; index++) {
    try {
      const update = await checkChannel(channels[index])
      return { update, index }
    } catch (error) {
      last = error
      logWarn(`更新通道 ${index + 1} 检查失败，自动尝试下一通道`)
    }
  }
  throw last ?? new Error("所有更新通道均不可用")
}

export async function checkForUpdate(): Promise<DesktopUpdate | null> {
  if (!window.__TAURI_INTERNALS__) return null
  const channels = configuredChannels()
  const found = await findUpdate(channels)
  if (!found.update) return null
  const original = found.update
  let active = original
  let closed = false
  logInfo(`发现新版本 ${original.version}`)
  return {
    ...original,
    download: async onEvent => {
      let last: unknown
      for (let index = found.index; index < channels.length; index++) {
        if (closed) throw new Error("更新资源已关闭")
        try {
          if (index !== found.index) {
            const next = await checkChannel(channels[index])
            if (!next) throw new Error("备用通道暂无更新")
            // A stale or inconsistent mirror must never replace the selected release.
            if (next.version !== original.version || JSON.stringify(next.rawJson.platforms) !== JSON.stringify(original.rawJson.platforms)) {
              await next.close()
              throw new Error("备用通道的更新版本或签名不一致")
            }
            active = next
          }
          onEvent?.({event: "Started", data: {}})
          await active.download(onEvent)
          return
        } catch (error) {
          last = error
          await active.close().catch(() => {})
          logWarn(`更新通道 ${index + 1} 下载失败，自动尝试下一通道`)
        }
      }
      throw last ?? new Error("所有下载通道均不可用")
    },
    install: () => active.install(),
    close: async () => { closed = true; await active.close() },
  }
}

/** 下载进度(contentLength=0 表示服务端未返回总大小) */
export interface DownloadProgress {
  downloaded: number
  contentLength: number
}

/** 下载更新安装包(代理沿用 check 时配置),onProgress 持续回调累计进度 */
export async function downloadUpdate(
  update: DesktopUpdate,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  let downloaded = 0
  let contentLength = 0
  await update.download(
    (event) => {
      switch (event.event) {
        case "Started":
          downloaded = 0
          contentLength = event.data.contentLength ?? 0
          onProgress?.({ downloaded, contentLength })
          break
        case "Progress":
          downloaded += event.data.chunkLength
          onProgress?.({ downloaded, contentLength })
          break
        case "Finished":
          onProgress?.({ downloaded: contentLength || downloaded, contentLength })
          break
      }
    },
  )
}

/** 安装已下载的更新并重启应用(NSIS passive 模式,安装后自动重启) */
export async function installUpdate(update: DesktopUpdate): Promise<void> {
  // 安装器为解锁目标文件会直接强杀主进程,窗口 Destroyed 的引擎清理路径
  // 因此不保证执行;若不先显式终结引擎,孤儿 python 进程会锁住
  // native-engine 下的 DLL,导致安装器写文件失败(反复弹 Retry 错误框)。
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("native_engine_kill")
    } catch {
      // 引擎本就未运行或已退出:忽略,继续安装
    }
  }
  await update.install()
  const { relaunch } = await import("@tauri-apps/plugin-process")
  await relaunch()
}

/**
 * 启动静默检查:仅检测新版本(不下载不安装),发现后置入全局 store,
 * 侧边栏按钮出现绿色版本角标提醒;一切失败只记日志,不打扰用户。
 */
export async function silentCheckForUpdate(): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return
  try {
    const update = await checkForUpdate()
    if (update) {
      const st = useUpdateStore.getState()
      // 已登记同版本则不替换(避免释放弹窗可能正在下载的资源),释放重复对象
      if (st.update && st.update.version === update.version) {
        void update.close().catch(() => {})
      } else {
        st.setAvailableUpdate(update)
      }
    }
  } catch (err) {
    logWarn(`启动更新检查失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}
