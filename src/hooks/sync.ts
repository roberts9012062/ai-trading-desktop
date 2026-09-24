"use client"

import { useEffect, useRef } from "react"
import { useAppStore } from "@/stores/app"

/** 多标签页状态同步 Hook（BroadcastChannel API） */
export function useTabSync(): void {
  const channelRef = useRef<BroadcastChannel | null>(null)
  const { setActiveContract } = useAppStore()

  useEffect(() => {
    const channel = new BroadcastChannel("qihuo-sync")
    channelRef.current = channel

    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; payload: unknown }

      switch (data.type) {
        case "active-contract": {
          const code = data.payload as string
          setActiveContract(code)
          break
        }
        default:
          break
      }
    }

    return () => {
      channel.close()
      channelRef.current = null
    }
  }, [setActiveContract])
}

/** 广播合约变更到其他标签页 */
export function broadcastContractChange(code: string): void {
  const channel = new BroadcastChannel("qihuo-sync")
  channel.postMessage({ type: "active-contract", payload: code })
  channel.close()
}
