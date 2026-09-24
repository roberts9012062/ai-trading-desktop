/** 通用下载工具 —— fetch 认证接口并触发浏览器下载（仓库内首个导出先例） */

export async function downloadAuthenticatedFile(
  url: string,
  fallbackName = "export",
): Promise<void> {
  // 导出接口返回文件流，原生 fetch 带鉴权头（token key 与 api.ts 一致）
  const token =
    typeof window !== "undefined"
      ? window.localStorage.getItem("access_token")
      : null
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!res.ok) {
    throw new Error(`导出失败 HTTP ${res.status}`)
  }
  const disposition = res.headers.get("Content-Disposition") || ""
  const match = disposition.match(/filename="?([^";]+)"?/)
  const name = match?.[1] ?? fallbackName
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = objectUrl
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
}
