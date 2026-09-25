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

/** 因子实验室（client） */
export function FactorLabPage(): React.JSX.Element {
  const s = useFactorLabPage()
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
              ] as const
            ).map((o) => {
              const on = s.engine === o.value
              const disabled = o.value === "gpu" && gpuAvailable === false
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => s.setEngine(o.value)}
                  title={disabled ? `GPU 不可用:${gpuReason ?? "未探测到 WebGPU"}` : o.tip}
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
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          遗传规划挖因子；可选 LLM 教练进化（路线 A）或 LLM 直接生成（路线
          B）。结果自动进历史，可收藏后在 AI 交易选用。本地 GPU = WebGPU
          粗排 + 内核精算，对外指标与 CPU 同源。
        </p>
        {(s.progressNote || (s.loading && s.engine !== "server")) && (
          <div className="flex items-center gap-2 mt-1">
            {s.progressNote && (
              <p className="text-xs text-emerald-400">{s.progressNote}</p>
            )}
            {s.loading && s.engine !== "server" && (
              <button
                type="button"
                onClick={s.cancelLocalSearch}
                title="立即中止本地搜索/回测(终止本地计算线程,下次计算需重新加载内核)"
                className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                取消
              </button>
            )}
          </div>
        )}
      </div>

      <FactorLabGuide />

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
            onComboMount={(cs) => void s.handleComboMount(cs)}
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
    </div>
  )
}
