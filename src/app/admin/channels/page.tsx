"use client"

/**
 * 交易所行情源 —— OKX / Binance(币安) / Gate(芝麻开门) 三所对等
 *
 * 主所单请求拉全量行情，主所失败自动按健康度切备所容灾；
 * 此页切换主所 + 展示三所健康度。
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  getVenuesApi,
  updateActiveVenueApi,
  type VenuesStatusResponse,
} from "@/lib/admin-api"

export default function AdminChannelsPage(): React.JSX.Element {
  const [data, setData] = useState<VenuesStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [switching, setSwitching] = useState("")
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      setData(await getVenuesApi())
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15_000)
    return () => clearInterval(timer)
  }, [load])

  const switchVenue = async (venue: string) => {
    if (venue === data?.active) return
    setSwitching(venue)
    setError("")
    setMessage("")
    try {
      await updateActiveVenueApi(venue)
      setMessage(`主交易所已切换为 ${venue.toUpperCase()}，立即生效`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "切换失败")
    } finally {
      setSwitching("")
    }
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">交易所行情源</h1>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            三所对等 · 主所拉全量行情 · 故障自动容灾切换备所（无需手动干预）
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          刷新
        </Button>
      </div>

      {message && (
        <div className="text-xs rounded px-3 py-2 bg-[var(--accent-up)]/10 text-[var(--accent-up)]">{message}</div>
      )}
      {error && (
        <div className="text-xs rounded px-3 py-2 bg-[var(--accent-danger)]/10 text-[var(--accent-danger)]">{error}</div>
      )}

      {data && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">当前主所：{data.active.toUpperCase()}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-[var(--text-muted)]">
              其余两所作为容灾备份；主所请求失败时自动按健康度排序切换。
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-3">
            {data.venues.map((v) => (
              <Card key={v.venue} className={cn(v.active && "border-[var(--primary)]")}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    {v.name}
                    {v.active && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--primary)]/15 text-[var(--primary)]">
                        主所
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full",
                        v.ok ? "bg-[var(--accent-up)]" : v.fail > 0 ? "bg-[var(--accent-danger)]" : "bg-[var(--text-muted)]",
                      )}
                    />
                    {v.ok ? "正常" : v.fail > 0 ? `连续失败 ${v.fail} 次` : "暂无数据"}
                  </div>
                  {v.last_error && (
                    <p className="text-[10px] text-[var(--text-muted)] break-all">{v.last_error}</p>
                  )}
                  <Button
                    size="sm"
                    variant={v.active ? "outline" : "default"}
                    className="h-7 text-xs w-full"
                    disabled={v.active || switching !== ""}
                    onClick={() => void switchVenue(v.venue)}
                  >
                    {switching === v.venue && <Loader2 className="w-3 h-3 animate-spin" />}
                    {v.active ? "当前主所" : "设为主所"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
