import { useEffect } from "react"
import { useAuthStore } from "@/stores/auth"
import { useHunterStore } from "@/stores/hunter"
import { startHunterRuntime } from "@/lib/hunter/scanner"

export function HunterRuntime(): null {
  const userId = useAuthStore(s => s.user?.id)
  const mode = useAuthStore(s => s.user?.trading_mode)
  const token = useAuthStore(s => s.accessToken)
  const isAdmin = useAuthStore(s => s.user?.role === "admin")
  useEffect(() => {
    useHunterStore.getState().reset()
    if (!userId || !token || !isAdmin) return
    return startHunterRuntime()
  }, [userId, mode, token, isAdmin])
  return null
}
