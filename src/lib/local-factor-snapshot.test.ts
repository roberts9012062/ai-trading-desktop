/**
 * 因子实验室快照复用测试(方案任务 3 验收 / 问题 H)
 *
 * - 搜索冻结 bars 快照:单因子复测复用同一份 bars,不再重新取数;
 * - 网络修订隔离:fetch 层返回被篡改的新数据后,复测仍收到冻结 bars;
 * - 冻结成本注入:复测未显式给 cost 时用搜索时冻结值;
 * - 区间/品种不匹配:回退重新取数(用户改表单的场景)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/local-backtest", () => ({
  fetchBacktestBars: vi.fn(),
  KLINE_MAX_PAGES: 150,
}))
vi.mock("@/lib/py-worker", () => ({
  ensurePyWorker: vi.fn(),
  cancelPyWorker: vi.fn(),
}))

import { fetchBacktestBars } from "@/lib/local-backtest"
import { ensurePyWorker } from "@/lib/py-worker"
import {
  backtestFactorLocal,
  clearSearchSnapshot,
  getLastSearchSnapshot,
  searchFactorsLocal,
} from "@/lib/local-factor"
import type { KlineBar } from "@/types"

const mockedFetch = vi.mocked(fetchBacktestBars)
const mockedEnsure = vi.mocked(ensurePyWorker)

function bars(n: number): KlineBar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00`,
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100.5 + i * 0.1,
    volume: 10,
    settle: null,
    open_interest: null,
  }))
}

function fakeWorker() {
  const factorRun = vi.fn().mockResolvedValue({ metrics: { ann_ret: 0.1 }, equity_curve: [] })
  const mineStart = vi.fn().mockResolvedValue({ session_id: "s1" })
  const mineStep = vi
    .fn()
    .mockResolvedValueOnce({
      done: false, generation: 1, total_generations: 1, best_composite: 1,
      champions: [{ tokens: [0, 87], text: "x", composite: 1, metrics: { ann_ret: 0.1 } }],
    })
    .mockResolvedValueOnce({ done: true })
  const mineDispose = vi.fn().mockResolvedValue("{}")
  mockedEnsure.mockReturnValue({
    factorRun, mineStart, mineStep, mineDispose,
  } as unknown as ReturnType<typeof ensurePyWorker>)
  return { factorRun, mineStart, mineStep, mineDispose }
}

beforeEach(() => {
  clearSearchSnapshot()
  mockedFetch.mockReset()
  mockedEnsure.mockReset()
})

afterEach(() => {
  clearSearchSnapshot()
})

describe("search snapshot reuse (任务 3 / 问题 H)", () => {
  it("搜索后复测复用冻结 bars,不重新取数", async () => {
    const frozen = bars(200)
    mockedFetch.mockResolvedValue(frozen)
    const w = fakeWorker()
    await searchFactorsLocal(
      { symbol: "BTCUSDT", timeframe: "60m", population: 4, generations: 1, top_n: 3, seed: 1 },
    )
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    const snap = getLastSearchSnapshot()
    expect(snap).not.toBeNull()
    expect(snap!.bars).toBe(frozen) // 同一引用(冻结,未复制/重拉)

    // 复测:不再触发 fetch,内核收到冻结 bars
    await backtestFactorLocal({
      symbol: "BTCUSDT", timeframe: "60m", factor_tokens: [0, 87], crypto_profile: true,
      start_date: snap!.startDate, end_date: snap!.endDate,
    })
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(w.factorRun).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "backtest_factor" }),
      frozen,
    )
  })

  it("网络修订隔离:fetch 层返回篡改数据后,复测仍收到冻结 bars", async () => {
    const frozen = bars(200)
    mockedFetch.mockResolvedValueOnce(frozen)
    fakeWorker()
    await searchFactorsLocal(
      { symbol: "BTCUSDT", timeframe: "60m", population: 4, generations: 1, top_n: 3, seed: 1 },
    )
    // 「网络修订」:新拉的同区间数据被篡改(价格×10)
    const revised = bars(200).map((b) => ({ ...b, close: b.close * 10, open: b.open * 10 }))
    mockedFetch.mockResolvedValue(revised)

    const snap = getLastSearchSnapshot()!
    await backtestFactorLocal({
      symbol: "BTCUSDT", timeframe: "60m", factor_tokens: [0, 87], crypto_profile: true,
      start_date: snap.startDate, end_date: snap.endDate,
    })
    // 复测没有消费修订数据:fetch 未被再次调用,内核仍收到冻结引用
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    const call = vi.mocked(ensurePyWorker).mock.results[0]?.value as unknown as {
      factorRun: ReturnType<typeof vi.fn>
    }
    const barsArg = call.factorRun.mock.calls.at(-1)?.[1]
    expect(barsArg).toBe(frozen)
  })

  it("冻结成本注入:复测未给 cost 时用搜索时冻结值", async () => {
    const frozen = bars(200)
    mockedFetch.mockResolvedValue(frozen)
    const w = fakeWorker()
    await searchFactorsLocal(
      { symbol: "BTCUSDT", timeframe: "60m", population: 4, generations: 1, top_n: 3, seed: 1, cost: 0.0012 },
    )
    const snap = getLastSearchSnapshot()!
    expect(snap.cost).toBe(0.0012)
    await backtestFactorLocal({
      symbol: "BTCUSDT", timeframe: "60m", factor_tokens: [0, 87], crypto_profile: true,
      start_date: snap.startDate, end_date: snap.endDate,
    })
    const payload = w.factorRun.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(payload.cost).toBe(0.0012)
  })

  it("品种/区间不匹配时回退重新取数", async () => {
    mockedFetch.mockResolvedValue(bars(200))
    fakeWorker()
    await searchFactorsLocal(
      { symbol: "BTCUSDT", timeframe: "60m", population: 4, generations: 1, top_n: 3, seed: 1 },
    )
    mockedFetch.mockClear()
    await backtestFactorLocal({
      symbol: "ETHUSDT", timeframe: "60m", factor_tokens: [0, 87], crypto_profile: true,
    })
    expect(mockedFetch).toHaveBeenCalledTimes(1) // 不同品种 → 重新取数
    await backtestFactorLocal({
      symbol: "BTCUSDT", timeframe: "60m", factor_tokens: [0, 87], crypto_profile: true,
      start_date: "2020-01-01", end_date: "2021-01-01", // 用户改了区间 → 重新取数
    })
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })
})
