export function nativeOrigin(metrics: unknown): string | null {
  if (!metrics || typeof metrics !== "object") return null
  const row = metrics as Record<string, unknown>
  return row.kernel_version === "native-gpu-v1" ? String(row.native_engine_version ?? "native-gpu-v1（版本未知）") : null
}
export function groupNativeOrigins<T extends { metrics?: unknown }>(items: T[]): Array<{ label: string | null; items: T[] }> {
  if (!items.some(row => nativeOrigin(row.metrics))) return [{ label: null, items }]
  const groups = new Map<string, T[]>()
  for (const row of items) {
    const key = nativeOrigin(row.metrics) ?? "CPU / WebGPU 口径"
    const group = groups.get(key) ?? []
    group.push(row); groups.set(key, group)
  }
  return [...groups].map(([label, rows]) => ({ label, items: rows }))
}
