import { forwardRef, type CSSProperties } from "react"
import { Award, BrainCircuit, ChartNoAxesCombined, RefreshCw, ScanLine, ShieldCheck, Upload } from "lucide-react"
import { Button, type ButtonProps } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const ACTIONS = {
  lock: { label: "锁利设置", icon: ShieldCheck, color: "#f8d483" },
  refresh: { label: "刷新", icon: RefreshCw, color: "#a5b4c5" },
  favorite: { label: "创建优秀任务", icon: Award, color: "#f8d483" },
  import: { label: "任务导入", icon: Upload, color: "#a5b4c5" },
  quant: { label: "创建量化交易", icon: ChartNoAxesCombined, color: "#8dbbff" },
  ai: { label: "创建 AI 交易", icon: BrainCircuit, color: "#66e4d3" },
  hunter: { label: "创建多周期猎手", icon: ScanLine, color: "#c0a2fb" },
} as const

interface TradingActionButtonProps extends Omit<ButtonProps, "variant" | "size"> {
  action: keyof typeof ACTIONS
  busy?: boolean
}

/** Visual treatment only: callers retain their existing handlers and disabled rules. */
export const TradingActionButton = forwardRef<HTMLButtonElement, TradingActionButtonProps>(
  ({ action, busy = false, className, style, children, ...props }, ref) => {
    const { label, icon: Icon, color } = ACTIONS[action]
    return <Button
      ref={ref}
      type="button"
      variant="outline"
      className={cn("trading-action", action === "ai" && "trading-action-primary", className)}
      style={{ "--action-color": color, ...style } as CSSProperties}
      aria-busy={busy || undefined}
      {...props}
    >
      <span className="trading-action-icon" aria-hidden="true">
        <Icon size={16} strokeWidth={1.8} className={busy ? "motion-safe:animate-spin" : undefined} />
      </span>
      <span>{children ?? label}</span>
    </Button>
  },
)
TradingActionButton.displayName = "TradingActionButton"
