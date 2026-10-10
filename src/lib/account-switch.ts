import { useAuthStore } from "@/stores/auth"
import { stopAllRealtime } from "./realtime-factor/runtime"
import { validateAccount } from "./account-sessions"
import { accountServer, rememberAccount, type AccountSession } from "./account-profiles"

let switching = false
export async function switchAccount(saved: AccountSession): Promise<void> {
  if (switching) throw new Error("正在切换账号，请稍候")
  switching = true
  const origin = useAuthStore.getState().user?.id, server = accountServer()
  try {
    const target = await validateAccount(saved)
    if (origin !== useAuthStore.getState().user?.id || server !== accountServer()) throw new Error("当前会话已变化，请重新选择账号")
    // Validate capacity/storage before surrendering the current local execution lease.
    rememberAccount(target)
    await stopAllRealtime("切换账号，已恢复普通模式")
    if (origin !== useAuthStore.getState().user?.id || server !== accountServer()) throw new Error("当前会话已变化，请重新选择账号")
    const current = useAuthStore.getState()
    if (current.user && current.accessToken) rememberAccount({ user: current.user, accessToken: current.accessToken, refreshToken: localStorage.getItem("refresh_token") ?? "" })
    current.login(target.user,target.accessToken,target.refreshToken)
    // Full reload discards every store, queued callback, socket and mounted page.
    window.location.replace("/dashboard")
  } finally { switching = false }
}
