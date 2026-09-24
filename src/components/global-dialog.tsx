"use client"

/**
 * 全局弹窗渲染器 —— 挂载在根 layout，消费 useDialogStore 渲染统一 Dialog
 *
 * 业务代码只需调用 showAlert / showConfirm，无需各自管理 Dialog 状态。
 */

import { AlertTriangle, CheckCircle2, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useDialogStore } from "@/stores/dialog"
import { cn } from "@/lib/utils"

export function GlobalDialog(): React.JSX.Element {
  const { open, mode, options, _close } = useDialogStore()
  const variant = options.variant ?? "default"
  const isConfirm = mode === "confirm"

  return (
    <Dialog open={open} onOpenChange={(v) => !v && _close(false)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "shrink-0 mt-0.5",
                variant === "destructive"
                  ? "text-red-500"
                  : "text-[var(--primary)]",
              )}
            >
              {variant === "destructive" ? (
                <AlertTriangle className="w-5 h-5" />
              ) : isConfirm ? (
                <Info className="w-5 h-5" />
              ) : (
                <CheckCircle2 className="w-5 h-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              {options.title && (
                <DialogTitle className="text-base">
                  {options.title}
                </DialogTitle>
              )}
              {options.description && (
                <DialogDescription className="mt-1 whitespace-pre-line leading-relaxed">
                  {options.description}
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>
        <div className="flex justify-end gap-2 pt-2">
          {isConfirm && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => _close(false)}
            >
              {options.cancelText ?? "取消"}
            </Button>
          )}
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            size="sm"
            onClick={() => _close(true)}
          >
            {options.confirmText ?? (isConfirm ? "确认" : "知道了")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
