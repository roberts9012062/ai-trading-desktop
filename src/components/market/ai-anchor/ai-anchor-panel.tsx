"use client";

/**
 * AI 看盘主页面板 —— 行情页右栏「AI主播」tab 内容
 *
 * 任务本体常驻后端：本面板只负责渲染；挂载拉状态，60s 兜底轮询，
 * 运行期增量更新来自 WS anchor_broadcast（跳页/关页不影响播报）。
 */

import { useEffect } from "react"
import { useAiAnchorStore } from "@/stores/ai-anchor"
import { AnchorConfigForm } from "./anchor-config-form"
import { AnchorRunningView } from "./anchor-running-view"

export function AiAnchorPanel(): React.JSX.Element {
  const task = useAiAnchorStore((s) => s.task)
  const loading = useAiAnchorStore((s) => s.loading)
  const fetchStatus = useAiAnchorStore((s) => s.fetchStatus)
  const fetchIndicatorSchema = useAiAnchorStore((s) => s.fetchIndicatorSchema)

  useEffect(() => {
    void fetchStatus()
    void fetchIndicatorSchema()
  }, [fetchStatus, fetchIndicatorSchema])

  // WS 兜底轮询：错过推送（重连间隙/多端）时校正状态与列表
  useEffect(() => {
    const timer = setInterval(() => void fetchStatus(), 60_000)
    return () => clearInterval(timer)
  }, [fetchStatus])

  if (loading && !task) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">
        加载中…
      </div>
    )
  }

  // 从未创建或已停止 → 配置表单；running/paused → 运行视图
  if (!task || task.status === "stopped") {
    return <AnchorConfigForm />
  }
  return <AnchorRunningView />
}
