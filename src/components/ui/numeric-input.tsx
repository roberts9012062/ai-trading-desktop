import * as React from "react"
import { numericInputError, registerNumericReset } from "@/lib/numeric-input"

/** A text draft keeps deletion, decimal points and minus signs editable. */
export const NumericInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ value, defaultValue, onChange, onFocus, onBlur, onKeyDown, min, max, step, required, type: _type, ...props }, forwardedRef) => {
    const [draft, setDraft] = React.useState(String(value ?? defaultValue ?? ""))
    const [showError, setShowError] = React.useState(false)
    const editing = React.useRef(false)
    const node = React.useRef<HTMLInputElement | null>(null)
    const mandatory = required ?? typeof (value ?? defaultValue) === "number"
    const error = numericInputError(draft, { min, max, step, required: mandatory })

    React.useEffect(() => {
      if (value !== undefined && !editing.current) {
        setDraft(String(value))
        setShowError(false)
      }
    }, [value])
    React.useLayoutEffect(() => { node.current?.setCustomValidity(error) }, [error])
    React.useLayoutEffect(() => {
      if (!node.current) return
      return registerNumericReset(node.current, () => {
        editing.current = false
        setDraft(String(value ?? defaultValue ?? ""))
        setShowError(false)
      })
    }, [value, defaultValue])

    return <input
      {...props}
      ref={element => {
        node.current = element
        if (typeof forwardedRef === "function") forwardedRef(element)
        else if (forwardedRef) forwardedRef.current = element
      }}
      type="text"
      inputMode={props.inputMode ?? "decimal"}
      data-numeric-input=""
      required={mandatory}
      value={draft}
      aria-invalid={showError && Boolean(error) ? true : props["aria-invalid"]}
      title={showError && error ? error : props.title}
      className={[props.className, showError && error ? "border-[var(--accent-danger)] ring-1 ring-[var(--accent-danger)]" : ""].filter(Boolean).join(" ")}
      onFocus={event => { editing.current = true; onFocus?.(event) }}
      onChange={event => {
        const text = event.target.value
        setDraft(text)
        setShowError(false)
        const nextError = numericInputError(text, { min, max, step, required: mandatory })
        event.currentTarget.setCustomValidity(nextError)
        // Existing numeric callbacks receive only completed, valid numbers. Their
        // defaults/clamps can no longer overwrite a partially edited value.
        if (!nextError) onChange?.(event)
      }}
      onBlur={event => {
        editing.current = false
        setShowError(Boolean(error))
        event.currentTarget.setCustomValidity(error)
        // Some existing callbacks round integer parameters. Reflect that result
        // only after editing, so the displayed final number matches submission.
        if (!error && value !== undefined && draft.trim() && Number(value) !== Number(draft)) setDraft(String(value))
        if (!error && draft.trim()) onBlur?.(event)
      }}
      onKeyDown={event => {
        if (event.key === "Enter" && error) {
          event.preventDefault()
          setShowError(true)
          event.currentTarget.reportValidity()
          return
        }
        onKeyDown?.(event)
      }}
      onInvalid={event => {
        setShowError(true)
        props.onInvalid?.(event)
      }}
    />
  }
)
NumericInput.displayName = "NumericInput"
