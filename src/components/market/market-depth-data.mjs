function compact(value, divisor, suffix) {
  return `${(value / divisor).toFixed(2)}${suffix}`
}

export function formatDepthValue(value, kind, decimals = 0) {
  if (value === null || value === undefined || value === "") return "--"
  const number = Number(value)
  if (!Number.isFinite(number)) return "--"

  if (kind === "price") return number.toFixed(Math.max(0, decimals))
  if (kind === "percent") return `${number.toFixed(2)}%`
  if (kind === "amount") {
    if (Math.abs(number) >= 100_000_000) return compact(number, 100_000_000, "亿")
    if (Math.abs(number) >= 10_000) return compact(number, 10_000, "万")
    return number.toFixed(2)
  }
  if (kind === "lots") {
    if (Math.abs(number) >= 10_000) return compact(number, 10_000, "万")
    return Math.round(number).toString()
  }
  return number.toLocaleString("zh-CN", {
    maximumFractionDigits: Math.max(0, decimals),
  })
}

export function presentField(field, kind, decimals = 0) {
  return {
    text: formatDepthValue(field?.value, kind, decimals),
    estimated: field?.quality === "estimated" && field?.value !== null && field?.value !== undefined,
  }
}

export function priceSelectionIntent(side, price) {
  const number = Number(price)
  if ((side !== "ask" && side !== "bid") || !Number.isFinite(number) || number <= 0) {
    return null
  }
  return {
    mode: "price",
    direction: side === "ask" ? "buy" : "sell",
    price: number,
  }
}

export function isDepthDegraded(snapshotStale, simnowStale) {
  return Boolean(snapshotStale || simnowStale)
}
