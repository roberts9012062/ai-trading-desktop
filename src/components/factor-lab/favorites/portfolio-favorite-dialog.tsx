"use client"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { FactorFavoriteItem } from "@/lib/factor-lab-api"
import { PortfolioCard } from "../portfolio-card"

export function PortfolioFavoriteDialog({ item, onClose }: { item: FactorFavoriteItem | null; onClose: () => void }): React.JSX.Element {
  const portfolio = item?.metrics?.portfolio_snapshot
  return <Dialog open={!!item} onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{item?.name ?? "组合因子数据"}</DialogTitle></DialogHeader>
      <p className="text-xs text-[var(--text-muted)]">{item?.symbol} · {item?.timeframe} · 收藏时的评估数据</p>
      {portfolio ? <PortfolioCard portfolio={portfolio} /> : <div className="text-xs space-y-2">
        <p>此旧收藏未保存组合评估数据，可查看成员配方。</p>
        <pre className="whitespace-pre-wrap break-all">{JSON.stringify(item?.tokens)}</pre>
      </div>}
    </DialogContent>
  </Dialog>
}
