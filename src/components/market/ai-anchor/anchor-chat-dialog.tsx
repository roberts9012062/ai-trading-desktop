"use client";

/**
 * AI 主播对话交互弹窗 —— 按需加载合约数据做分析报告 + 技术K线图
 *
 * 复用 /api/ai/chat 的 ReAct 工具调用网关（K线/技术指标/大单/盘口/新闻
 * 按需拉取），模型在回复中输出 ```chart 指令块，前端实时渲染
 * 压力位/支撑位/箱体区间/未来走势等技术K线图。
 * 消息状态为组件本地（与全局 AI 助手浮窗互不干扰）。
 */

import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { Loader2, Send } from "lucide-react"
import { streamChat, type MultimodalMessage } from "@/lib/ai-stream"
import { useAiAnchorStore } from "@/stores/ai-anchor"
import { useAISettingsStore } from "@/stores/ai-settings"
import { AnchorChartRender } from "./anchor-chart-render"
import { hasRenderableChart, splitChartSegments } from "./anchor-chart-directive"
import type { AnchorAnnotations } from "./anchor-chart-annotations"
import { contractName } from "@/lib/contract-names"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

interface AnchorChatDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ChatBubble {
  id: string
  role: "user" | "assistant"
  content: string
  /** 静默消息：参与对话上下文但不渲染气泡（自动补图指令） */
  silent?: boolean
}

/** 用户消息是否表达画图意图（自动补图判断） */
const CHART_INTENT = /画|图|走势|箱体|压力|支撑|区间|可视化/

/** 建议词（首次打开引导） */
const SUGGESTIONS = [
  "分析当前压力位和支撑位",
  "看看今天的大单流向",
  "画个箱体区间图",
  "结合MACD判断短线走势",
]

/** 主播上下文 + 画图指令的 system 提示 */
function buildSystemPrompt(symbol: string, timeframe: string, latestText: string): string {
  return (
    "你是一位资深的期货技术看盘专家，正在为使用「AI看盘主播」的用户提供交互式分析。" +
    `当前主播正在跟踪 ${symbol}（${contractName(symbol)}）${timeframe} 周期。${latestText}\n\n` +
    "你有行情工具可按需调用：get_kline(K线)、get_quote(实时行情)、get_orderbook(盘口五档)、" +
    "get_big_orders(今日大单)、calculate_indicator(MA/EMA/MACD/RSI/BOLL/KDJ等技术指标)、" +
    "get_news(相关新闻)。必须先调工具拿真实数据再分析，禁止编造数据和价位。\n\n" +
    "【重要·画图要求】你的回答凡涉及价位（压力位/支撑位/买卖点/箱体区间/未来走势）时，" +
    "必须在回答中输出 chart 指令块，格式是三个反引号开头的 ```chart 围栏包裹的 JSON：\n" +
    '```chart\n{"symbol":"' + symbol + '","period":"' + timeframe + '","limit":120,\n' +
    ' "levels":[{"price":2580,"role":"resistance","label":"前高压力"},{"price":2500,"role":"support","label":"缺口支撑"}],\n' +
    ' "zones":[{"upper":2570,"lower":2540,"label":"箱体区间"}],\n' +
    ' "projection":{"label":"预期路径","points":[{"offset":4,"price":2560},{"offset":8,"price":2580}]}}\n```\n' +
    "字段规则：period 必须与主播周期一致（" + timeframe + "），除非用户明确要求其它周期；levels 的 role 可选 entry(进场)/take_profit(止盈)/stop_loss(止损)/" +
    "resistance(压力位)/support(支撑位)，价位必须来自真实K线数据；" +
    "zones 画箱体/买卖区间色带(upper必须大于lower)；projection 画未来走势预测，" +
    "offset=未来第几根K线(正整数)、price=预测价位。\n" +
    "用户说「画图/画出来/看图」或问到价位分析时，必须输出 chart 块；" +
    "画压力位图就给 levels，画箱体图就给 zones，画走势图就给 projection，可组合，" +
    "一次回答可输出多张图。chart 块必须单独成段，围栏内只放 JSON。"
  )
}

