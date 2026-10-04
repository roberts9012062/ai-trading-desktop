import type * as React from "react"

export interface NumericConstraints {
  required?: boolean
  min?: number | string
  max?: number | string
  step?: number | string
}

/** Validate a completed draft without replacing it with a default or a bound. */
export function numericInputError(draft: string, rules: NumericConstraints): string {
  const text = draft.trim()
  if (!text) return rules.required ? "请输入数字，不能留空" : ""
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) {
    return "请输入有效的数字"
  }
  const number = Number(text)
  if (rules.min !== undefined && number < Number(rules.min)) return `输入完成后数值须不小于 ${rules.min}`
  if (rules.max !== undefined && number > Number(rules.max)) return `输入完成后数值须不大于 ${rules.max}`
  // Integer steps describe integer parameters; larger increments are spinner hints,
  // not divisibility rules (some existing defaults do not lie on that grid).
  if (rules.step !== undefined && rules.step !== "any" && Number(rules.step) >= 1 && !Number.isInteger(number)) {
    return "该参数请输入整数"
  }
  return ""
}

/** Scope a save action to its dialog/form, or its nearest inline editor. */
export function numericActionScope(trigger: HTMLElement): HTMLElement | null {
  const explicit = trigger.closest<HTMLElement>("[data-numeric-scope], form, [role='dialog']")
  if (explicit) return explicit
  let parent = trigger.parentElement
  while (parent && parent !== document.body) {
    if (parent.querySelector("input[data-numeric-input]")) return parent
    parent = parent.parentElement
  }
  return null
}

export function validateNumericAction(trigger: HTMLElement): boolean {
  const scope = numericActionScope(trigger)
  if (!scope) return true
  for (const input of scope.querySelectorAll<HTMLInputElement>("input[data-numeric-input]")) {
    if (input.disabled || input.readOnly || input.closest("[hidden], [aria-hidden='true']")) continue
    if (!input.checkValidity()) {
      input.focus()
      input.reportValidity()
      return false
    }
  }
  return true
}

const draftResets = new WeakMap<HTMLInputElement, () => void>()

export function registerNumericReset(input: HTMLInputElement, reset: () => void): () => void {
  draftResets.set(input, reset)
  return () => { draftResets.delete(input) }
}

export function resetNumericAction(trigger: HTMLElement): void {
  let scope = trigger.parentElement
  while (scope && !scope.querySelector("input[data-numeric-input]")) scope = scope.parentElement
  scope?.querySelectorAll<HTMLInputElement>("input[data-numeric-input]").forEach(input => draftResets.get(input)?.())
}

export function withNumericReset<E extends HTMLElement>(handler: (event: React.MouseEvent<E>) => void) {
  return (event: React.MouseEvent<E>): void => {
    handler(event)
    resetNumericAction(event.currentTarget)
  }
}

/** Explicitly opt in save/create/order actions; cancel/reset buttons are unaffected. */
export function withNumericValidation<E extends HTMLElement>(handler: (event: React.MouseEvent<E>) => void) {
  return (event: React.MouseEvent<E>): void => {
    if (!validateNumericAction(event.currentTarget)) {
      event.preventDefault()
      return
    }
    handler(event)
  }
}
