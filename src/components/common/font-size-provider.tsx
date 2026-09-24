"use client"

/**
 * 挂载时从 localStorage 恢复字号。
 * 首屏防闪：root layout 的 inline script 已先于 React 设置 data-font-size。
 */

import { useEffect } from "react"
import { useDisplayStore } from "@/stores/display"

/** 字号水合 Provider —— 放在任意 client 布局即可 */
export function FontSizeProvider(): null {
  const hydrate = useDisplayStore((s) => s.hydrate)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  return null
}
