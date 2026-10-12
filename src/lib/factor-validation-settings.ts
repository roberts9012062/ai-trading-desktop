/** The lab and evolution page share the same persisted anti-overfit settings. */
export interface FactorValidationSettings { enabled: boolean; train_ratio: number; test_recent_bars: number; walk_forward_folds: number }
export const DEFAULT_FACTOR_VALIDATION: FactorValidationSettings = {enabled: true, train_ratio: .7, test_recent_bars: 0, walk_forward_folds: 3}
function key() {
  try { return `factor-lab-validation:${JSON.parse(localStorage.getItem("qihuo_auth_user") || "{}").id || "local"}` } catch { return "factor-lab-validation:local" }
}
export function readFactorValidation(): FactorValidationSettings {
  try {
    const value = JSON.parse(localStorage.getItem(key()) || "null")
    if (!value || typeof value.enabled !== "boolean" || !Number.isFinite(value.train_ratio) || value.train_ratio < 0 || value.train_ratio > .9 || !Number.isInteger(value.test_recent_bars) || value.test_recent_bars < 0 || value.test_recent_bars > 20000 || !Number.isInteger(value.walk_forward_folds) || value.walk_forward_folds < 0 || value.walk_forward_folds > 10) return {...DEFAULT_FACTOR_VALIDATION}
    return value
  } catch { return {...DEFAULT_FACTOR_VALIDATION} }
}
export function writeFactorValidation(value: FactorValidationSettings) {
  try { localStorage.setItem(key(), JSON.stringify(value)) } catch { /* form remains usable if storage is full */ }
}
