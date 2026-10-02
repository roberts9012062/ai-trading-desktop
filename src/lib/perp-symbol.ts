/**
 * USDT 永续合约符号展示统一：`adausdt` → `ADA/USDT`。
 * 全站交易的都是 USDT 本位永续，用 币种/USDT 命名让用户一眼识别合约类型。
 */

export function perpSymbol(symbol: string | null | undefined): string {
  const s = String(symbol || "").trim().toLowerCase()
  if (!s) return "--"
  if (s.length > 4 && s.endsWith("usdt")) {
    return `${s.slice(0, -4).toUpperCase()}/USDT`
  }
  return s.toUpperCase()
}
