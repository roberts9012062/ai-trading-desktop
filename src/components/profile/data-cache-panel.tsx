"use client"

/**
 * 数据缓存面板(个人中心)——研究用 K 线深历史缓存的管理入口
 *
 * 缓存内容:超级因子/因子实验室/历史回测拉取的整段深历史 K 线
 * (按 渠道:币种:周期 分条,含资金费率等衍生字段)。清理后下次
 * 挖掘/回测会重新下载并再次缓存。
 */

import { useCallback, useEffect, useState } from "react"
import { Database, Trash2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  clearResearchKlines,
  researchKlineStats,
  type ResearchKlineStats,
} from "@/lib/research-kline-cache"

function fmtDate(ts: number | null): string {
  if (!ts) return "—"
  return new Date(ts).toLocaleString("zh-CN", { hour12: false })
}

export function DataCachePanel(): React.JSX.Element {
  const [stats, setStats] = useState<ResearchKlineStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [cleared, setCleared] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setStats(await researchKlineStats())
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleClear(): Promise<void> {
    setBusy(true)
    try {
      await clearResearchKlines()
      setCleared(true)
      setStats(await researchKlineStats())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Database className="w-4 h-4 text-[var(--text-secondary)]" />
        <span className="text-sm font-medium text-[var(--text-primary)]">历史数据缓存</span>
      </div>
      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        超级因子 / 因子实验室 / 历史回测拉取的 K 线深历史会保存在本机，下次挖掘同一币种时
        只增量拉取最新几天再与本地拼接，取数从分钟级降到秒级。缓存含资金费率等衍生字段，
        按渠道分条互不污染；尾部增量自带修订自愈（重叠一天重新拉取覆盖）。
      </p>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
          <div className="text-base font-num text-[var(--text-primary)]">{stats?.entries ?? "—"}</div>
          <div className="text-[10px] text-[var(--text-muted)]">币种条目</div>
        </div>
        <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
          <div className="text-base font-num text-[var(--text-primary)]">
            {stats ? stats.bars.toLocaleString() : "—"}
          </div>
          <div className="text-[10px] text-[var(--text-muted)]">K 线总数</div>
        </div>
        <div className="rounded-lg bg-[var(--bg-tertiary)] p-2">
          <div className="text-base font-num text-[var(--text-primary)]">{stats ? stats.approximateMB : "—"} MB</div>
          <div className="text-[10px] text-[var(--text-muted)]">占用(约)</div>
        </div>
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">
        最早缓存于 {fmtDate(stats?.oldestSavedAt ?? null)}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !stats?.entries}
          onClick={() => void refresh()}
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${busy ? "animate-spin" : ""}`} />
          刷新
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !stats?.entries}
          onClick={() => void handleClear()}
          className="text-red-400 border-red-500/30 hover:bg-red-500/10 disabled:opacity-40"
        >
          <Trash2 className="w-3.5 h-3.5 mr-1" />
          清理历史缓存
        </Button>
      </div>
      {cleared && (
        <p className="text-[11px] text-emerald-400">
          已清理。下次挖掘/回测将重新下载数据并再次缓存。
        </p>
      )}
    </div>
  )
}
