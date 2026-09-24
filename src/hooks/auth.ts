"use client"

import { useEffect } from "react"
import { useRouter, usePathname } from "next/navigation"
import { useAuthStore } from "@/stores/auth"
import { getMeApi } from "@/lib/api"

/** 需要认证才能访问的路径前缀 */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/market",
  "/trading",
  "/positions",
  "/orders",
  "/assets",
  "/history",
  "/profile",
  "/messages",
  "/admin",
  "/ai-trading",
  "/ai-settings",
  "/ai",
  "/backtest",
]

/** 无需认证的路径 */
const PUBLIC_PATHS = ["/login", "/register", "/"]

/**
 * 鉴权 + 会话恢复
 * 有 token 但内存/缓存用户缺失时，自动拉 /api/auth/me，避免刷新后角色丢失
 */
export function useAuthGuard(): void {
  const router = useRouter()
  const pathname = usePathname()
  const accessToken = useAuthStore((s) => s.accessToken)
  const user = useAuthStore((s) => s.user)
  const loaded = useAuthStore((s) => s.loaded)
  const hydrating = useAuthStore((s) => s.hydrating)
  const login = useAuthStore((s) => s.login)
  const logout = useAuthStore((s) => s.logout)
  const setLoaded = useAuthStore((s) => s.setLoaded)
  const setHydrating = useAuthStore((s) => s.setHydrating)

  // 会话恢复：token 在、需要确认用户时拉 /me
  useEffect(() => {
    let cancelled = false

    async function hydrate(): Promise<void> {
      const token =
        accessToken ??
        (typeof window !== "undefined"
          ? localStorage.getItem("access_token")
          : null)

      if (!token) {
        if (!cancelled) {
          setLoaded(true)
          setHydrating(false)
        }
        return
      }

      // 已有用户且已 loaded：仍周期性不强制；首次进入必须校验一次
      if (user && loaded) {
        return
      }

      if (hydrating) return
      setHydrating(true)
      try {
        const me = await getMeApi()
        if (cancelled) return
        const refresh =
          typeof window !== "undefined"
            ? (localStorage.getItem("refresh_token") ?? "")
            : ""
        login(me, token, refresh)
      } catch {
        if (cancelled) return
        // token 无效
        logout()
      } finally {
        if (!cancelled) {
          setHydrating(false)
          setLoaded(true)
        }
      }
    }

    void hydrate()
    return () => {
      cancelled = true
    }
  }, [
    accessToken,
    user,
    loaded,
    hydrating,
    login,
    logout,
    setLoaded,
    setHydrating,
  ])

  // 路由守卫
  useEffect(() => {
    if (!loaded) return

    const isProtected = PROTECTED_PREFIXES.some((prefix) =>
      pathname.startsWith(prefix),
    )
    const isPublic = PUBLIC_PATHS.includes(pathname)

    if (isProtected && !accessToken) {
      router.replace("/login")
      return
    }
    if (isPublic && pathname === "/" && accessToken) {
      router.replace("/dashboard")
    }
  }, [pathname, accessToken, loaded, router])
}
