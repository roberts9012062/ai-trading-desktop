/**
 * 合约代码 → 中文名映射缓存
 *
 * 语音播报与预警弹窗需要展示品种名（如「甲醇2609」而非「ma2609」）。
 * 懒加载合约列表并构建小写 symbol → name 映射；映射缺失时回退到代码本身。
 */

import { getContractsApi } from "@/lib/api"

const _nameMap = new Map<string, string>()
let _loaded = false
let _loading: Promise<void> | null = null

/** 异步加载合约列表构建映射（幂等，并发安全） */
export function ensureContractNames(): Promise<void> {
  if (_loaded) return Promise.resolve()
  if (_loading) return _loading
  if (typeof window === "undefined") return Promise.resolve()
  _loading = (async () => {
    try {
      const data = await getContractsApi()
      for (const c of data) {
        if (c.symbol && c.name) {
          _nameMap.set(c.symbol.toLowerCase(), c.name)
        }
      }
      _loaded = true
    } catch {
      // 失败不阻断：回退用代码
    } finally {
      _loading = null
    }
  })()
  return _loading
}

/** 同步取品种名；映射未就绪时回退到代码（大写） */
export function contractName(symbol: string): string {
  const key = String(symbol || "").trim().toLowerCase()
  if (!key) return ""
  return _nameMap.get(key) ?? symbol.toUpperCase()
}
