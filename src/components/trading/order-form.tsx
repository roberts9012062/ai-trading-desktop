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
          <Label className="text-xs">保证金（USDT）</Label>
          <Input
            type="number"
            value={p.marginInput}
            onChange={(e) => p.setMarginInput(e.target.value)}
            className="font-num h-8 text-sm"
            min={0}
            step="any"
            placeholder="如 100"
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs">杠杆</Label>
            <span className="font-num text-xs text-[var(--primary)] font-semibold">{p.leverage}x</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              type="range"
              min={1}
              max={100}
              step={1}
              value={p.leverage}
              onChange={(e) => p.setLeverage(Number(e.target.value))}
              className="h-1.5 flex-1 accent-[var(--primary)]"
            />
            {[5, 10, 20, 50, 100].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => p.setLeverage(v)}
                className={cn(
                  "px-1.5 h-6 text-[10px] rounded border transition-colors",
                  p.leverage === v
                    ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]",
                )}
              >
                {v}x
              </button>
            ))}
          </div>
        </div>
        {p.direction !== "close" && (
          <div className="space-y-1">
            <Label className="text-xs">保证金模式</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { v: "cross" as const, label: "全仓", hint: "账户共享保证金" },
                  { v: "isolated" as const, label: "逐仓", hint: "仓位独立强平线" },
                ]
              ).map(({ v, label, hint }) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => p.setMarginMode(v)}
                  className={cn(
                    "h-8 rounded-md border text-xs transition-colors",
                    p.marginMode === v
                      ? "border-[var(--primary)] text-[var(--primary)] bg-[var(--primary)]/10"
                      : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
                  )}
                  title={hint}
                >
                  {label}
                  <span className="ml-1 text-[10px] text-[var(--text-muted)]">
                    {hint}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <InfoRow
          label={`自动数量（保证金×杠杆 ÷ 价格）`}
          value={p.autoQty > 0 ? `${p.autoQty.toFixed(6).replace(/0+$/, "").replace("\.$/", "")}` : "--"}
        />
        <InfoRow label="名义价值" value={p.notional > 0 ? `${p.notional.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} USDT` : "--"} />
        {p.direction !== "close" && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-[var(--accent-up)]">止盈价（可选）</Label>
              <Input
                type="number"
                value={p.tpPrice}
                onChange={(e) => p.setTpPrice(e.target.value)}
                className="font-num h-8 text-sm"
                min={0}
                step="any"
                placeholder="留空不设"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-[var(--accent-danger)]">止损价（可选）</Label>
              <Input
                type="number"
                value={p.slPrice}
                onChange={(e) => p.setSlPrice(e.target.value)}
                className="font-num h-8 text-sm"
                min={0}
                step="any"
                placeholder="留空不设"
              />
            </div>
          </div>
        )}
        {p.direction !== "close" && p.tpPrice && p.slPrice && (
          <p className="text-[10px] text-[var(--text-muted)]">
            盈亏比 R:R{" "}
            <span className={cn("font-num font-semibold", (p.rr ?? 0) >= 2 ? "text-[var(--accent-up)]" : "text-[var(--accent-warn)]")}>
              {p.rr ? p.rr.toFixed(2) : "--"}
            </span>
            （r20 风控建议 ≥ 2.0）
          </p>
        )}
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
              value={`${p.maxLots > 0 ? p.maxLots : "--"}`}
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
                      `${x.direction === "long" ? "多" : "空"}${x.available_quantity}`
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
                `${x.direction === "long" ? "多" : "空"}${x.available_quantity}`
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
        <Button validateNumbers
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
            ? `最新价${p.submitLabel} ${p.autoQty > 0 ? p.autoQty.toFixed(4) : p.quantity}`
            : p.isOpen
              ? `${p.submitLabel} ${p.autoQty > 0 ? p.autoQty.toFixed(4) : p.quantity}`
              : `挂单 ${p.submitLabel} ${p.autoQty > 0 ? p.autoQty.toFixed(4) : p.quantity}`}
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
          quantity={p.autoQty > 0 ? p.autoQty.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : p.quantity}
          leverage={p.autoQty > 0 ? p.leverage : null}
          notional={p.autoQty > 0 ? p.notional : null}
          tpPrice={p.direction !== "close" ? Number(p.tpPrice) || null : null}
          slPrice={p.direction !== "close" ? Number(p.slPrice) || null : null}
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
