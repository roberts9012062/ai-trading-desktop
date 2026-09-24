"use client"

/**
 * 历史回测页 —— 配置任务并查看报告
 *
 * 两种数据来源：
 * - 历史数据：原有同步回测（/api/backtest/run）
 * - AI 生成：LLM 剧本 + 程序化合成 K 线，边推边决策回放（过拟合测试）
 */

import { useState } from "react"
import { FlaskConical, Database, Sparkles, Cpu } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { BacktestForm } from "@/components/backtest/backtest-form"
import { BacktestReportView } from "@/components/backtest/backtest-report"
import {
  runBacktestApi,
  type BacktestReport,
  type BacktestRunPayload,
} from "@/lib/backtest-api"
import {
  runBacktestLocal,
  type LocalBacktestPayload,
} from "@/lib/local-backtest"
import {
  SyntheticPanel,
  type SyntheticReplayConfig,
} from "@/components/backtest/synthetic-panel"
import { SyntheticReplay } from "@/components/backtest/synthetic-replay"

type DataSource = "history" | "synthetic"

/** 历史回测主页面 */
export default function BacktestPage(): React.JSX.Element {
  const [dataSource, setDataSource] = useState<DataSource>("history")
  // 本地引擎(Pyodide):量化回测在本机计算;AI 策略自动走服务端
  const [localEngine, setLocalEngine] = useState(true)
  const [progressNote, setProgressNote] = useState<string | null>(null)

  // 历史回测状态
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<BacktestReport | null>(null)

  // AI 生成回放状态
  const [replayConfig, setReplayConfig] = useState<SyntheticReplayConfig | null>(null)

  async function handleRun(payload: BacktestRunPayload): Promise<void> {
    setSubmitting(true)
    setError(null)
    setProgressNote(null)
    try {
      // 本地引擎(Pyodide):量化策略在本机计算,后端零负载;AI 策略仍走服务端
      if (localEngine && String(payload.strategy_type || "") !== "ai") {
        const res = await runBacktestLocal(payload as LocalBacktestPayload, setProgressNote)
        setReport(res as unknown as BacktestReport)
      } else {
        const res = await runBacktestApi(payload)
        setReport(res)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "回测失败")
    } finally {
      setSubmitting(false)
      setProgressNote(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-sky-400" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            历史回测
          </h1>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          历史数据 · 量化全量回放 / AI 抽样决策 · 收盘价撮合 ·
          不占用真实模拟账户
        </p>
      </div>

      {/* 数据来源开关 */}
      <div className="mb-4 flex gap-2">
        <button
          type="button"
          onClick={() => setDataSource("history")}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            dataSource === "history"
              ? "bg-sky-500 text-white"
              : "border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          }`}
        >
          <Database className="w-3.5 h-3.5" />
          历史数据
        </button>
          <button
            type="button"
            onClick={() => setDataSource("synthetic")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              dataSource === "synthetic"
                ? "bg-sky-500 text-white"
                : "border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            }`}
          >
          <Sparkles className="w-3.5 h-3.5" />
          AI 生成 K 线
        </button>

        {/* 计算引擎:本地 Pyodide(不占服务器) / 服务端 */}
        <button
          type="button"
          onClick={() => setLocalEngine((v) => !v)}
          title="本地引擎:量化回测在你电脑上运行(首次加载内核约 6MB);AI 回测仍走服务端"
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            localEngine
              ? "bg-emerald-600 text-white"
              : "border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          }`}
        >
          <Cpu className="w-3.5 h-3.5" />
          {localEngine ? "本地引擎" : "服务端引擎"}
        </button>
      </div>

      {dataSource === "history" ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
          <Card className="xl:col-span-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">回测配置</CardTitle>
            </CardHeader>
            <CardContent>
              <BacktestForm submitting={submitting} onSubmit={(p) => void handleRun(p)} />
              {error && (
                <div className="mt-3 text-sm text-[var(--accent-danger)]">
                  {error}
                </div>
              )}
              {progressNote && (
                <div className="mt-3 text-sm text-emerald-400">{progressNote}</div>
              )}
            </CardContent>
          </Card>

          <Card className="xl:col-span-8 min-h-[480px]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">回测报告</CardTitle>
            </CardHeader>
            <CardContent>
              {!report && !submitting && (
                <div className="py-20 text-center text-sm text-[var(--text-muted)]">
                  选择品种、时间与策略后点击「开始回测」
                  <div className="mt-2 text-[11px]">
                    推荐：日线 + N 日突破 + 近 2 个月，先验证链路
                  </div>
                </div>
              )}
              {submitting && (
                <div className="py-20 text-center text-sm text-sky-300">
                  正在回放 K 线并模拟买卖，请稍候…
                </div>
              )}
              {report && !submitting && <BacktestReportView report={report} />}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
          <Card className="xl:col-span-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">AI 生成 K 线配置</CardTitle>
            </CardHeader>
            <CardContent>
              <SyntheticPanel
                onGenerated={(cfg) => setReplayConfig(cfg)}
                busy={!!replayConfig}
              />
            </CardContent>
          </Card>

          <Card className="xl:col-span-8 min-h-[480px]">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {replayConfig ? "边推边决策回放" : "回放预览"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!replayConfig && (
                <div className="py-20 text-center text-sm text-[var(--text-muted)]">
                  选择策略、AI 模型与周期后点击「生成 K 线」
                  <div className="mt-2 text-[11px]">
                    AI 只设计市场剧本，后端用随机过程生成 K 线，每次都是全新序列
                  </div>
                </div>
              )}
              {replayConfig && (
                <SyntheticReplay
                  key={replayConfig.generated.session_id}
                  config={replayConfig}
                  onReset={() => setReplayConfig(null)}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
