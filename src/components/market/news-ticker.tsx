"use client"

import { useEffect, useCallback, useRef } from "react"
import { useMarketStore } from "@/stores/market"
import { getLatestNews } from "@/lib/api"

/** 顶部滚动新闻条 - 28px 高，CSS 动画从右向左滚动 */
export function NewsTicker(): React.JSX.Element {
  const latestNews = useMarketStore((s) => s.latestNews)
  const setLatestNews = useMarketStore((s) => s.setLatestNews)
  const openNewsViewer = useMarketStore((s) => s.openNewsViewer)
  const tickerRef = useRef<HTMLDivElement>(null)

  const loadNews = useCallback(async () => {
    try {
      const news = await getLatestNews()
      setLatestNews(news)
    } catch {
      // API 不可用时保持上次数据
    }
  }, [setLatestNews])

  useEffect(() => {
    loadNews()
    // 每 5 分钟自动刷新
    const timer = setInterval(loadNews, 300_000)
    return () => clearInterval(timer)
  }, [loadNews])

  if (latestNews.length === 0) {
    return (
      <div className="h-7 flex items-center px-3 bg-[var(--bg-secondary)] border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
        暂无最新新闻
      </div>
    )
  }

  return (
    <div
      ref={tickerRef}
      className="h-7 flex items-center overflow-hidden bg-[var(--bg-secondary)] border-b border-[var(--border)] group"
    >
      <div className="shrink-0 px-2 text-xs font-medium text-[var(--accent-info)] bg-[var(--bg-tertiary)] h-full flex items-center">
        新闻
      </div>
      <div className="flex-1 overflow-hidden relative">
        <div
          className="whitespace-nowrap text-xs text-[var(--text-secondary)] animate-news-ticker group-hover:[animation-play-state:paused]"
          style={{ animationDuration: `${Math.max(20, latestNews.length * 4)}s` }}
        >
          {latestNews.slice(0, 10).map((news, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 hover:text-[var(--primary)] transition-colors cursor-pointer"
              onClick={() => openNewsViewer(news)}
            >
              <span className="text-[var(--text-muted)]">{news.time}</span>
              <span>{news.title}</span>
              {i < latestNews.length - 1 && (
                <span className="text-[var(--text-muted)] mx-2">|</span>
              )}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
