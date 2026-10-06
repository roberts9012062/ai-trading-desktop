import type { Update, DownloadEvent } from "@tauri-apps/plugin-updater"
import type { UpdateChannel } from "./update-channels"
import { manifestEndpoint } from "./update-channels"

export type DesktopUpdate = Pick<Update, "currentVersion" | "version" | "body" | "date" | "rawJson" | "download" | "install" | "close">
interface Metadata { rid: number; currentVersion: string; version: string; body?: string; date?: string; rawJson: Record<string, unknown> }

/** Rust uses the official updater for signature verification and installation. */
export async function checkChannel(channel: UpdateChannel): Promise<DesktopUpdate | null> {
  const { invoke, Channel } = await import("@tauri-apps/api/core")
  const metadata = await invoke<Metadata | null>("update_channel_check", {
    endpoint: manifestEndpoint(channel), mirror: channel.mirror ?? null, proxy: channel.proxy ?? null,
  })
  if (!metadata) return null
  return {
    ...metadata,
    download: async onEvent => {
      const progress = new Channel<DownloadEvent>()
      progress.onmessage = event => onEvent?.(event)
      await invoke("update_channel_download", { rid: metadata.rid, progress })
    },
    install: () => invoke("update_channel_install", { rid: metadata.rid }),
    close: () => invoke("update_channel_close", { rid: metadata.rid }),
  }
}
