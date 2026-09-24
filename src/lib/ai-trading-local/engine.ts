/**
 * AI 交易本地引擎 —— 调度与信号计算在客户端,下单/账本走服务端
 *
 * 架构:客户端 2s 轮询「execution_site=client 且 running」的任务,bar 对齐去重后
 * 计算信号(量化=pykernel 策略,AI=用户本地 key 直连 LLM),提交服务端
 * client-decision 端点做最终风控+下单+记账(撮合/资金仓/审计完全在服务端)。
 * 已知限制(与设计一致):应用关闭即停止。
 */

import { getKlineApi } from "@/lib/api"
import { listAITradingTasks, submitClientDecision } from "@/lib/ai-trading-api"
import { ensurePyWorker } from "@/lib/py-worker"
import { getActiveLocalAi } from "@/lib/local-ai"
import type { KlineBar } from "@/types"

const TICK_TRADING_MS = 2000
const KLINE_TTL_MS = 10_000
const KLINE_LIMIT = 240

interface LocalTask {
  id: string
  symbol: string
  timeframe: string
  strategy_type: string
  strategy_params: Record<string, unknown> | null
  side_mode: string
  risk_style: string | null
  allocated_capital: number
  custom_prompt: string | null
  last_bar_time: string | null
  status: string
  execution_site: string
  [k: string]: unknown
}

let timer: ReturnType<typeof setInterval> | null = null
let running = false
const klineCache = new Map<string, { bars: KlineBar[]; at: number }>()
const localLastBar = new Map<string, string>()

async function py<T>(op: string, payload: Record<string, unknown>, arg: Record<string, unknown>): Promise<T> {
  return (await ensurePyWorker().engineRun({ op, ...payload }, arg)) as T
}

async function getBars(symbol: string, timeframe: string): Promise<KlineBar[]> {
  const key = `${symbol}:${timeframe}`
  const hit = klineCache.get(key)
  if (hit && Date.now() - hit.at < KLINE_TTL_MS) return hit.bars
  const resp = await getKlineApi(symbol, timeframe, { limit: KLINE_LIMIT })
  const bars = (resp.bars ?? []) as KlineBar[]
  klineCache.set(key, { bars, at: Date.now() })
  return bars
}

/** 本地 AI 决策:用户自己的 key 直连 OpenAI 兼容接口(非流式,temperature=0) */
async function localAiDecide(system: string, user: string): Promise<string | null> {
  const active = getActiveLocalAi()
  if (!active) return null
  try {
    const r = await fetch(`${active.provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${active.provider.apiKey}` },
      body: JSON.stringify({
        model: active.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] }
    return j.choices?.[0]?.message?.content ?? null
  } catch {
    return null
  }
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const { items } = await listAITradingTasks()
    const tasks = (items as unknown as LocalTask[]).filter(
      (t) => t.status === "running" && t.execution_site === "client",
    )
    for (const task of tasks) {
      try {
        await evaluateOne(task)
      } catch (err) {
        console.warn("[local-engine] 任务评估失败", task.symbol, err)
      }
    }
  } catch {
    // 网络异常静默,下轮重试
  } finally {
    running = false
  }
}

async function evaluateOne(task: LocalTask): Promise<void> {
  const bars = await getBars(task.symbol, task.timeframe)
  if (bars.length < 30) return
  const cacheKey = `${task.id}:${task.timeframe}`
  const lastBar = localLastBar.get(cacheKey) ?? task.last_bar_time ?? null
  const align = await py<{ run: boolean; bar_time: string }>("should_run", {}, { bars, last_bar_time: lastBar })
  if (!align.run || !align.bar_time) return
  localLastBar.set(cacheKey, align.bar_time)

  const closedIdx = bars.findIndex((b) => b.time === align.bar_time)
  const signalBars = closedIdx >= 0 ? bars.slice(Math.max(0, closedIdx - 239), closedIdx + 1) : bars

  let decision: { action: string; quantity: number; reason?: string; confidence?: number } | null = null
  let raw: string | null = null
  let trigger = "client"

  if (task.strategy_type !== "ai") {
    const sig = await py<{ action: string; quantity: number; reason?: string }>(
      "quant_signal",
      { strategy: task.strategy_type, params: task.strategy_params ?? {}, side_mode: task.side_mode },
      { bars: signalBars, position: null },
    )
    decision = { action: sig.action, quantity: Number(sig.quantity || 0), reason: sig.reason, confidence: 1 }
    trigger = `client:${task.strategy_type}`
  } else {
    const prompt = await py<{ system: string; user: string }>(
      "build_ai_prompt",
      {
        risk_style: task.risk_style,
        timeframe: task.timeframe,
        max_hold_days: 10,
        allocated_capital: task.allocated_capital,
        custom_prompt_enabled: Boolean(task.custom_prompt),
        custom_prompt: task.custom_prompt,
        context: {
          symbol: task.symbol,
          timeframe: task.timeframe,
          recent_bars: signalBars.slice(-30),
          last_price: Number(bars[bars.length - 1]?.close ?? 0),
        },
      },
      {},
    )
    raw = await localAiDecide(prompt.system, prompt.user)
    if (!raw) return // 本地 AI 未配置/调用失败:跳过本 bar(不盲动)
    const parsed = await py<{ action: string; quantity: number; reason?: string; confidence?: number }>(
      "parse_ai_decision",
      {},
      { text: raw },
    )
    decision = parsed
    trigger = "client:ai"
  }

  if (!decision || decision.action === "hold") return
  await submitClientDecision(task.id, {
    action: decision.action,
    quantity: Number(decision.quantity || 0),
    reason: String(decision.reason ?? "").slice(0, 200),
    confidence: Number(decision.confidence || 0),
    raw: raw ? raw.slice(0, 2000) : null,
    bar_time: align.bar_time,
    trigger_type: trigger,
  })
}

export function startLocalEngine(): void {
  if (timer) return
  timer = setInterval(() => void tick(), TICK_TRADING_MS)
  void tick()
}

export function stopLocalEngine(): void {
  if (timer) clearInterval(timer)
  timer = null
  localLastBar.clear()
}
