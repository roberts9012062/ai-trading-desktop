"use client"

import { useEffect } from "react"
import { useRouter, usePathname } from "next/navigation"
import { useAppStore } from "@/stores/app"

/** 菜单项对应的路由和快捷键映射 */
const MENU_ROUTES: Record<string, string> = {
  "1": "/dashboard",
  "2": "/market",
  "3": "/trading",
  "4": "/positions",
  "5": "/orders",
  "6": "/assets",
  "7": "/history",
  "8": "/profile",
  "9": "/messages",
}

/** 全局快捷键 Hook */
export function useKeyboardShortcuts(): void {
  const router = useRouter()
  const pathname = usePathname()
  const { setSearchOpen, setActiveContract } = useAppStore()

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      // 输入框内屏蔽快捷键
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return
      }
      if ((e.target as HTMLElement).isContentEditable) {
        return
      }

      // ESC 关闭弹窗
      if (e.key === "Escape") {
        setSearchOpen(false)
        return
      }

      // Ctrl+K 打开合约搜索
      if (e.ctrlKey && e.key === "k") {
        e.preventDefault()
        setSearchOpen(true)
        return
      }

      // Ctrl+B 买多 - 导航到交易页
      if (e.ctrlKey && e.key === "b") {
        e.preventDefault()
        if (pathname !== "/trading") router.push("/trading")
        return
      }

      // Ctrl+S 卖空 - 导航到交易页
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault()
        if (pathname !== "/trading") router.push("/trading")
        return
      }

      // Ctrl+D 全撤委托（仅通知，实际功能后续实现）
      if (e.ctrlKey && e.key === "d") {
        e.preventDefault()
        return
      }

      // F1-F4 K线周期切换
      if (e.key === "F1" || e.key === "F2" || e.key === "F3" || e.key === "F4") {
        e.preventDefault()
        return
      }

      // 1-9 切换菜单页
      if (MENU_ROUTES[e.key] && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const target = MENU_ROUTES[e.key]
        if (pathname !== target) {
          router.push(target)
        }
        return
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [router, pathname, setSearchOpen, setActiveContract])
}
