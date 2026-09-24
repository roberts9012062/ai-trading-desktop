"use client"

/**
 * K 线画图层主 hook
 *
 * 职责：
 * 1. 在 K 线容器上叠一层 <canvas>，并随容器尺寸自适应；
 * 2. 监听 K 线 visible range / crosshair / 自身 pointer 事件，触发重绘；
 * 3. 处理绘制流程（按下→拖动→松开）与命中选中/删除；
 * 4. 双击 K 线切出/收起工具栏。
 *
 * 完全只读 IChartApi/ISeriesApi（仅坐标转换），绝不调用 setData/update，
 * 因此 K 线渲染、走势、指标、挂单线/持仓线均不受影响。
 *
 * 仿照 use-order-lines.ts 的入参范式：依赖 chartReady/seriesReady 串联时序。
 */

import { useEffect, useRef, type MutableRefObject } from "react"
import type { IChartApi, ISeriesApi, Logical } from "lightweight-charts"
import type { KlinePeriod } from "@/types"
import { useDrawingStore, createDrawShape } from "@/stores/drawing"
import { useContractSpecStore } from "@/stores/contract-spec"
import type { DrawAnchor, DrawShape } from "./draw-types"
import {
  drawAllShapes,
  drawPreview,
  hitTestHandle,
  hitTestShapes,
  pixelToAnchor,
  type Pixel,
} from "./render"

const CANVAS_CLASS = "qihuo-drawing-overlay"
const CANVAS_Z_INDEX = 30

/** hook 入参（与 useTradeLines 同范式） */
export interface DrawingOverlayProps {
  chartRef: MutableRefObject<IChartApi | null>
  seriesRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>
  /** K 线图主容器（canvas 叠在这个 div 上） */
  containerRef: MutableRefObject<HTMLDivElement | null>
  symbol: string
  period: KlinePeriod
  chartReady: number
  seriesReady: number
}

