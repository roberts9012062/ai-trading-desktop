"use client"

/**
 * 因子实验室页面 —— 搜索 / 进化 / 历史 / 收藏 / LLM 生成
 */

import {
  FactorSearchForm,
  type SearchFormPayload,
} from "./factor-search-form"
import { Cpu, Zap } from "lucide-react"
import { ChampionTable } from "./champion-table"
import { FACTOR_HELP, FactorLabGuide, HelpTip } from "./help-tip"
import { HistoryPanel } from "./history/history-panel"
import { FavoritesPanel } from "./favorites/favorites-panel"
import { FactorFavoriteSaveDialog } from "./favorites/favorite-save-dialog"
import type { FavoriteInput } from "./hooks/use-factor-lab-page"
import { EvolveBar } from "./llm/evolve-bar"
import { GeneratePanel } from "./llm/generate-panel"
import { SelectedFactorPanel } from "./panels/selected-factor-panel"
import { PortfolioCard } from "./portfolio-card"
import { useFactorLabPage } from "./hooks/use-factor-lab-page"
import { useEffect, useMemo, useState } from "react"
import {
  championFromFavorite,
  championFromHistory,
} from "./hooks/factor-helpers"
import type { Champion } from "@/lib/factor-lab-api"
import type { AITradingTask } from "@/lib/ai-trading-api"
import { CreateQuantDialog } from "@/components/ai-trading/form/create-quant-dialog"
import type { LocalSearchStep } from "@/lib/local-factor"
import { useNativeAvailability } from "@/lib/native-engine/use-native-availability"
import { qualificationReasonLabel } from "@/lib/native-engine/progress"

/** 已收藏 tokens_key 集合（用于 Champion 表/详情/历史置灰） */
function buildFavoritedKeys(
  favorites: { tokens: number[] }[],
): Set<string> {
  const set = new Set<string>()
  for (const f of favorites) {
    if (f.tokens?.length) set.add(f.tokens.join(","))
  }
  return set
}

function fmtMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`
}

/** 本地挖掘进度卡片 —— 与超级因子任务卡同款信息(代数进度条 + 最优分 + 算力并行度)
 *  + 暂停/继续/停止控制(代边界生效;搜索在后台 runner 里跑,切页不断) */
function SearchProgressCard(props: {
  step: LocalSearchStep
  elapsedMs: number
  paused: boolean
  onPause: () => void
  onResume: () => void
  onStop: () => void
}): React.JSX.Element {
  const { step, elapsedMs, paused, onPause, onResume, onStop } = props
  const pct = Math.min(
    100,
    Math.round((step.generation / Math.max(1, step.totalGenerations)) * 100),
  )
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
              step.engine === "gpu"
                ? "bg-amber-500/15 text-amber-400"
                : "bg-emerald-600/15 text-emerald-400"
            }`}
          >
            {step.engine === "native-gpu" ? "原生 GPU · f64" : step.engine === "gpu" ? "GPU 粗排+精算" : "CPU 多核"}
          </span>
          {paused && (
            <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0 bg-amber-500/15 text-amber-400">
              已暂停 · 后台保留
            </span>
          )}
          <span className="font-medium text-[var(--text-primary)]">
            第 {step.generation}/{step.totalGenerations} 代
          </span>
          <span className="text-[var(--text-muted)] font-num truncate">
            当前最优 {step.bestComposite.toFixed(2)}
          </span>
        </div>
        <span className="text-[var(--text-muted)] font-num shrink-0">{pct}%</span>
      </div>
      {/* 进度条(与超级因子任务卡同款) */}
      <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div
          className="h-full bg-[var(--primary)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)] font-num flex-wrap">
        <span>
          {step.engine === "native-gpu" ? `${step.shardWorkers} SM · GPU 评估与精算` : step.shardWorkers > 0
            ? `${step.shardWorkers} 核并行评估`
            : "单进程(池不可用,已降级)"}
          {step.cacheHits > 0 &&
            ` · 缓存命中 ${step.cacheHits}/${step.evaluated}`}
        </span>
        <span>
          并行评估 {fmtMs(step.rankMs)} · {step.engine === "native-gpu" ? "GPU 精算" : "单点精算"} {fmtMs(step.preciseMs)} ·
          本代 {fmtMs(step.elapsedMs)} · 累计 {fmtMs(elapsedMs)}
        </span>
      </div>
      {step.qualificationCounts && <div className="text-[10px] text-[var(--text-muted)]">
        合格 {step.qualificationCounts.qualified} · 待封存揭示 {step.qualificationCounts.pending} · 未通过 {step.qualificationCounts.rejected}
      </div>}
      {/* 控制:暂停/继续/停止(代边界生效;切页后台继续) */}
      <div className="flex items-center gap-1.5 pt-0.5">
        {paused ? (
          <button
            type="button"
            onClick={onResume}
            title="从第 N 代继续，历史最优因子作为种子进入新种群"
            className="px-2 py-0.5 rounded text-[11px] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            继续
          </button>
        ) : (
          <button
            type="button"
            onClick={onPause}
            title="当前代算完后暂停；切到其他页面挖掘也在后台继续"
            className="px-2 py-0.5 rounded text-[11px] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            暂停
          </button>
        )}
        <button
          type="button"
          onClick={onStop}
          title="当前代算完后停止；已完成代的最优结果保留"
          className="px-2 py-0.5 rounded text-[11px] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-400 transition-colors"
        >
          停止
        </button>
        <span className="text-[10px] text-[var(--text-muted)]">
          切换页面不中断，后台持续挖掘
        </span>
      </div>
    </div>
  )
}

