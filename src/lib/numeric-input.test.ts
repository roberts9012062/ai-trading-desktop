import { describe, expect, it, vi } from "vitest"
import { numericInputError, validateNumericAction, withNumericValidation } from "./numeric-input"

describe("numeric input completion validation", () => {
  it("keeps mandatory blanks and intermediate drafts invalid, without supplying a default", () => {
    for (const draft of ["", " ", "-", ".", "1e", "1e-", "abc", "Infinity", "1e999"])
      expect(numericInputError(draft, { required: true })).not.toBe("")
    expect(numericInputError("", {})).toBe("") // optional TP/SL and quota overrides
  })
  it("accepts zero, signed decimals, paste and exponent numbers when permitted", () => {
    for (const draft of ["0", "-0.25", ".5", "1.", " 123.45 ", "1e-3", "+3"])
      expect(numericInputError(draft, {})).toBe("")
    expect(numericInputError("50", { min: 1, max: 50, step: 1 })).toBe("")
    expect(numericInputError("0.01", { min: ".01", step: "any" })).toBe("")
  })
  it("checks final bounds and integer parameters without imposing spinner-grid divisibility", () => {
    expect(numericInputError("0", { min: 1 })).not.toBe("")
    expect(numericInputError("51", { max: 50 })).not.toBe("")
    expect(numericInputError("1.5", { step: 1 })).not.toBe("")
    expect(numericInputError("3", { min: 3, step: 5 })).toBe("")
  })
})

describe("numeric submission guard", () => {
  const field = (valid: boolean, disabled = false) => ({
    disabled, readOnly: false, closest: () => null,
    checkValidity: vi.fn(() => valid), focus: vi.fn(), reportValidity: vi.fn(), setAttribute: vi.fn(),
  })
  function trigger(fields: ReturnType<typeof field>[]) {
    return { closest: () => ({ querySelectorAll: () => fields }) } as unknown as HTMLElement
  }
  it("prevents a save from using previous numeric state when a draft was cleared", () => {
    const input = field(false), save = vi.fn(), event = { currentTarget: trigger([input]), preventDefault: vi.fn() }
    withNumericValidation(save)(event as unknown as React.MouseEvent<HTMLElement>)
    expect(save).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(input.focus).toHaveBeenCalledOnce()
    expect(input.reportValidity).toHaveBeenCalledOnce()
  })
  it("permits valid saves and excludes disabled inputs from optional rule sections", () => {
    const disabled = field(false, true), valid = field(true), save = vi.fn()
    const event = { currentTarget: trigger([disabled, valid]), preventDefault: vi.fn() }
    withNumericValidation(save)(event as unknown as React.MouseEvent<HTMLElement>)
    expect(save).toHaveBeenCalledOnce()
    expect(disabled.checkValidity).not.toHaveBeenCalled()
    expect(validateNumericAction(trigger([valid]))).toBe(true)
  })
})
