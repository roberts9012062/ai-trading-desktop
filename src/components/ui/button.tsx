import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { withNumericReset, withNumericValidation } from "@/lib/numeric-input"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/90",
        destructive: "bg-[var(--destructive)] text-[var(--destructive-foreground)] hover:bg-[var(--destructive)]/90",
        outline: "border border-[var(--border)] bg-transparent hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]",
        secondary: "bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[var(--secondary)]/80",
        ghost: "hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]",
        link: "text-[var(--primary)] underline-offset-4 hover:underline",
        /** 买多按钮 - 红色 */
        buy: "bg-[var(--accent-up)] text-white hover:bg-[var(--accent-up)]/90 font-bold",
        /** 卖空按钮 - 绿色 */
        sell: "bg-[var(--accent-down)] text-white hover:bg-[var(--accent-down)]/90 font-bold",
        /** 平仓按钮 - 灰色 */
        close: "bg-[var(--text-muted)] text-white hover:bg-[var(--text-muted)]/80 font-bold",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        "trade-buy": "h-12 rounded-md px-8 text-lg",
        "trade-sell": "h-12 rounded-md px-8 text-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  validateNumbers?: boolean
  resetNumbers?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, validateNumbers = false, resetNumbers = false, onClick, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    const click = resetNumbers ? withNumericReset(onClick ?? (() => {})) : onClick
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
        onClick={validateNumbers ? withNumericValidation(click ?? (() => {})) : click}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
