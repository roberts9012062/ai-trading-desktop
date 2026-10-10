/** Authenticated exports: native Save As on desktop, anchor downloads in browsers. */

export type DownloadResult = { status: "saved"; path: string } | { status: "cancelled" } | { status: "downloaded"; name: string }
const MAX_EXPORT_BYTES = 32 * 1024 * 1024

function exportUrl(url: string): string {
  const base = window.__QH_API_BASE__ || window.location?.origin
  if (!base) {
    if (url.startsWith("/") && !url.startsWith("//")) return url
    throw new Error("导出地址与当前服务器不一致")
  }
  const target = new URL(url, base)
  if (target.origin !== new URL(base).origin || target.username || target.password || !target.pathname.startsWith("/api/")) {
    throw new Error("导出地址与当前服务器不一致")
  }
  return target.href
}

function exportName(disposition: string, fallback: string): string {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  let name = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallback
  if (encoded) { try { name = decodeURIComponent(encoded.trim()) } catch { /* use plain filename */ } }
  return name.split(/[\\/]/).pop()?.replace(/[<>:"|?*\x00-\x1f]/g, "_").trim().slice(0, 160) || fallback
}

export async function downloadAuthenticatedFile(
  url: string,
  fallbackName = "export",
): Promise<DownloadResult> {
  // 导出接口返回文件流，原生 fetch 带鉴权头（token key 与 api.ts 一致）
  const token =
    typeof window !== "undefined"
      ? window.localStorage.getItem("access_token")
      : null
  const res = await fetch(exportUrl(url), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(60000), redirect: "error",
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { detail?: unknown }
    throw new Error(typeof detail.detail === "string" ? detail.detail : `导出失败 HTTP ${res.status}`)
  }
  if (res.headers.get("Content-Type")?.includes("text/html")) throw new Error("服务器未返回导出文件，请重新登录后重试")
  if (Number(res.headers.get("Content-Length")) > MAX_EXPORT_BYTES) throw new Error("导出文件超过 32 MB，请分批导出")
  const name = exportName(res.headers.get("Content-Disposition") || "", fallbackName)
  const blob = await res.blob()
  if (!blob.size) throw new Error("导出文件为空，请重试")
  if (blob.size > MAX_EXPORT_BYTES) throw new Error("导出文件超过 32 MB，请分批导出")
  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core")
    try {
      const path = await invoke<string | null>("desktop_save_export", { fileName: name, data: Array.from(new Uint8Array(await blob.arrayBuffer())) })
      return path ? { status: "saved", path } : { status: "cancelled" }
    } catch (error) { throw error instanceof Error ? error : new Error(String(error)) }
  }
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = objectUrl
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Download consumption is asynchronous; revoking immediately can cancel it.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000)
  return { status: "downloaded", name }
}
