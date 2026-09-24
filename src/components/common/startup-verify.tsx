"use client"

/**
 * 启动数据校验遮罩 —— 每次启动先对账修正 K 线数据
 *
 * 调用后端 POST /api/market/kline/verify-repair：近 3 天主力 × 全周期，
 * 以主 PG 权威数据对账 Redis 缓存（坏 bar 覆盖 / 缺根补齐），
 * 完成后再进入系统 —— 进入后图表拉到的即为修正后的数据。
 * 失败/超时不阻塞：降级放行并提示（数据仍有收盘后定时修正兜底）。
 */

import { useEffect, useRef, useState } from "react"
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  verifyRepairKlineApi,
  type KlineVerifyRepairResult,
} from "@/lib/api"
import { clearKlineCache } from "@/lib/kline-cache"

/** 客户端超时（毫秒）：后端全量对账通常秒级，留足余量 */
const VERIFY_TIMEOUT_MS = 60_000

type Phase = "running" | "done" | "skipped"

export function StartupVerify({
  onFinished,
}: {
  /** done/skipped 摘要展示完毕后由父级放行进入系统 */
  onFinished: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("running")
  const [stage, setStage] = useState<"verify" | "rebuilding">("verify")
  const [summary, setSummary] = useState<KlineVerifyRepairResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) {
        setError("校验超时，已跳过")
        setPhase("skipped")
      }
    }, VERIFY_TIMEOUT_MS)

    void (async () => {
      try {
        const res = await verifyRepairKlineApi()
        // 服务端对账完成后清空本地 K 线缓存：本地缓存可能残留旧口径/
        // 幽灵 bar（过滤虽然能剔除大部分，但彻底重建最可靠），进入后
        // 全部从服务端（已修正）重新拉取灌注
        setStage("rebuilding")
        await clearKlineCache()
        if (cancelled) return
        setSummary(res)
        setPhase("done")
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "校验失败")
        setPhase("skipped")
      } finally {
        clearTimeout(timer)
      }
    })()

    // 完成摘要展示 800ms 后放行；跳过场景 1.2s 后放行（读到提示即可）
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  // done/skipped 时短暂展示摘要后放行
  useEffect(() => {
    if (phase === "running") return
    const t = setTimeout(onFinished, phase === "done" ? 800 : 1200)
    return () => clearTimeout(t)
  }, [phase, onFinished])

  const done = phase !== "running"

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[var(--bg-primary)]">
      <div className="flex flex-col items-center gap-4 max-w-md px-8 text-center">
        {done ? (
          phase === "done" ? (
            <ShieldCheck className="w-12 h-12 text-emerald-400" />
          ) : (
            <TriangleAlert className="w-12 h-12 text-amber-400" />
          )
        ) : (
          <Loader2 className="w-12 h-12 text-sky-400 animate-spin" />
        )}

        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          {done
            ? phase === "done"
              ? "数据校验完成"
              : "数据校验已跳过"
            : stage === "rebuilding"
              ? "正在重建本地数据…"
              : "正在加载并验证数据、修正数据…"}
        </h2>

        <p
          className={cn(
            "text-xs leading-5",
            done
              ? phase === "done"
                ? "text-[var(--text-secondary)]"
                : "text-amber-400"
              : "text-[var(--text-muted)]",
          )}
        >
          {done
            ? phase === "done"
              ? summary?.message ??
                `已校验 ${summary?.checked ?? 0} 项，修正 ${summary?.repaired_bars ?? 0} 根`
              : error ?? "服务暂不可达，已直接进入系统"
            : stage === "rebuilding"
              ? "清除本地缓存，进入后从服务端重新拉取最新数据"
              : "以服务端 PG 权威数据（近 3 天）对账并修正 K 线缓存，完成后自动进入系统"}
        </p>

        {phase === "running" && (
          <div className="w-48 h-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
            <div className="h-full w-1/3 bg-sky-400/70 rounded-full animate-[startupverify_1.2s_ease-in-out_infinite]" />
          </div>
        )}
      </div>

      <style>{`
        @keyframes startupverify {
          0% { transform: translateX(-120%); }
          100% { transform: translateX(360%); }
        }
      `}</style>
    </div>
  )
}
