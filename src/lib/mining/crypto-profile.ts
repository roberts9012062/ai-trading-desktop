/** Shared by both local mining entry points; saved with each new task. */
export const LOCAL_MINING_KERNEL_VERSION = "pykernel-factor-2026-09-26.1"
export const CRYPTO_RESEARCH_PROFILE = "crypto_ohlcv_v1"
export function isCryptoSymbol(symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase().split(":")[0]
    .replace(/-SWAP$/, "").replace(/[^A-Z0-9]/g, "")
  return normalized.endsWith("USDT") && normalized !== "USDT"
}

export const CRYPTO_RESEARCH_NOTE = "本地加密优化：365天年化、全天候时间与量价风险特征，自动排除无效特征。现货K线上的多空结果仅作信号研究，成本仍为静态手续费与滑点，未计借币和永续资金费率。"
