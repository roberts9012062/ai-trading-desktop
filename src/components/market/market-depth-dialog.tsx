"use client"

import { BarChart3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { MarketDepthPanel } from "./market-depth-panel"
import { TradeDetails } from "./trade-details"

export function MarketDepthDialog({
  className,
  onPriceSelect,
}: {
  className?: string
  onPriceSelect?: (side: "ask" | "bid", price: number) => void
}): React.JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          size="sm"
          className={cn("gap-1.5 shadow-lg", className)}
          aria-label="打开盘口数据"
        >
          <BarChart3 className="h-4 w-4" />
          盘口
        </Button>
      </DialogTrigger>
      <DialogContent className="h-[620px] w-[min(94vw,380px)] max-w-none gap-0 overflow-hidden p-0 flex flex-col">
        <DialogTitle className="sr-only">盘口数据</DialogTitle>
        <div className="h-[360px] shrink-0 border-b border-[var(--border)]">
          <MarketDepthPanel onPriceSelect={onPriceSelect} />
        </div>
        <div className="min-h-0 flex-1">
          <TradeDetails listClassName="max-h-none h-full" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
