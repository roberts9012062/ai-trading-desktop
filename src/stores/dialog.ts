/**
 * 全局命令式弹窗 store —— 替代原生 alert/confirm 的美化方案
 *
 * 用法（任何地方，无需 hook 上下文）：
 *   import { showAlert, showConfirm } from "@/stores/dialog"
 *   await showAlert({ title: "无法平仓", description: "当前非交易时段…" })
 *   if (await showConfirm({ title: "确认结束任务？", description: "将平掉持仓" })) { ... }
 *
 * 配合 <GlobalDialog />（挂载在根 layout）渲染统一的 Dialog UI。
 */

import { create } from "zustand"

type DialogVariant = "default" | "destructive"

interface DialogOptions {
  title?: string
  description?: string
  /** 风格：destructive 用红色确认键（删除/结束等危险操作） */
  variant?: DialogVariant
  confirmText?: string
  cancelText?: string
}

interface DialogState {
  open: boolean
  /** alert 模式只有确认键；confirm 模式有确认/取消 */
  mode: "alert" | "confirm"
  options: DialogOptions
  /** 解析当前弹窗的 Promise（确认=true，取消/关闭=false） */
  resolve: ((ok: boolean) => void) | null
  _show: (mode: "alert" | "confirm", options: DialogOptions) => Promise<boolean>
  _close: (ok: boolean) => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  open: false,
  mode: "alert",
  options: {},
  resolve: null,
  _show: (mode, options) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, mode, options, resolve })
    }),
  _close: (ok) => {
    const r = get().resolve
    set({ open: false, resolve: null })
    r?.(ok)
  },
}))

/** 显示一个 alert 弹窗（仅确认键），返回的 Promise 在关闭后 resolve */
export function showAlert(options: DialogOptions | string): Promise<void> {
  const opts =
    typeof options === "string" ? { description: options } : options
  return useDialogStore.getState()._show("alert", opts).then(() => undefined)
}

/** 显示一个 confirm 弹窗（确认/取消），resolve(true) 表示用户确认 */
export function showConfirm(options: DialogOptions | string): Promise<boolean> {
  const opts =
    typeof options === "string" ? { description: options } : options
  return useDialogStore.getState()._show("confirm", opts)
}