/** 因子实验室（client） */
export function FactorLabPage(): React.JSX.Element {
  const s = useFactorLabPage()
  const native = useNativeAvailability(s.engine === "native-gpu", s.nativePrecision)
  const favoritedKeys = useMemo(
    () => buildFavoritedKeys(s.favorites),
    [s.favorites],
  )
  // 收藏走弹窗：选文件夹（一级菜单）归类后再保存
  const [favPending, setFavPending] = useState<FavoriteInput | null>(null)
  // GPU 可用性探测(置灰「本地 GPU」并给出原因;探测失败不阻塞页面)
  const [gpuAvailable, setGpuAvailable] = useState<boolean | null>(null)
  const [gpuReason, setGpuReason] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void import("@/lib/mining/device")
      .then(({ probeGpu }) => probeGpu())
      .then((r) => {
        if (cancelled) return
        setGpuAvailable(r.available)
        setGpuReason(r.reason ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  const gpuTip =
    gpuAvailable === false
      ? `GPU 不可用:${gpuReason ?? "未探测到 WebGPU"}`
      : "WebGPU(f32)粗排 + 本地内核(f64)精算;搜索更快,指标口径与 CPU 一致"

  function championToFavoriteInput(c: {
    tokens: number[]
    text?: string
    composite?: number
    metrics?: unknown
  }): FavoriteInput {
    return {
      tokens: c.tokens,
      text: c.text ?? "",
      symbol: s.lastReq?.symbol ?? s.symbol,
      timeframe: s.lastReq?.timeframe ?? s.result?.timeframe ?? "",
      composite: Number(c.composite ?? 0),
      metrics: (c.metrics ?? {}) as FavoriteInput["metrics"],
      // metrics 宽松传入（Champion 为 FactorMetrics，结构兼容 Partial<FactorMetrics>）
    }
  }

  // 组合挂载走任务配置弹窗（与单因子任务同款配置；web fad6967 同款流程）。
  // 任务始终挂载服务器；数据能力由创建入口逐成员检查。
  const [comboPreset, setComboPreset] = useState<{
    symbol: string
    timeframe: string
    tokenGroups: number[][]
    texts: string[]
  } | null>(null)

  function openComboDialog(cs: Champion[]): void {
    if (cs.length < 2 || cs.length > 5) {
      s.setError("组合需勾选 2-5 个因子")
      return
    }
    const bad = cs.find((c) => c.metrics?.overfit_warning || c.metrics?.stale_kernel)
    if (bad) {
      s.setError("组合成员含未通过样本外验证或旧内核口径的因子，已禁止挂载")
      return
    }
    const symbol = s.lastReq?.symbol ?? s.symbol
    const timeframe = s.lastReq?.timeframe ?? s.result?.timeframe ?? "1d"
    if (!symbol) {
      s.setError("缺少品种信息，无法挂载")
      return
    }
    setComboPreset({
      symbol,
      timeframe,
      tokenGroups: cs.map((c) => c.tokens),
      texts: cs.map((c) => c.text ?? ""),
    })
  }

  // 服务器任务不依赖桌面端保持运行。
  async function afterComboCreated(task: AITradingTask): Promise<void> {
    s.setBuildMsg(`已创建服务器组合任务：${task.name}（到 AI 交易页启动，关闭桌面端后继续运行）`)
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            因子实验室
          </h1>
          {/* 计算引擎两态:本地 CPU / 本地 GPU(GPU 不可用置灰并提示);服务端引擎已下线 */}
          <div className="flex items-center gap-1">
            {(
              [
                { value: "cpu", label: "本地 CPU", tip: "GP 搜索在本机运行(内核与 numpy 已内置,秒级启动)" },
                { value: "gpu", label: "本地 GPU", tip: gpuTip },
                { value: "native-gpu", label: "本地 GPU（原生）", tip: native.reason ?? native.detail ?? "CUDA GPU 计算与 f64 权威精算；首次启动运行确定性自检" },
              ] as const
            ).map((o) => {
              const on = s.engine === o.value
              const disabled = (o.value === "gpu" && gpuAvailable === false) || (o.value === "native-gpu" && native.available === false)
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => s.setEngine(o.value)}
                  title={o.value === "native-gpu" ? o.tip : disabled ? `GPU 不可用:${gpuReason ?? "未探测到 WebGPU"}` : o.tip}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    on
                      ? "bg-emerald-600 text-white"
                      : "border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  }`}
                >
                  {o.value === "gpu" ? <Zap className="w-3.5 h-3.5" /> : <Cpu className="w-3.5 h-3.5" />}
                  {o.label}
                </button>
              )
            })}
          </div>
          {s.engine === "native-gpu" && <details className="text-xs text-[var(--text-secondary)]">
            <summary>原生精度选项</summary>
            <label className="flex items-center gap-2 mt-2">
              <input type="checkbox" checked={s.nativePrecision === "f64"} disabled={s.searchActive}
                onChange={event => s.setNativePrecision(event.target.checked ? "f64" : "mixed")} />
              Float64 严格模式（默认混合模式，两者均用 GPU f64 权威精算）
            </label>
            <p>{native.reason ?? native.detail ?? "首次启动需进行 GPU 自检与编译"}</p>
            {native.available === false && <button type="button" onClick={native.retry}>重新探测</button>}
          </details>}
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          遗传规划挖因子；可选 LLM 教练进化（路线 A）或 LLM 直接生成（路线
          B）。结果自动进历史，可收藏后在 AI 交易选用。本地 GPU = WebGPU
          粗排 + 内核精算，对外指标与 CPU 同源。
        </p>
        {(s.progressNote || s.searchActive || s.btLoading) && (
          <div className="flex items-center gap-2 mt-1">
            {s.progressNote && (
              <p className="text-xs text-emerald-400">{s.progressNote}</p>
            )}
            {s.searchActive && (
              <button
                type="button"
                onClick={s.stopSearch}
                title="当前代算完后停止；已完成代的最优结果保留"
                className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                停止
              </button>
            )}
            {s.btLoading && (
              <button
                type="button"
                onClick={s.cancelLocalSearch}
                title="立即中止本地回测(终止本地计算线程,下次计算需重新加载内核)"
                className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                取消
              </button>
            )}
          </div>
        )}
      </div>

      <FactorLabGuide />

      {/* 本地挖掘进度(与超级因子同款:代数/进度条/并行度 + 暂停/停止;
          后台 runner 驱动,切页不断;冷启动阶段只有上方文字提示) */}
      {(s.searchActive || s.bgTask?.status === "paused") && s.searchStep && (
        <SearchProgressCard
          step={s.searchStep}
          elapsedMs={s.searchElapsedMs}
          paused={s.bgTask?.status === "paused"}
          onPause={s.pauseSearch}
          onResume={s.resumeSearch}
          onStop={s.stopSearch}
        />
      )}
      {s.bgTask?.nativeRequested && s.bgTask.status === "completed" && s.searchStep?.qualificationCounts &&
        <div className="text-xs text-[var(--text-muted)] rounded border border-[var(--border)] p-3">
          合格冠军 {s.searchStep.qualificationCounts.qualified} · 未通过 {s.searchStep.qualificationCounts.rejected}
          {s.searchStep.qualificationReasons?.length ? <p className="mt-1">{s.searchStep.qualificationReasons.map(qualificationReasonLabel).join("；")}</p> : null}
        </div>}

      <FactorSearchForm
        localEngine={s.engine !== "server"}
        defaultSymbol={s.symbol}
        loading={s.loading}
        onSearch={(p) => void s.handleSearch(p)}
        onSymbolChange={s.setSymbol}
      />

      {s.error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {s.error}
        </div>
      )}

      {s.result && (
        <EvolveBar
          disabled={!s.result.champions.length}
          loading={s.loading}
          coachNote={s.result.coach_note ?? null}
          appliedSource={s.result.applied_config?.source ?? null}
          onEvolve={() => void s.handleEvolve()}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-[var(--text-secondary)] flex items-center gap-1">
            Champion 排行
            <HelpTip
              text={FACTOR_HELP.champion}
              side="bottom"
              align="center"
              className=""
            />
          </h2>
          {s.result && s.result.timeframe !== "1d" && (
            <div className="text-[11px] text-down">
              ⚠ 分钟级冠军的保守 OOS 普遍为负（7 品种 × 4 周期实测），
              慎挂实盘——详见 oos_conservative 与 session 指标
            </div>
          )}
          <ChampionTable
            champions={s.result?.champions ?? []}
            selectedTokens={s.selected?.tokens ?? null}
            onSelect={(c) => void s.selectFactor(c)}
            onFavorite={(c) => setFavPending(championToFavoriteInput(c))}
            favoritedKeys={favoritedKeys}
            onComboMount={(cs) => openComboDialog(cs)}
            comboSymbol={s.lastReq?.symbol ?? s.symbol ?? ""}
            comboTimeframe={s.lastReq?.timeframe ?? s.result?.timeframe ?? ""}
            superMembers={
              s.result?.portfolio?.super_passed && s.result.portfolio.members
                ? new Set(s.result.portfolio.members.map((m) => m.join(",")))
                : undefined
            }
          />
        </div>
        <SelectedFactorPanel
          selected={s.selected}
          bt={s.bt}
          btLoading={s.btLoading}
          building={s.building}
          buildMsg={s.buildMsg}
          favoritedKeys={favoritedKeys}
          onBuildTask={() => void s.handleBuildTask()}
          onFavorite={() => {
            if (s.selected) setFavPending(championToFavoriteInput(s.selected))
          }}
          onCopyTokens={() => {
            if (s.selected && navigator.clipboard) {
              void navigator.clipboard.writeText(s.selected.tokens.join(","))
              s.setBuildMsg("tokens 已复制")
            }
          }}
        />
      </div>

      {/* 历史/收藏一行两列(历史内容多占 2/3),LLM 生成表单全宽更舒展 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
        <HistoryPanel
          symbol={s.symbol}
          items={s.history}
          loading={s.histLoading}
          favoritedKeys={favoritedKeys}
          onSelect={(it) => {
            const c = championFromHistory(it)
            const base: SearchFormPayload = s.lastReq ?? {
              symbol: it.symbol,
              timeframe: it.timeframe,
              population: 30,
              generations: 15,
              top_n: 10,
              seed: 42,
              cost: null,
              use_llm_coach: false,
              model_row_id: null,
            }
            void s.selectFactor(c, {
              ...base,
              symbol: it.symbol,
              timeframe: it.timeframe,
            })
          }}
          onDelete={(id) => void s.deleteHistory(id)}
          onFavorite={(it) => setFavPending(it)}
          onRefresh={() => void s.refreshHistory(s.symbol)}
        />
        </div>
        <FavoritesPanel
          items={s.favorites}
          loading={s.favLoading}
          onSelect={(it) => {
            void s.selectFactor(championFromFavorite(it), {
              symbol: it.symbol || s.symbol,
              timeframe: it.timeframe || s.lastReq?.timeframe || "1d",
              population: 30,
              generations: 15,
              top_n: 10,
              seed: 42,
              cost: null,
              use_llm_coach: false,
              model_row_id: null,
            })
          }}
          onDelete={(id) => void s.deleteFavorite(id)}
          onRefresh={() => void s.refreshFavorites(s.symbol)}
        />
        <div className="lg:col-span-3 min-w-0">
        <GeneratePanel
          models={s.models}
          modelsLoading={s.modelsLoading}
          loading={s.genLoading}
          onGenerate={(p) => void s.handleGenerate(p)}
        />
        </div>
      </div>

      {s.result?.portfolio && <PortfolioCard portfolio={s.result.portfolio} />}
      {s.result && (
        <div className="text-[11px] text-[var(--text-muted)]">
          基于 {s.result.bars} 根 {s.result.timeframe} K 线 · 区间{" "}
          {s.result.range.from} ~ {s.result.range.to}
          {s.result.applied_config && (
            <>
              {" "}
              · 种群 {s.result.applied_config.population} · 代数{" "}
              {s.result.applied_config.generations}
              {s.result.applied_config.periods != null && (
                <> · 年化基数 {s.result.applied_config.periods} 根/年</>
              )}
              {s.result.applied_config.cost != null && (
                <>
                  {" "}
                  · 单边成本{" "}
                  {(s.result.applied_config.cost * 10000).toFixed(2)}bp
                  {s.result.applied_config.cost_auto === true ? "（按品种）" : ""}
                </>
              )}
            </>
          )}
        </div>
      )}
      <FactorFavoriteSaveDialog
        item={favPending}
        defaultName={favPending ? s.defaultFavoriteName(favPending) : ""}
        onClose={() => setFavPending(null)}
        onSave={(item, opts) => s.saveFavorite(item, opts)}
      />
      {/* 组合挂载 → 任务配置弹窗（与单因子任务同款） */}
      <CreateQuantDialog
        open={comboPreset !== null}
        onClose={() => setComboPreset(null)}
        comboPreset={comboPreset}
        onCreated={(task) => void afterComboCreated(task)}
      />
    </div>
  )
}
