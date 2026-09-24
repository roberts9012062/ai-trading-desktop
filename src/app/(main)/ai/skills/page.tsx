"use client"

import { useState, useEffect, useCallback } from "react"
import { Search, TrendingUp, Loader2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { SkillCard } from "@/components/ai/skills/skill-card"
import { SkillDetailModal } from "@/components/ai/skills/skill-detail-modal"
import { SkillConfigDialog } from "@/components/ai/skills/skill-config-dialog"
import { searchMarketplaceSkills, getMarketplaceLeaderboard, getMarketplaceSkillDetail } from "@/lib/api"
import type { MarketplaceSkillItem, MarketplaceSkillDetail } from "@/types"
import { showAlert } from "@/stores/dialog"
import Link from "next/link"

type Source = "skillsmp" | "github"

const SOURCE_LABELS: Record<Source, string> = {
  skillsmp: "Skillsmp",
  github: "GitHub",
}

/** Skills 商城主页面 */
export default function SkillsMarketplacePage(): React.JSX.Element {
  const [skills, setSkills] = useState<MarketplaceSkillItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [isSearch, setIsSearch] = useState(false)
  const [detailSkill, setDetailSkill] = useState<MarketplaceSkillDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [needsToken, setNeedsToken] = useState(false)
  const [source, setSource] = useState<Source>("skillsmp")

  const loadLeaderboard = useCallback(async (p: number, s: Source) => {
    setLoading(true)
    setNeedsToken(false)
    try {
      const items = await getMarketplaceLeaderboard(p, 20, s)
      setSkills(items)
    } catch (err) {
      if (err instanceof Error && (err as Error & { status?: number }).status === 403) {
        setNeedsToken(true)
      }
      setSkills([])
    } finally {
      setLoading(false)
    }
  }, [])

  const doSearch = useCallback(async (keyword: string, p: number, s: Source) => {
    if (!keyword.trim()) {
      setIsSearch(false)
      loadLeaderboard(p, s)
      return
    }
    setLoading(true)
    setIsSearch(true)
    setNeedsToken(false)
    try {
      const items = await searchMarketplaceSkills(keyword, p, 20, s)
      setSkills(items)
    } catch (err) {
      if (err instanceof Error && (err as Error & { status?: number }).status === 403) {
        setNeedsToken(true)
      }
      setSkills([])
    } finally {
      setLoading(false)
    }
  }, [loadLeaderboard])

  useEffect(() => {
    loadLeaderboard(1, source)
  }, [loadLeaderboard, source])

  function handleSearch(): void {
    setPage(1)
    doSearch(query, 1, source)
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Enter") handleSearch()
  }

  async function handleShowDetail(skillId: string): Promise<void> {
    try {
      const detail = await getMarketplaceSkillDetail(skillId, source)
      setDetailSkill(detail)
      setDetailOpen(true)
    } catch {
      await showAlert({ title: "提示", description: "获取详情失败" })
    }
  }

  function handleRefresh(): void {
    if (isSearch) {
      doSearch(query, page, source)
    } else {
      loadLeaderboard(page, source)
    }
  }

  function handleSourceChange(s: Source): void {
    setSource(s)
    setPage(1)
    setIsSearch(false)
    setQuery("")
  }

  return (
    <div className="flex flex-col h-full">
      {/* 页头 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
        <div>
          <h1 className="text-lg font-semibold">Skills 商城</h1>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">发现并安装社区 AI Skills，扩展 AI 能力</p>
        </div>
        <Link href="/ai/skills/installed">
          <Button variant="outline" size="sm">我的 Skills</Button>
        </Link>
        <SkillConfigDialog />
      </div>

      {/* 数据源切换 + 搜索栏 */}
      <div className="px-6 py-3 flex items-center gap-2 border-b border-[var(--border)]">
        {/* 商城切换 */}
        <div className="flex items-center bg-[var(--bg-primary)] rounded-md border border-[var(--border)] overflow-hidden">
          {(Object.keys(SOURCE_LABELS) as Source[]).map((s) => (
            <button
              key={s}
              onClick={() => handleSourceChange(s)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                source === s
                  ? "bg-[var(--primary)]/20 text-[var(--primary)] font-medium"
                  : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              }`}
            >
              {SOURCE_LABELS[s]}
            </button>
          ))}
        </div>

        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
          <Input
            placeholder="搜索 skills..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-9"
          />
        </div>
        <Button size="sm" onClick={handleSearch}>搜索</Button>
        {!isSearch && (
          <Button size="sm" variant="ghost" onClick={handleRefresh}>
            <TrendingUp className="w-4 h-4 mr-1" />
            排行榜
          </Button>
        )}
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          </div>
        ) : skills.length === 0 ? (
          <div className="text-center py-20 text-[var(--text-muted)]">
            {needsToken
              ? "API 需要认证，请点击右上角设置按钮配置 Token 后刷新页面"
              : isSearch
                ? "未找到相关 skills"
                : "商城暂无数据，试试切换数据源或搜索关键词"}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {skills.map((skill) => (
              <div key={skill.id} onClick={() => handleShowDetail(skill.id)} className="cursor-pointer">
                <SkillCard skill={skill} onInstalled={handleRefresh} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 分页 */}
      {skills.length > 0 && (
        <div className="flex items-center justify-center gap-2 px-6 py-3 border-t border-[var(--border)]">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => { const p = page - 1; setPage(p); isSearch ? doSearch(query, p, source) : loadLeaderboard(p, source); }}
          >
            上一页
          </Button>
          <span className="text-xs text-[var(--text-muted)]">第 {page} 页</span>
          <Button
            size="sm"
            variant="outline"
            disabled={skills.length < 20}
            onClick={() => { const p = page + 1; setPage(p); isSearch ? doSearch(query, p, source) : loadLeaderboard(p, source); }}
          >
            下一页
          </Button>
        </div>
      )}

      {/* 详情弹窗 */}
      <SkillDetailModal
        skill={detailSkill}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onInstalled={handleRefresh}
      />
    </div>
  )
}
