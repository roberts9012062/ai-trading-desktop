/**
 * LLM 因子种子生成(服务端路线 B 的本地化,深挖强化 M5)
 *
 * 用本地直连 LLM 生成因子公式 token 候选,注入 GP 种群当种子(与
 * seed_tokens 同机制)——「LLM 直觉 + GPU 暴力」混合搜索:LLM 提供
 * 人类先验的多样化起点,GP 负责大规模精炼。
 *
 * 词表由内核 llm_vocab 模式产出(FEATURE_NAMES/OPS_CONFIG/文案的单一
 * 事实源,不在 JS 侧另维护);生成结果逐条经 tokensToTree 严格校验
 * (栈式合法性),非法候选直接丢弃,LLM 无法注入任何非法 token。
 */

import { localChatJson } from "@/lib/local-ai"
import { tokensToTree } from "@/lib/mining/gpu/gp"
import type { MultimodalMessage } from "@/lib/ai-stream"

interface VocabEntry {
  id: number
  name: string
  text: string
  arity?: number
}

interface LlmVocab {
  feat_offset: number
  features: VocabEntry[]
  ops: VocabEntry[]
}

export interface LlmSeedOptions {
  symbol: string
  timeframe: string
  /** 用户自由提示(挖掘思路/市场观点) */
  hint?: string
  /** 已有冠军(提示 LLM 提供不同思路,避免重复探索) */
  champions?: { text: string; composite: number }[]
  signal?: AbortSignal
}

export interface LlmSeedResult {
  tokens: number[][]
  /** LLM 对候选思路的一句话说明 */
  note: string
}

async function fetchVocab(): Promise<LlmVocab> {
  const { ensurePyWorker } = await import("@/lib/py-worker")
  return (await ensurePyWorker().factorRun({ mode: "llm_vocab" }, [], 30_000)) as LlmVocab
}

function buildMessages(
  opts: LlmSeedOptions,
  vocab: LlmVocab,
): MultimodalMessage[] {
  const feats = vocab.features
    .map((f) => `${f.id}=${f.name}(${f.text})`)
    .join("、")
  const ops = vocab.ops
    .map((o) => `${o.id}=${o.name}(${o.text},${o.arity}元)`)
    .join("、")
  const champLines = (opts.champions ?? [])
    .slice(0, 3)
    .map((c) => `- ${c.text}(综合 ${c.composite.toFixed(2)})`)
    .join("\n")

  const system = [
    "你是资深量化因子研究员,精通期货市场因子挖掘。",
    "你的任务是为遗传算法生成初始因子公式候选——不是最终答案,而是带人类直觉先验的多样化种子,GP 会在这些种子之上大规模进化精炼。",
    "",
    "因子公式用后缀 token 序列(栈式)编码:",
    "- 特征 token = 特征 id(整数),把该特征的时序值压入栈;",
    `- 算子 token = ${vocab.feat_offset} + 算子下标,弹出元数个操作数、计算后压回 1 个;`,
    "- 序列执行完栈中必须恰好剩 1 个,才是合法公式。",
    "",
    "要求:",
    "1. 只使用词表中列出的特征与算子,token 必须是整数;",
    "2. 每条公式 3-12 个 token,含义清晰;",
    "3. 候选之间思路尽量不同(动量/均值回复/量价/波动/持仓/微观结构等),不要全是均线类;",
    "4. 期货是双向市场,因子天然支持多空(正值做多/负值做空),不要设计只做多的公式;",
    "5. 所有特征本身严格因果,直接组合即可,无需担心未来信息。",
    "",
    '只输出 JSON:{"candidates": [[token, ...], ...], "note": "一句话说明各候选思路"}',
    "生成 6-10 条候选。",
  ].join("\n")

  const user = [
    `品种: ${opts.symbol} 周期: ${opts.timeframe}`,
    "",
    `特征词表(id=名称(含义)): ${feats}`,
    "",
    `算子词表(id=名称(文案,元数)): ${ops}`,
    ...(champLines
      ? ["", "GP 已充分探索过以下方向,新候选请提供不同思路:", champLines]
      : []),
    ...(opts.hint ? ["", `用户提示: ${opts.hint}`] : []),
  ].join("\n")

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

/** 从 LLM 输出解析 JSON(容忍 ```json 围栏与前后杂文) */
function parseCandidates(raw: string): { candidates?: unknown; note?: unknown } {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start >= 0 && end > start) text = text.slice(start, end + 1)
  return JSON.parse(text) as { candidates?: unknown; note?: unknown }
}

/** 生成因子种子:词表 → LLM → 严格校验,返回合法 token 候选(可能为空) */
export async function localLlmGenerateFactors(opts: LlmSeedOptions): Promise<LlmSeedResult> {
  const vocab = await fetchVocab()
  const messages = buildMessages(opts, vocab)
  const raw = await localChatJson(messages, { temperature: 0.7, signal: opts.signal })
  const parsed = parseCandidates(raw)
  const featCount = vocab.features.length
  const tokensList: number[][] = []
  if (Array.isArray(parsed.candidates)) {
    const seen = new Set<string>()
    for (const item of parsed.candidates) {
      if (!Array.isArray(item)) continue
      const tokens = item.filter((t): t is number => Number.isInteger(t))
      if (tokens.length < 2 || tokens.length > 32) continue
      // 栈式合法性校验(tokensToTree 非空 = 合法),非法候选直接丢弃
      if (!tokensToTree(tokens, featCount)) continue
      const key = tokens.join(",")
      if (seen.has(key)) continue
      seen.add(key)
      tokensList.push(tokens)
    }
  }
  return {
    tokens: tokensList.slice(0, 10),
    note: typeof parsed.note === "string" ? parsed.note : "",
  }
}
