import version from "../../../native-engine/VERSION?raw"

export const NATIVE_ENGINE_TAG = "native-gpu-v1"
export const NATIVE_ENGINE_VERSION = version.trim()

export function isCurrentNativeMetrics(metrics: Record<string, unknown>): boolean {
  return metrics.kernel_version === NATIVE_ENGINE_TAG && metrics.native_eval_precision === "f64" &&
    metrics.native_engine_version === NATIVE_ENGINE_VERSION
}
