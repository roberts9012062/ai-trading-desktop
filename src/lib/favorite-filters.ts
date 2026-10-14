export interface FavoriteFilters {timeframe: string; minAnnual: string; maxAnnual: string}
export const EMPTY_FAVORITE_FILTERS: FavoriteFilters = {timeframe: "", minAnnual: "", maxAnnual: ""}
export function normalizeFavoriteTimeframe(value: unknown): string {
  return ({"1h": "60m", "4h": "240m", "60": "60m", "240": "240m"} as Record<string, string>)[String(value)] ?? String(value ?? "")
}
export function favoriteAnnualPercent(metrics: unknown): number | null {
  if (!metrics || typeof metrics !== "object") return null
  const m = metrics as Record<string, unknown>
  const value = m.ann_ret
  return typeof value === "number" && Number.isFinite(value) ? value * 100 : null
}
export function matchesFavoriteFilters(timeframe: unknown, annualPct: number | null, filters: FavoriteFilters): boolean {
  if (filters.timeframe && normalizeFavoriteTimeframe(timeframe) !== normalizeFavoriteTimeframe(filters.timeframe)) return false
  const min = filters.minAnnual.trim() ? Number(filters.minAnnual) : null
  const max = filters.maxAnnual.trim() ? Number(filters.maxAnnual) : null
  if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) return false
  if ((min !== null || max !== null) && (annualPct === null || !Number.isFinite(annualPct))) return false
  if (min !== null && annualPct! < min) return false
  if (max !== null && annualPct! > max) return false
  return true
}
