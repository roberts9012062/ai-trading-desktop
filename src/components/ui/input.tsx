import * as React from "react"
import { cn } from "@/lib/utils"
import { NumericInput } from "./numeric-input"

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    const Component = type === "number" ? NumericInput : "input"
    return (
      <Component
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1 text-sm text-[var(--text-primary)] shadow-sm transition-colors",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "placeholder:text-[var(--text-muted)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
