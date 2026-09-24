import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]",
        secondary: "border-transparent bg-[var(--secondary)] text-[var(--secondary-foreground)]",
        destructive: "border-transparent bg-[var(--destructive)] text-[var(--destructive-foreground)]",
        outline: "border-[var(--border)] text-[var(--text-secondary)]",
        /** 涨 */
        up: "border-transparent bg-[var(--accent-up)]/20 text-[var(--accent-up)]",
        /** 跌 */
        down: "border-transparent bg-[var(--accent-down)]/20 text-[var(--accent-down)]",
        /** 平 */
        flat: "border-transparent bg-[var(--text-muted)]/20 text-[var(--text-muted)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
