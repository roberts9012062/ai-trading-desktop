import { downloadAuthenticatedFile } from "./download"

export type TransferKind = "task" | "factor" | "shortline"
export interface StrategyFile {
  format: "cyclepilot-strategies"; version: 1; exported_at?: string | null
  items: { kind: TransferKind; encoding: "server-v3" | "desktop-shortline-v1"; config: Record<string, unknown>; folder?: string | null; note?: string | null; model?: { display_name: string; model_id: string; api_type: string } | null }[]
}
export interface TransferPreview {
  models: { id: string; display_name: string; model_id: string; api_type: string }[]
  items: { index: number; kind: TransferKind; name: string; symbol: string | null; timeframe: string | null; category: string; folder: string; conflict: boolean; requires_model: boolean; model_row_id: string | null }[]
}
export class TransferError extends Error {
  constructor(message: string, public symbols: string[] = []) { super(message) }
}
const base = () => (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "") + "/api/strategy-transfer"

async function request<T>(path: string, body: unknown): Promise<T> {
  const token = localStorage.getItem("access_token")
  if (!token) throw new Error("请先登录")
  const response = await fetch(base() + path, { method: "POST", signal: AbortSignal.timeout(60000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { detail?: string | { code?: string; symbols?: string[]; message?: string } | { msg?: string }[] }
    const detail = result.detail
    if (detail && typeof detail === "object" && !Array.isArray(detail) && detail.code === "symbol_conflict") throw new TransferError(detail.message ?? "相同币种已存在", detail.symbols ?? [])
    throw new Error(typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map(d => d.msg ?? "参数无效").join("；") : `导入失败（${response.status}）`)
  }
  return response.json() as Promise<T>
}

export function parseStrategyFile(text: string): StrategyFile {
  if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) throw new Error("文件超过 10 MB，请分批导入")
  let value: unknown
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")) } catch { throw new Error("无法读取 JSON 文件，请选择导出的配置文件") }
  const file = value as Partial<StrategyFile> | null
  if (!file || file.format !== "cyclepilot-strategies" || file.version !== 1 || !Array.isArray(file.items) || !file.items.length || file.items.length > 500) throw new Error("文件格式或版本不受支持，请使用周期领航导出的配置文件")
  if (file.items.some(i => !i || !["task", "factor", "shortline"].includes(i.kind) || i.encoding !== (i.kind === "shortline" ? "desktop-shortline-v1" : "server-v3") || !i.config || typeof i.config !== "object" || Array.isArray(i.config))) throw new Error("文件分类或公式编码无效，请重新导出")
  return file as StrategyFile
}

export function missingTransferModels(file: StrategyFile, preview: TransferPreview, models: Record<string, string>): boolean {
  return preview.items.some(i => i.kind === "task" && i.requires_model && !models[String(i.index)])
}

export const strategyTransfer = {
  preview: (file: StrategyFile) => request<TransferPreview>("/preview", file),
  import: (file: StrategyFile, destination: "tasks" | "favorites", auto_start: boolean, models: Record<string, string>) => request<{ imported: number; duplicates: number; items: { kind: TransferKind; id: string; status?: string; created?: boolean }[] }>("/import", { file, destination, auto_start: destination === "tasks" && auto_start, models }),
  exportTask: (id: string) => downloadAuthenticatedFile(base() + `/tasks/${encodeURIComponent(id)}/export`, "cyclepilot-task.json"),
  exportFavorites: (kind: TransferKind | "all", id?: string) => downloadAuthenticatedFile(base() + `/favorites/export?kind=${kind}${id ? `&favorite_id=${encodeURIComponent(id)}` : ""}`, `cyclepilot-${kind}-favorites.json`),
}
