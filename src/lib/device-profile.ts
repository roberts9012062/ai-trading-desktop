/**
 * 本机算力/内存画像 —— 研究数据量自适应的依据
 *
 * 背景:本地挖掘的 8 个分片 worker 各持全量 K 线副本(Python 化后单
 * worker 每万根 ≈ 40-60MB),数据量必须按本机内存分档——8G 机器拉
 * 26 万根会整页内存爆炸,64G 机器却能轻松跑。
 *
 * 探测:navigator.deviceMemory(Chrome 上限钳制在 8,无法区分 16/32/64G)
 * + hardwareConcurrency 作档位代理(消费级机器核数与内存档位强相关):
 *   low  ≤8G   (核 ≤8 或 deviceMemory <8)
 *   mid  16G±  (核 12-16)
 *   high 32G+  (核 ≥20,或 deviceMemory=8 且核 ≥16)
 * 静态导入环境(node 测试)默认 mid。探测一次后缓存。
 */

export type MemoryTier = "low" | "mid" | "high"

let cached: MemoryTier | null = null

export function memoryTier(): MemoryTier {
  if (cached) return cached
  if (typeof navigator === "undefined") return "mid"
  const nav = navigator as Navigator & { deviceMemory?: number }
  const dm = typeof nav.deviceMemory === "number" ? nav.deviceMemory : 4
  const cores = navigator.hardwareConcurrency ?? 4
  let tier: MemoryTier
  if (cores >= 20 || (dm >= 8 && cores >= 16)) tier = "high"
  else if (cores >= 12 || (dm >= 8 && cores >= 8)) tier = "mid"
  else tier = "low"
  cached = tier
  return tier
}

/** 研究用 K 线根数硬护栏(挖掘取数与超级因子快照共用)。
 *  按档位:low 10 万 / mid 20 万 / high 30 万——每档约为
 *  「本机可并行承载 8 worker 全量副本」的安全上界。 */
export function maxResearchBars(): number {
  switch (memoryTier()) {
    case "high":
      return 300_000
    case "mid":
      return 200_000
    default:
      return 100_000
  }
}

/** 档位中文说明(UI 展示用) */
export function memoryTierLabel(): string {
  switch (memoryTier()) {
    case "high":
      return "高配（32G+）"
    case "mid":
      return "中配（16G±）"
    default:
      return "轻配（≤8G）"
  }
}
