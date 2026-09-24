"use client"

import { useState, useEffect, useCallback } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getNewsArticle } from "@/lib/api"
import { useMarketStore } from "@/stores/market"
import type { ArticleContent } from "@/types"

/** 新闻正文查看弹窗 */
export function NewsViewerDialog(): React.JSX.Element {
  const open = useMarketStore((s) => s.newsViewerOpen)
  const news = useMarketStore((s) => s.selectedNews)
  const onClose = useMarketStore((s) => s.closeNewsViewer)

  const [article, setArticle] = useState<ArticleContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const loadArticle = useCallback(async () => {
    if (!news?.url) return
    setLoading(true)
    setError(false)
    setArticle(null)
    try {
      const content = await getNewsArticle(news.url)
      setArticle(content)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [news?.url])

  useEffect(() => {
    if (open && news?.url) {
      loadArticle()
    }
    if (!open) {
      setArticle(null)
      setError(false)
    }
  }, [open, news?.url, loadArticle])

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-[640px] max-h-[80vh] flex flex-col bg-[var(--bg-secondary)] border-[var(--border)]">
        <DialogHeader>
          <DialogTitle className="text-base text-[var(--text-primary)] leading-snug">
            {news?.title ?? "新闻详情"}
          </DialogTitle>
          {(news?.source || news?.time) && (
            <p className="text-xs text-[var(--text-muted)] mt-1">
              {news.source} · {news.time}
            </p>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-auto min-h-0 mt-2">
          {loading && (
            <div className="flex items-center justify-center py-12 text-[var(--text-muted)] text-sm">
              加载中...
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-sm text-[var(--text-muted)]">加载失败，请稍后重试</p>
              <button
                onClick={loadArticle}
                className="text-xs text-[var(--accent-info)] hover:underline cursor-pointer"
              >
                重新加载
              </button>
            </div>
          )}

          {article && (
            <div className="text-sm text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap pb-4">
              {article.content}
            </div>
          )}
        </div>

        {news?.url && (
          <div className="pt-3 border-t border-[var(--border)] flex justify-end">
            <a
              href={news.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[var(--accent-info)] hover:underline"
            >
              查看原文
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
