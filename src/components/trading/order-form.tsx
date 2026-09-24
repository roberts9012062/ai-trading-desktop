"use client"

/**
 * 模拟交易下单面板
 * - 对手价（默认）：买用卖一、卖用买一，跟盘变动，点下单即提交
 * - 指定价：手动输入价格
 */

import { cn } from "@/lib/utils"
import { OrderConfirmDialog } from "@/components/trading/order-confirm"
import {
  DirButtons,
  HeaderBar,
  InfoRow,
  OrderTypeTabs,
  PriceBlock,
  PriceModeTabs,
} from "@/components/trading/order-panel-parts"
import { useOrderPanel } from "@/components/trading/use-order-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"

export function OrderPanel(): React.JSX.Element {
  const p = useOrderPanel()

  return (
    <div className="flex flex-col h-full">
      <HeaderBar
        isOpen={p.isOpen}
        profileLabel={p.session?.profile_label}
        activeContract={p.activeContract}
        contractName={p.contractName}
        lastPrice={p.lastPrice}
        bidPrice={p.bidPrice}
        askPrice={p.askPrice}
        decimals={p.decimals}
        change={p.change}
      />
      <div className="px-3 pt-2 space-y-2">
        <OrderTypeTabs
          orderType={p.orderType}
          isOpen={p.isOpen}
          onChange={p.setOrderType}
        />
        {p.orderType === "limit" && (
          <PriceModeTabs priceMode={p.priceMode} onChange={p.setPriceMode} />
        )}
      </div>
      <DirButtons direction={p.direction} onChange={p.setDirection} />
      <div className="px-3 mt-3 space-y-2">
        <PriceBlock
          orderType={p.orderType}
          priceMode={p.priceMode}
          effectiveDir={p.effectiveDir}
          priceNum={p.priceNum}
          decimals={p.decimals}
          lastPrice={p.lastPrice}
          manualPrice={p.manualPrice}
          onManual={p.setManualPrice}
        />
        <div className="space-y-1">
          <Label className="text-xs">数量（手）</Label>
          <Input
            type="number"
            value={p.quantity}
            onChange={(e) => p.setQuantity(e.target.value)}
            className="font-num h-8 text-sm"
            min={1}
          />
        </div>
        <InfoRow
          label="可用保证金"
          value={p.available.toLocaleString("zh-CN", {
            minimumFractionDigits: 2,
          })}
        />
        {p.direction !== "close" ? (
          <>
            <InfoRow
              label="预估保证金"
              value={p.estimate ? p.estimate.margin.toLocaleString() : "--"}
            />
            <InfoRow
              label="约可开"
              value={`${p.maxLots > 0 ? p.maxLots : "--"} 手`}
            />
          </>
        ) : (
          <p className="text-[10px] text-[var(--text-muted)]">
            可平：
            {p.closeable.length === 0
              ? "无"
              : p.closeable
                  .map(
                    (x) =>
                      `${x.direction === "long" ? "多" : "空"}${x.available_quantity}手`
                  )
                  .join(" / ")}
          </p>
        )}
      </div>
      {p.direction === "close" && p.closeable.length > 0 && (
        <div className="mx-3 mt-2 rounded-md border border-[var(--accent-warn)]/30 bg-[var(--accent-warn)]/10 px-2.5 py-1.5 text-[11px] text-[var(--accent-warn)]">
          平仓 {p.activeContract} · 可平{" "}
          {p.closeable
            .map(
              (x) =>
                `${x.direction === "long" ? "多" : "空"}${x.available_quantity}手`
            )
            .join(" / ")}
          {p.isOpen ? " · 点下方按钮按最新价平仓" : " · 休市限价挂平"}
        </div>
      )}
      {(p.error || p.lastMessage) && (
        <div
          className={cn(
            "mx-3 mt-2 text-[11px] rounded px-2 py-1.5",
            p.error
              ? "bg-[var(--accent-danger)]/10 text-[var(--accent-danger)]"
              : "bg-[var(--accent-up)]/10 text-[var(--accent-up)]"
          )}
        >
          {p.error ?? p.lastMessage}
        </div>
      )}
      <div className="mt-auto px-3 pb-3 pt-2">
        <Button
          variant={
            p.direction === "buy"
              ? "buy"
              : p.direction === "sell"
                ? "sell"
                : "close"
          }
          className="w-full font-bold gap-1"
          disabled={!p.canSubmit}
          onClick={p.handleSubmitClick}
        >
          {p.submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {p.direction === "close" && p.isOpen
            ? `最新价${p.submitLabel} ${p.quantity}手`
            : p.isOpen
              ? `${p.submitLabel} ${p.quantity}手`
              : `挂单 ${p.submitLabel} ${p.quantity}手`}
          {p.priceNum > 0 && (
            <span className="font-num opacity-90">
              @{p.priceNum.toFixed(p.decimals)}
            </span>
          )}
        </Button>
        {p.priceNum > 0 && p.lastPrice > 0 && !p.inBand && (
          <p className="text-[10px] text-[var(--accent-danger)] mt-1.5 text-center">
            价格须在 ±10%（{p.band.min.toFixed(2)} ~ {p.band.max.toFixed(2)}）
          </p>
        )}
        {p.priceMode === "opponent" && (
          <p className="text-[10px] text-[var(--text-muted)] mt-1.5 text-center">
            对手价跟盘 · 点一下即下单
          </p>
        )}
      </div>
      {p.confirmOpen && (
        <OrderConfirmDialog
          contract={p.activeContract}
          direction={p.direction}
          price={
            p.orderType === "market"
              ? `市价(~${p.priceNum})`
              : String(p.priceNum)
          }
          quantity={p.quantity}
          estimate={p.direction === "close" ? null : p.estimate}
          submitting={p.submitting}
          onConfirm={() => {
            void p.doPlace().then(() => p.setConfirmOpen(false))
          }}
          onCancel={() => p.setConfirmOpen(false)}
        />
      )}
    </div>
  )
}
