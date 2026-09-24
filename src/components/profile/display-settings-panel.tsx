"use client"

/**
 * 显示设置 —— 界面字号 / K线涨跌颜色自定义（照顾年长投资者与个人习惯）
 */

import { useEffect } from "react"
import { CandlestickChart, RotateCcw, Type } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { FONT_SIZE_OPTIONS, type FontSizeLevel } from "@/lib/font-size"
import {
  KLINE_COLOR_PRESETS,
  normalizeHexColor,
} from "@/lib/kline-colors"
import { useDisplayStore } from "@/stores/display"

/** 迷你蜡烛预览：涨/跌各一根 */
function CandlePreview({ up, down }: { up: string; down: string }): React.JSX.Element {
  return (
    <div className="flex items-end gap-2 h-8">
      <div className="relative w-2.5 h-8" title="涨">
        <div
          className="absolute left-1/2 top-0 bottom-0 w-[2px] -translate-x-1/2"
          style={{ backgroundColor: up }}
        />
        <div
          className="absolute left-0 right-0 top-1.5 bottom-1.5 border"
          style={{ backgroundColor: up, borderColor: up }}
        />
      </div>
      <div className="relative w-2.5 h-8" title="跌">
        <div
          className="absolute left-1/2 top-0 bottom-0 w-[2px] -translate-x-1/2"
          style={{ backgroundColor: down }}
        />
        <div
          className="absolute left-0 right-0 top-1 bottom-2.5 border"
          style={{ backgroundColor: down, borderColor: down }}
        />
      </div>
    </div>
  )
}

/** 显示设置面板 */
export function DisplaySettingsPanel(): React.JSX.Element {
  const fontSize = useDisplayStore((s) => s.fontSize)
  const hydrated = useDisplayStore((s) => s.hydrated)
  const candleUp = useDisplayStore((s) => s.candleUp)
  const candleDown = useDisplayStore((s) => s.candleDown)
  const hydrate = useDisplayStore((s) => s.hydrate)
  const setFontSize = useDisplayStore((s) => s.setFontSize)
  const setCandleColors = useDisplayStore((s) => s.setCandleColors)
  const resetCandleColors = useDisplayStore((s) => s.resetCandleColors)

  useEffect(() => {
    if (!hydrated) {
      hydrate()
    }
  }, [hydrated, hydrate])

  const colorsChanged =
    candleUp !== KLINE_COLOR_PRESETS[0].up || candleDown !== KLINE_COLOR_PRESETS[0].down

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          显示设置
        </h2>
        <p className="text-xs text-[var(--text-muted)] mt-1">
          调整界面文字大小与K线涨跌颜色，设置保存在本机浏览器，下次打开自动生效。
        </p>
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Type className="w-4 h-4 text-[var(--primary)]" />
            <p className="text-sm font-medium text-[var(--text-primary)]">
              界面字号
            </p>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            推荐年长投资者使用「大」或「特大」，行情数字与菜单会同步放大。
          </p>
          <Separator />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FONT_SIZE_OPTIONS.map((opt) => {
              const active = fontSize === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFontSize(opt.value as FontSizeLevel)}
                  className={cn(
                    "text-left rounded-md border px-3 py-3 transition-colors cursor-pointer",
                    active
                      ? "border-[var(--primary)] bg-[var(--primary)]/15"
                      : "border-[var(--border)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)]",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "font-medium text-[var(--text-primary)]",
                        opt.previewClass,
                      )}
                    >
                      {opt.label}
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)] font-num shrink-0">
                      {opt.rootPx}px
                    </span>
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-1 leading-snug">
                    {opt.description}
                  </p>
                  {active && (
                    <p className="text-[11px] text-[var(--primary)] mt-1.5">
                      当前使用
                    </p>
                  )}
                </button>
              )
            })}
          </div>

          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-3">
            <p className="text-xs text-[var(--text-muted)] mb-2">预览效果</p>
            <p className="text-[var(--text-primary)]">
              螺纹钢 rb2610　最新价{" "}
              <span className="font-num text-up">3,147</span>
            </p>
            <p className="text-[var(--text-secondary)] mt-1">
              菜单 · 委托 · 持仓 · AI 交易
            </p>
          </div>
        </CardContent>
      </Card>

      {/* K线涨跌颜色 */}
      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <CandlestickChart className="w-4 h-4 text-[var(--primary)]" />
            <p className="text-sm font-medium text-[var(--text-primary)]">
              K线涨跌颜色
            </p>
            {colorsChanged && (
              <button
                type="button"
                onClick={resetCandleColors}
                className="ml-auto flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--primary)] cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                恢复默认
              </button>
            )}
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            自定义阳线（涨）/阴线（跌）颜色，行情页K线、AI主播图解与回测图表同步生效。
          </p>
          <Separator />

          {/* 预设配色 */}
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)]">预设配色</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {KLINE_COLOR_PRESETS.map((preset) => {
                const active = candleUp === preset.up && candleDown === preset.down
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setCandleColors(preset.up, preset.down)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md border px-3 py-2.5 transition-colors cursor-pointer",
                      active
                        ? "border-[var(--primary)] bg-[var(--primary)]/15"
                        : "border-[var(--border)] bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)]",
                    )}
                  >
                    <CandlePreview up={preset.up} down={preset.down} />
                    <span className="text-xs text-[var(--text-primary)]">{preset.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 自定义取色 */}
          <div className="space-y-2">
            <p className="text-xs text-[var(--text-muted)]">自定义颜色</p>
            <div className="flex flex-wrap items-center gap-3">
              {(
                [
                  { key: "up", label: "阳线（涨）", value: candleUp, other: candleDown },
                  { key: "down", label: "阴线（跌）", value: candleDown, other: candleUp },
                ] as const
              ).map((item) => (
                <label
                  key={item.key}
                  className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 cursor-pointer"
                >
                  <input
                    type="color"
                    value={item.value}
                    onChange={(e) => {
                      const next = normalizeHexColor(e.target.value)
                      if (!next) return
                      setCandleColors(
                        item.key === "up" ? next : item.other,
                        item.key === "down" ? next : item.other,
                      )
                    }}
                    className="w-7 h-7 rounded cursor-pointer bg-transparent border-0 p-0"
                  />
                  <span className="text-xs text-[var(--text-secondary)]">{item.label}</span>
                  <span className="text-[10px] font-num text-[var(--text-muted)]">
                    {item.value}
                  </span>
                </label>
              ))}
              <CandlePreview up={candleUp} down={candleDown} />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