export function AnchorChatDialog({
  open,
  onOpenChange,
}: AnchorChatDialogProps): React.JSX.Element {
  const task = useAiAnchorStore((s) => s.task)
  const broadcasts = useAiAnchorStore((s) => s.broadcasts)
  const models = useAISettingsStore((s) => s.models)
  const fetchModels = useAISettingsStore((s) => s.fetchModels)
  const [messages, setMessages] = useState<ChatBubble[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 聊天网关按模型名字符串(model_id)寻址,主播任务存的是模型库行 id——
  // 从模型库解析出对应 model_id;列表未加载时拉取
  const modelRow = task ? models.find((m) => m.id === task.model_row_id) : undefined
  const chatModelId = modelRow?.model_id ?? ""
  const symbol = task?.symbol ?? ""
  useEffect(() => {
    if (open && models.length === 0) void fetchModels()
  }, [open, models.length, fetchModels])

  // 最新一条成功播报作为上下文（模型知道主播当前观点）
  const latestOk = broadcasts.find((item) => !item.model_error)
  const latestText = latestOk
    ? `主播最新结论：${latestOk.direction === "long" ? "看多" : latestOk.direction === "short" ? "看空" : "中性"}，` +
      `${latestOk.action === "trade" ? "建议做单" : "建议观望"}（${latestOk.commentary.slice(0, 120)}）。`
    : "主播暂无播报。"

  // 流式输出时滚动到底部
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages])

  // 关闭弹窗中断进行中的流
  useEffect(() => {
    if (!open) abortRef.current?.abort()
  }, [open])

  const send = async (text: string): Promise<void> => {
    await sendInternal(text, messages, { autoChart: true })
  }

  const sendInternal = async (
    text: string,
    baseHistory: ChatBubble[],
    opts: { autoChart: boolean },
  ): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || busy || !chatModelId) return
    setError(null)
    const userMsg: ChatBubble = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-u`,
      role: "user",
      content: trimmed,
      silent: !opts.autoChart,
    }
    const assistantId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-a`
    const assistantMsg: ChatBubble = { id: assistantId, role: "assistant", content: "" }
    const history = [...baseHistory, userMsg]
    setMessages([...history, assistantMsg])
    if (opts.autoChart) setInput("")
    setBusy(true)

    const contextMessages: MultimodalMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(symbol, task?.timeframe ?? "15m", latestText),
      },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ]

    const controller = new AbortController()
    abortRef.current = controller
    // 局部累积最终回复（自动补图判断用，避免读异步 state）
    let finalContent = ""
    try {
      await streamChat(
        chatModelId,
        contextMessages,
        {
          onMessage: (chunk) => {
            if (!chunk) return
            finalContent += chunk
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)),
            )
          },
          onThinking: () => {},
          onToolCall: () => {},
          onToolResult: () => {},
          onConfirmationRequest: () => {},
          onReactRound: () => {},
          onSubagentPlan: () => {},
          onSubagentUpdate: () => {},
          onError: (message) => {
            setError(message || "对话服务异常")
          },
          onDone: () => {},
        },
        { signal: controller.signal },
      )
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "发送失败")
      }
    } finally {
      abortRef.current = null
      setBusy(false)
    }

    // 自动补图：用户表达了画图意图但回复没有可渲染的 chart 指令，
    // 静默补一轮明确指令让模型把结论整理成图（只补一次）
    if (
      opts.autoChart &&
      finalContent.trim() &&
      CHART_INTENT.test(trimmed) &&
      !hasRenderableChart(finalContent, symbol, task?.timeframe)
    ) {
      await sendInternal(
        "请把你刚才的分析结论整理输出为 chart 指令块：三个反引号加 chart 开头的围栏，" +
          "围栏内只放一个 JSON 对象（symbol/period/levels/zones/projection 按你分析过的价位填写），" +
          "不要输出 JSON 之外的文字。",
        [...history, { ...assistantMsg, content: finalContent }],
        { autoChart: false },
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[92vw] h-[80vh] p-0 flex flex-col gap-0">
        <div className="shrink-0 px-4 py-3 border-b border-[var(--border)]">
          <DialogTitle className="text-sm text-[var(--text-primary)] pr-8">
            对话交互 · {symbol ? `${contractName(symbol)} ` : ""}
            <span className="text-[10px] font-normal text-[var(--text-muted)]">
              AI按需加载K线/大单/盘口/新闻 · 回答自动画技术图
            </span>
          </DialogTitle>
        </div>

        {/* 消息列表 */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="pt-6 space-y-3 text-center">
              <div className="text-xs text-[var(--text-muted)]">
                询问 {symbol ? contractName(symbol) : "当前合约"} 的任何行情问题，
                AI 会自动拉取数据并画出技术图
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => void send(item)}
                    className="px-3 h-7 rounded-full text-[11px] border border-[var(--primary)]/40 text-[var(--primary)] hover:bg-[var(--primary)]/10 cursor-pointer"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 静默消息（自动补图指令）不渲染气泡，只参与上下文 */}
          {messages.filter((m) => !m.silent).map((message) => (
            <div
              key={message.id}
              className={"flex " + (message.role === "user" ? "justify-end" : "justify-start")}
            >
              {message.role === "user" ? (
                <div className="max-w-[80%] rounded-lg rounded-tr-sm bg-[var(--primary)] text-white px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
                  {message.content}
                </div>
              ) : (
                <div className="max-w-[92%] w-full space-y-2">
                  {message.content === "" && busy ? (
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      正在调取数据并分析…
                    </div>
                  ) : (
                    splitChartSegments(message.content, symbol, task?.timeframe).map((segment, index) =>
                      segment.kind === "text" ? (
                        <div
                          key={index}
                          className="text-xs leading-relaxed text-[var(--text-secondary)] prose prose-sm max-w-none [&_p]:m-1 [&_li]:m-0 [&_code]:text-[11px]"
                        >
                          <ReactMarkdown>{segment.content.trim()}</ReactMarkdown>
                        </div>
                      ) : segment.directive ? (
                        <ChartBlock
                          key={index}
                          directive={segment.directive}
                        />
                      ) : (
                        <div
                          key={index}
                          className="rounded-md bg-[var(--bg-tertiary)] px-3 py-2 text-[10px] font-mono text-[var(--text-muted)] overflow-x-auto"
                        >
                          {segment.content}
                        </div>
                      ),
                    )
                  )}
                </div>
              )}
            </div>
          ))}

          {error && <div className="text-[11px] text-red-400 text-center">{error}</div>}
        </div>

        {/* 输入区 */}
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-3 flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void send(input)
            }}
            placeholder={
              chatModelId ? "询问行情、让 AI 画压力位/箱体/走势图…" : "主播未配置模型，先启动主播"
            }
            disabled={!chatModelId || busy}
            className="flex-1 h-9 px-3 rounded-lg text-xs bg-[var(--bg-secondary)] border border-[var(--border)] outline-none focus:border-[var(--primary)] disabled:opacity-50"
          />
          <button
            type="button"
            disabled={!chatModelId || busy || !input.trim()}
            onClick={() => void send(input)}
            className="h-9 px-4 rounded-lg text-xs bg-[var(--primary)] text-white hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            发送
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** chart 指令块 → 内嵌K线图 */
function ChartBlock({
  directive,
}: {
  directive: NonNullable<ReturnType<typeof splitChartSegments>[number]["directive"]>
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--border)] overflow-hidden">
      <div className="px-3 py-1.5 text-[10px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)]">
        {directive.title || `${directive.symbol.toUpperCase()} ${directive.period} 技术图`}
      </div>
      <div className="h-72">
        <AnchorChartRender
          symbol={directive.symbol}
          period={directive.period}
          limit={directive.limit}
          annotations={directive.annotations as AnchorAnnotations}
          reloadKey={JSON.stringify([directive.symbol, directive.period, directive.limit, directive.annotations])}
        />
      </div>
    </div>
  )
}