export function useDrawingOverlay(props: DrawingOverlayProps): void {
  const { chartRef, seriesRef, containerRef, symbol, period, chartReady, seriesReady } = props

  // canvas DOM 与 ctx 引用
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  // rAF 节流句柄
  const rafRef = useRef<number | null>(null)
  // 绘制/编辑中的临时状态
  const drawingStateRef = useRef<{
    /** 是否正在交互（画新线或编辑拖拽） */
    active: boolean
    /** drawing=画新线；editing=拖拽编辑现有图形 */
    mode: "drawing" | "editing"
    /** 画新线时的起点 */
    startAnchor: DrawAnchor | null
    currentPx: Pixel | null
    shiftHeld: boolean
    /** 编辑模式：拖拽的图形 id */
    editingShapeId: string | null
    /** 编辑模式：拖哪个句柄（0/1=端点，body=线身） */
    editingHandle: 0 | 1 | "body" | null
    /** 编辑模式 body 平移：拖动起点的像素 + 原始 anchors（用于计算偏移） */
    dragStartPx: Pixel | null
    dragStartAnchors: [DrawAnchor, DrawAnchor] | null
  }>({
    active: false,
    mode: "drawing",
    startAnchor: null,
    currentPx: null,
    shiftHeld: false,
    editingShapeId: null,
    editingHandle: null,
    dragStartPx: null,
    dragStartAnchors: null,
  })

  /** 调度一次重绘（rAF 合并） */
  const scheduleRedrawRef = useRef<() => void>(() => {})

  // ============ 主 effect：创建 canvas + 绑定事件 ============
  useEffect(() => {
    if (chartReady === 0) return
    const container = containerRef.current
    const chart = chartRef.current
    if (!container || !chart) return

    // 创建 canvas（仅一次）
    let canvas = container.querySelector<HTMLCanvasElement>(`.${CANVAS_CLASS}`)
    if (!canvas) {
      canvas = document.createElement("canvas")
      canvas.className = CANVAS_CLASS
      canvas.style.position = "absolute"
      canvas.style.inset = "0"
      canvas.style.zIndex = String(CANVAS_Z_INDEX)
      canvas.style.pointerEvents = "none"
      container.appendChild(canvas)
    }
    canvasRef.current = canvas
    const ctx = canvas.getContext("2d")
    if (ctx) ctxRef.current = ctx

    // ---- 内部工具函数（闭包内定义，避免 TDZ/前向引用问题） ----
    const getSize = (): { width: number; height: number } => {
      const dpr = window.devicePixelRatio || 1
      return { width: canvas!.width / dpr, height: canvas!.height / dpr }
    }

    /** 按品种 tick 吸附价格（平移结果保持 tick 整数倍） */
    const snapPrice = (price: number): number => {
      const tick = useContractSpecStore.getState().getTickSize(symbol)
      if (tick > 0 && tick !== 1) {
        return Number((Math.round(price / tick) * tick).toFixed(10))
      }
      return Math.round(price)
    }

    /**
     * 线身平移：把两端从起点像素位置平移到当前像素位置。
     * 用 logical 偏移（兼容日线 string time），price 偏移用 series 坐标差。
     */
    const computeBodyTranslation = (
      startPx: Pixel,
      currentPx: Pixel,
      a0: DrawAnchor,
      a1: DrawAnchor,
      chartNow: IChartApi,
      series: ISeriesApi<"Candlestick">,
    ): [DrawAnchor, DrawAnchor] => {
      const ts = chartNow.timeScale()
      const dxPx = currentPx.x - startPx.x
      const dyPx = currentPx.y - startPx.y
      // 时间偏移：用 timeToCoordinate + coordinateToLogical 组合得到 logical
      const coord0 = ts.timeToCoordinate(a0.time)
      const coord1 = ts.timeToCoordinate(a1.time)
      const logical0 = coord0 !== null ? ts.coordinateToLogical(coord0) : null
      const logical1 = coord1 !== null ? ts.coordinateToLogical(coord1) : null
      const stepPerPx = stepLogicalPerPixel(chartNow)
      let newTime0: DrawAnchor["time"] = a0.time
      let newTime1: DrawAnchor["time"] = a1.time
      if (logical0 !== null) {
        const newLogical0 = (logical0 as number) + dxPx * stepPerPx
        newTime0 = logicalToTime(chartNow, newLogical0) ?? a0.time
      }
      if (logical1 !== null) {
        const newLogical1 = (logical1 as number) + dxPx * stepPerPx
        newTime1 = logicalToTime(chartNow, newLogical1) ?? a1.time
      }
      // 价格偏移：用 series.priceToCoordinate / coordinateToPrice 反推每像素价格
      const price0 = a0.price
      const price1 = a1.price
      const refY = series.priceToCoordinate(price0)
      let newPrice0 = price0
      let newPrice1 = price1
      if (refY !== null) {
        const newPrice0Raw = series.coordinateToPrice(refY + dyPx)
        if (newPrice0Raw !== null && Number.isFinite(newPrice0Raw)) {
          const dPrice = newPrice0Raw - price0
          newPrice0 = newPrice0Raw
          newPrice1 = price1 + dPrice
        }
      }
      return [
        { time: newTime0, price: snapPrice(newPrice0) },
        { time: newTime1, price: snapPrice(newPrice1) },
      ]
    }

    /** 每像素对应的 logical 步长（barSpacing 的倒数） */
    const stepLogicalPerPixel = (chartNow: IChartApi): number => {
      const ts = chartNow.timeScale()
      const range = ts.getVisibleLogicalRange()
      const width = ts.width()
      if (!range || width <= 0) return 0.125 // 默认假设
      const bars = (range.to as number) - (range.from as number)
      return bars > 0 ? bars / width : 0.125
    }

    /** logical → time（吸附到最近有效 K 线，复用 pixelToAnchor 的搜索思路） */
    const logicalToTime = (
      chartNow: IChartApi,
      logicalNum: number,
    ): DrawAnchor["time"] | null => {
      const ts = chartNow.timeScale()
      const target = Math.round(logicalNum)
      for (let offset = 0; offset <= 50; offset++) {
        for (const candidate of [target - offset, target + offset]) {
          if (candidate < 0) continue
          const coord = ts.logicalToCoordinate(candidate as unknown as Logical)
          if (coord === null) continue
          const t = ts.coordinateToTime(coord) as DrawAnchor["time"] | null
          if (t !== null) return t
        }
      }
      return null
    }

    const syncInteractionMode = (): void => {
      if (!canvas) return
      const tool = useDrawingStore.getState().tool
      if (tool === "cursor") {
        // 光标模式：默认不拦截，hover 检测会动态切换 pe
        canvas.style.pointerEvents = "none"
        canvas.style.cursor = "default"
      } else {
        canvas.style.pointerEvents = "auto"
        canvas.style.cursor = "crosshair"
      }
    }

    const resizeCanvas = (): void => {
      if (!canvas) return
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.floor(rect.width))
      const h = Math.max(1, Math.floor(rect.height))
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
        const c = canvas.getContext("2d")
        if (c) {
          c.setTransform(dpr, 0, 0, dpr, 0, 0)
          ctxRef.current = c
        }
      }
      scheduleRedraw()
    }

    const redrawNow = (): void => {
      const chartNow = chartRef.current
      const series = seriesRef.current
      const c = ctxRef.current
      if (!chartNow || !series || !c || !canvas) return

      const size = getSize()
      const state = useDrawingStore.getState()
      const group = state.getGroup(symbol, period)
      const ds = drawingStateRef.current

      c.clearRect(0, 0, size.width, size.height)

      // 隐藏时不画已有图形，但保留绘制中预览（体验）
      if (group.visible) {
        drawAllShapes(c, chartNow, series, group.shapes, {
          size,
          selectedId: state.selectedId,
          decimalPlaces: useContractSpecStore.getState().getDecimalPlaces(symbol),
        })
      }

      // 绘制中预览
      if (ds.active && ds.startAnchor && ds.currentPx && state.tool !== "cursor") {
        const previewShape: DrawShape = {
          id: "__preview__",
          tool: state.tool as DrawShape["tool"],
          color: state.color,
          width: state.width,
          anchors: [
            ds.startAnchor,
            { time: ds.startAnchor.time, price: ds.startAnchor.price },
          ],
          createdAt: 0,
        }
        drawPreview(c, chartNow, series, previewShape, ds.startAnchor, ds.currentPx, size)
      }
    }

    const scheduleRedraw = (): void => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        redrawNow()
      })
    }
    scheduleRedrawRef.current = scheduleRedraw

    const finishDrawing = (): void => {
      const ds = drawingStateRef.current
      if (!ds.active || !ds.startAnchor || !ds.currentPx) {
        ds.active = false
        ds.startAnchor = null
        ds.currentPx = null
        return
      }
      const state = useDrawingStore.getState()
      const chartNow = chartRef.current
      const series = seriesRef.current
      const startAnchor = ds.startAnchor
      const endPx = ds.currentPx
      const shiftHeld = ds.shiftHeld
      ds.active = false
      ds.startAnchor = null
      ds.currentPx = null
      if (!chartNow || !series) return

      const endAnchor = pixelToAnchor(endPx, chartNow, series, useContractSpecStore.getState().getTickSize(symbol))
      if (!endAnchor) {
        scheduleRedraw()
        return
      }
      // 防止两点重合（无意义）
      if (endAnchor.time === startAnchor.time && endAnchor.price === startAnchor.price) {
        scheduleRedraw()
        return
      }
      const shape = createDrawShape(
        state.tool as DrawShape["tool"],
        state.color,
        state.width,
        [startAnchor, endAnchor],
      )
      state.addShape(symbol, period, shape)
      // Shift 连续画；否则回到光标
      if (!shiftHeld) {
        state.setTool("cursor")
        state.setSelected(null)
      }
      syncInteractionMode()
      scheduleRedraw()
    }

    // ---- 事件处理 ----
    const onPointerDown = (e: PointerEvent): void => {
      const state = useDrawingStore.getState()
      const chartNow = chartRef.current
      const series = seriesRef.current
      if (!chartNow || !series) return
      const rect = canvas!.getBoundingClientRect()
      const px: Pixel = { x: e.clientX - rect.left, y: e.clientY - rect.top }

      // cursor 模式：尝试拖拽编辑（命中端点/线身才进入）
      if (state.tool === "cursor") {
        const group = state.getGroup(symbol, period)
        if (!group.visible) return
        const hit = hitTestHandle(group.shapes, px, chartNow, series, getSize())
        if (!hit) return // 未命中：不拦截，让 K 线接收（pe 已是 none）
        const shape = group.shapes.find((s) => s.id === hit.shapeId)
        if (!shape) return
        const ds = drawingStateRef.current
        ds.active = true
        ds.mode = "editing"
        ds.editingShapeId = hit.shapeId
        ds.editingHandle = hit.handle
        ds.currentPx = px
        ds.dragStartPx = px
        // 深拷贝原始 anchors 作为平移基准
        ds.dragStartAnchors = [
          { ...shape.anchors[0] },
          { ...shape.anchors[1] },
        ]
        state.setSelected(hit.shapeId)
        // 拖拽期间锁定 pe=auto
        if (canvas) canvas.style.pointerEvents = "auto"
        scheduleRedraw()
        return
      }

      // 画图工具激活：画新线
      const anchor = pixelToAnchor(px, chartNow, series, useContractSpecStore.getState().getTickSize(symbol))
      if (!anchor) return
      const ds = drawingStateRef.current
      ds.active = true
      ds.mode = "drawing"
      ds.startAnchor = anchor
      ds.currentPx = px
      ds.shiftHeld = e.shiftKey
      scheduleRedraw()
    }

    const onPointerMove = (e: PointerEvent): void => {
      const rect = canvas!.getBoundingClientRect()
      const px: Pixel = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const ds = drawingStateRef.current

      // 编辑中：实时更新端点或平移
      if (ds.active && ds.mode === "editing") {
        const chartNow = chartRef.current
        const series = seriesRef.current
        const state = useDrawingStore.getState()
        if (!chartNow || !series || !ds.editingShapeId || !ds.dragStartAnchors) return
        const [a0, a1] = ds.dragStartAnchors
        let newAnchors: [DrawAnchor, DrawAnchor]
        if (ds.editingHandle === 0 || ds.editingHandle === 1) {
          // 拖端点：转换当前 px 为 anchor（按品种 tick 吸附），替换对应端点
          const newAnchor = pixelToAnchor(px, chartNow, series, useContractSpecStore.getState().getTickSize(symbol))
          if (!newAnchor) return
          newAnchors = ds.editingHandle === 0 ? [newAnchor, a1] : [a0, newAnchor]
        } else {
          // 拖线身：按 logical 偏移平移两端（dragStartPx 在 editing 进入时已设置）
          newAnchors = computeBodyTranslation(
            ds.dragStartPx ?? px,
            px,
            a0,
            a1,
            chartNow,
            series,
          )
        }
        state.updateShapeAnchors(symbol, period, ds.editingShapeId, newAnchors)
        ds.currentPx = px
        return
      }

      // 画新线中：更新预览
      if (ds.active && ds.mode === "drawing") {
        ds.currentPx = px
        scheduleRedraw()
        return
      }

      // 非交互态 + cursor 模式：hover 检测，动态切 pe 与光标
      const state = useDrawingStore.getState()
      if (state.tool === "cursor" && canvas) {
        updateHoverCursor(state, px)
      }
    }

    /** cursor 模式 hover：根据是否命中图形动态切换 canvas pe 与鼠标样式 */
    const updateHoverCursor = (state: ReturnType<typeof useDrawingStore.getState>, px: Pixel): void => {
      if (!canvas) return
      const chartNow = chartRef.current
      const series = seriesRef.current
      if (!chartNow || !series) {
        canvas.style.pointerEvents = "none"
        canvas.style.cursor = "default"
        return
      }
      const group = state.getGroup(symbol, period)
      if (!group.visible) {
        canvas.style.pointerEvents = "none"
        canvas.style.cursor = "default"
        return
      }
      const hit = hitTestHandle(group.shapes, px, chartNow, series, getSize())
      if (!hit) {
        // 未命中：让 K 线接收事件
        canvas.style.pointerEvents = "none"
        canvas.style.cursor = "default"
      } else {
        canvas.style.pointerEvents = "auto"
        canvas.style.cursor = hit.handle === "body" ? "move" : "crosshair"
      }
    }

    const onPointerUp = (): void => {
      const ds = drawingStateRef.current
      if (!ds.active) return
      if (ds.mode === "drawing") {
        finishDrawing()
      } else if (ds.mode === "editing") {
        // 编辑结束：清除态，pe 由下一个 pointermove 的 hover 重新决定
        ds.active = false
        ds.mode = "drawing"
        ds.editingShapeId = null
        ds.editingHandle = null
        ds.dragStartPx = null
        ds.dragStartAnchors = null
        ds.currentPx = null
        // 临时让 K 线恢复，hover 会再次精确切换
        if (canvas) canvas.style.pointerEvents = "none"
        scheduleRedraw()
      }
    }

    /** 光标模式下点击空白取消选中；点击图形选中（拖拽由 pointerdown 处理） */
    const onClickSelect = (e: MouseEvent): void => {
      const state = useDrawingStore.getState()
      if (state.tool !== "cursor") return
      const chartNow = chartRef.current
      const series = seriesRef.current
      if (!chartNow || !series) return
      const rect = canvas!.getBoundingClientRect()
      const px: Pixel = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const group = state.getGroup(symbol, period)
      const hit = hitTestShapes(group.shapes, px, chartNow, series, getSize())
      state.setSelected(hit)
      scheduleRedraw()
    }

    /** 双击切出/收起工具栏 */
    const onDblClick = (): void => {
      useDrawingStore.getState().toggleToolbar()
    }

    /** Esc 取消正在画的线 / 取消编辑并恢复；Delete 删除选中 */
    const onKeyDown = (e: KeyboardEvent): void => {
      const state = useDrawingStore.getState()
      if (e.key === "Escape") {
        const ds = drawingStateRef.current
        if (ds.active) {
          // 编辑中按 Esc：恢复原始 anchors
          if (ds.mode === "editing" && ds.editingShapeId && ds.dragStartAnchors) {
            state.updateShapeAnchors(symbol, period, ds.editingShapeId, ds.dragStartAnchors)
          }
          ds.active = false
          ds.mode = "drawing"
          ds.startAnchor = null
          ds.currentPx = null
          ds.editingShapeId = null
          ds.editingHandle = null
          ds.dragStartPx = null
          ds.dragStartAnchors = null
          if (canvas) canvas.style.pointerEvents = "none"
          scheduleRedraw()
        } else if (state.selectedId) {
          state.setSelected(null)
          scheduleRedraw()
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId) {
        // 仅在工具栏可见时响应，避免误删
        if (state.toolbarVisible) {
          e.preventDefault()
          state.removeSelected(symbol, period)
          scheduleRedraw()
        }
      }
    }

    canvas.addEventListener("pointerdown", onPointerDown)
    // pointermove 绑定到容器：cursor 模式下 canvas pe=none 时事件穿透，
    // 绑 canvas 收不到 hover；绑 container 才能持续 hover 检测来动态切 pe。
    container.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    // click / dblclick 绑定到容器（始终接收事件），而非 canvas：
    // cursor 模式下 canvas pointer-events=none，绑在 canvas 上会收不到 dblclick，
    // 导致工具栏切出后无法再次双击收起。
    container.addEventListener("click", onClickSelect)
    container.addEventListener("dblclick", onDblClick)
    window.addEventListener("keydown", onKeyDown)

    // ---- K 线事件：视口/十字线变化时重绘 ----
    const rangeHandler = (): void => scheduleRedraw()
    const crosshairHandler = (): void => scheduleRedraw()
    chart.timeScale().subscribeVisibleLogicalRangeChange(rangeHandler)
    chart.subscribeCrosshairMove(crosshairHandler)

    // ---- 容器尺寸监听 ----
    const ro = new ResizeObserver(() => resizeCanvas())
    ro.observe(container)

    // ---- store 变化时同步交互模式 + 重绘 ----
    const unsub = useDrawingStore.subscribe(() => {
      syncInteractionMode()
      scheduleRedraw()
    })

    // 初始化
    resizeCanvas()
    syncInteractionMode()
    scheduleRedraw()

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown)
      container.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      container.removeEventListener("click", onClickSelect)
      container.removeEventListener("dblclick", onDblClick)
      window.removeEventListener("keydown", onKeyDown)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rangeHandler)
      chart.unsubscribeCrosshairMove(crosshairHandler)
      ro.disconnect()
      unsub()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
    // chartReady/seriesReady 触发重新绑定；symbol/period 变化需重新读取 group
  }, [chartReady, seriesReady, symbol, period])

  // chartReady/seriesReady 变化时补一次重绘（series 刚 ready）
  useEffect(() => {
    scheduleRedrawRef.current()
  }, [chartReady, seriesReady, symbol, period])
}
