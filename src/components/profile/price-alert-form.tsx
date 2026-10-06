"use client"

/**
 * 价格预警新建表单 —— 合约下拉（按交易所分组）+ 方向 + 目标价
 *
 * 合约来自 /api/market/contracts（全部主力），选中后自动带 symbol+name 提交。
 */

import { useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { createPriceAlertApi, getContractsApi, type ContractItem } from "@/lib/api"

type Direction = "above" | "below"

/** 交易所分组顺序 */
const EXCHANGES: string[] = [
  "上期所",
  "大商所",
  "郑商所",
  "中金所",
  "广期所",
  "能源中心",
]

/** 按交易所分组，过滤空组 */
function groupByExchange(
  contracts: ContractItem[],
): { label: string; items: ContractItem[] }[] {
  return EXCHANGES.map((ex) => ({
    label: ex,
    items: contracts.filter((c) => c.exchange === ex),
  })).filter((g) => g.items.length > 0)
}

export function PriceAlertForm(props: {
  onCreated: () => void
}): React.JSX.Element {
  const [contracts, setContracts] = useState<ContractItem[]>([])
  const [selected, setSelected] = useState<ContractItem | null>(null)
  const [direction, setDirection] = useState<Direction>("above")
  const [target, setTarget] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    void (async () => {
      try {
        setContracts(await getContractsApi())
      } catch {
        // 未登录静默
      }
    })()
  }, [])

  const groups = groupByExchange(contracts)

  async function submit(): Promise<void> {
    setError("")
    const targetNum = Number(target)
    if (!selected) {
      setError("请选择合约")
      return
    }
    if (!Number.isFinite(targetNum) || targetNum <= 0) {
      setError("请输入有效的目标价")
      return
    }
    setSubmitting(true)
    try {
      await createPriceAlertApi({
        symbol: selected.symbol,
        contract_name: selected.name,
        direction,
        target_price: targetNum,
      })
      setSelected(null)
      setTarget("")
      props.onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : "新建失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        <select
          className="h-8 text-sm rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 min-w-[160px]"
          value={selected ? selected.symbol : ""}
          onPointerDown={() => { void getContractsApi().then(setContracts).catch(() => {}) }}
          onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === " ") void getContractsApi().then(setContracts).catch(() => {}) }}
          onChange={(e) => {
            const hit = contracts.find((c) => c.symbol === e.target.value)
            setSelected(hit ?? null)
          }}
        >
          <option value="">选择合约…</option>
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((c) => (
                <option key={c.symbol} value={c.symbol}>
                  {c.symbol} · {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select
          className="h-8 text-sm rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2"
          value={direction}
          onChange={(e) => setDirection(e.target.value as Direction)}
        >
          <option value="above">涨到 ≥</option>
          <option value="below">跌到 ≤</option>
        </select>
        <Input
          placeholder="目标价"
          type="number"
          className="h-8 text-sm w-32"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <Button validateNumbers size="sm" disabled={submitting} onClick={() => void submit()}>
          {submitting ? "添加中…" : "新增"}
        </Button>
      </div>
      {error && <p className="text-xs text-[var(--accent-danger)]">{error}</p>}
    </div>
  )
}
