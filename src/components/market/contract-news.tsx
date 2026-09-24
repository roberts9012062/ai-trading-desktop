"use client"

import { useEffect, useCallback } from "react"
import { useAppStore } from "@/stores/app"
import { useMarketStore } from "@/stores/market"
import { getContractNews } from "@/lib/api"
import type { NewsItem } from "@/types"

/** 单条新闻行 */
function NewsRow({ news, onClick }: { news: NewsItem; onClick: () => void }): React.JSX.Element {
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-tertiary)] transition-colors border-b border-[var(--border)] last:border-b-0 cursor-pointer"
    >
      {news.importance === "high" && (
        <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] font-semibold">
          重要
        </span>
      )}
      {news.importance === "mid" && (
        <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]">
          关注
        </span>
      )}
      <span className="flex-1 text-xs text-[var(--text-primary)] truncate">
        {news.title}
      </span>
      <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{news.source}</span>
      <span className="shrink-0 text-[10px] text-[var(--text-muted)] font-num w-10 text-right">
        {news.time}
      </span>
    </div>
  )
}

/** 品种关联新闻列表组件 */
export function ContractNews(): React.JSX.Element {
  const activeContract = useAppStore((s) => s.activeContract)
  const contractNews = useMarketStore((s) =>
    activeContract ? s.contractNews[activeContract] : undefined
  )
  const setContractNews = useMarketStore((s) => s.setContractNews)
  const openNewsViewer = useMarketStore((s) => s.openNewsViewer)

  const loadNews = useCallback(async () => {
    if (!activeContract) return
    try {
      const news = await getContractNews(activeContract)
      setContractNews(activeContract, news)
    } catch {
      // API 不可用时保持上次数据
    }
  }, [activeContract, setContractNews])

  // 切换品种时加载 + 每 5 分钟自动刷新
  useEffect(() => {
    loadNews()
    const timer = setInterval(loadNews, 300_000)
    return () => clearInterval(timer)
  }, [loadNews])

  const newsList = contractNews ?? []

  if (newsList.length === 0) {
    return (
      <div className="flex items-center justify-center h-[200px] text-[var(--text-muted)] text-xs">
        暂无相关新闻
      </div>
    )
  }

  return (
    <div className="overflow-auto max-h-[272px]">
      {newsList.map((news, i) => (
        <NewsRow
          key={`${news.time}-${i}`}
          news={news}
          onClick={() => openNewsViewer(news)}
        />
      ))}
    </div>
  )
}
