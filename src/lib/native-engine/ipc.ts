import { decode, encode } from "@msgpack/msgpack"
import { NATIVE_ENGINE_VERSION } from "./version"
import type { MiningConfig } from "@/lib/mining/types"
import type { BarsColumns, BarsMetadata, NativeEndpoint, NativeEvaluatedCandidate, NativeRankedCandidate, NativeFeatureInfo, NativeHello, NativeStrictVerdict, NativePrecisePayload, NativePreciseResult } from "./types"

interface Envelope {
  type: string; request_id: string; session_id: string; Authorization: string
  payload: Record<string, unknown>
}
interface Pending {
  type: string; session: string; resolve: (value: unknown) => void
  reject: (reason: unknown) => void; cleanup: () => void
}
interface ClientOptions {
  socketFactory?: (url: string) => WebSocket
  heartbeatMs?: number
  onStage?: (message: string) => void
}

export class NativeEngineError extends Error {
  constructor(message: string, readonly code = "ENGINE_ERROR") { super(message); this.name = "NativeEngineError" }
}

export class NativeEngineClient {
  #socket?: WebSocket
  #token = ""
  #seq = 0
  #pending = new Map<string, Pending>()
  #heartbeat?: ReturnType<typeof setInterval>
  #options: ClientOptions

  constructor(options: ClientOptions = {}) { this.#options = options }

  async connect(endpoint: NativeEndpoint, signal?: AbortSignal): Promise<NativeHello> {
    if (this.#socket) throw new NativeEngineError("原生引擎连接已存在")
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || endpoint.token.length < 16) {
      throw new NativeEngineError("原生引擎握手无效", "INVALID_HANDSHAKE")
    }
    if (signal?.aborted) throw new DOMException("已取消", "AbortError")
    this.#token = endpoint.token
    const ws = (this.#options.socketFactory ?? ((url) => new WebSocket(url)))(`ws://127.0.0.1:${endpoint.port}`)
    this.#socket = ws
    ws.binaryType = "arraybuffer"
    ws.addEventListener("message", (event) => this.#receive(event.data))
    ws.addEventListener("close", () => this.#fail(new NativeEngineError("原生引擎连接断开", "DISCONNECTED")))
    ws.addEventListener("error", () => this.#fail(new NativeEngineError("原生引擎连接失败", "CONNECTION_ERROR")))
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          ws.removeEventListener("open", open)
          ws.removeEventListener("close", closed)
          ws.removeEventListener("error", closed)
          signal?.removeEventListener("abort", abort)
        }
        const open = () => { cleanup(); resolve() }
        const closed = () => { cleanup(); reject(new NativeEngineError("原生引擎连接断开", "DISCONNECTED")) }
        const abort = () => { cleanup(); reject(new DOMException("已取消", "AbortError")) }
        const timer = setTimeout(() => { cleanup(); reject(new NativeEngineError("原生引擎连接超时", "TIMEOUT")) }, 30_000)
        ws.addEventListener("open", open)
        ws.addEventListener("close", closed)
        ws.addEventListener("error", closed)
        signal?.addEventListener("abort", abort, { once: true })
      })
      const hello = await this.#request<NativeHello>("hello", "", {}, false, signal, 30_000)
      if (hello.engine_version !== NATIVE_ENGINE_VERSION) throw new NativeEngineError("原生引擎与桌面端版本不匹配，请更新完整安装包", "ENGINE_VERSION_MISMATCH")
      if (hello.backend !== "cuda" || !hello.fp64_supported || !hello.selfcheck?.passed || hello.selfcheck.token_count !== 20 ||
          hello.selfcheck.features_passed !== true || hello.selfcheck.reports_passed !== true || hello.selfcheck.selection_passed !== true ||
          hello.selfcheck.portfolio_passed !== true ||
          hello.selfcheck.eval_precision !== "f64" || (hello.precision === "mixed" && hello.selfcheck.coarse_passed !== true) ||
          !hello.engine_version.startsWith("native-gpu-v1-")) {
        throw new NativeEngineError("原生引擎能力或确定性自检未通过", "SELF_CHECK_FAILED")
      }
      const ms = this.#options.heartbeatMs ?? 1000
      if (ms > 0) this.#heartbeat = setInterval(() => {
        void this.#request("heartbeat", "", {}, false, undefined, 5000).catch((error) => this.close(error))
      }, ms)
      return hello
    } catch (error) {
      this.close(error)
      throw error
    }
  }

  loadBars(session: string, columns: BarsColumns, metadata: BarsMetadata, signal?: AbortSignal): Promise<void> {
    const bytes: Record<string, Uint8Array> = {}
    for (const [key, column] of Object.entries(columns)) {
      if (column.length !== metadata.count) return Promise.reject(new NativeEngineError("K 线列长度不一致"))
      bytes[key] = new Uint8Array(column.buffer, column.byteOffset, column.byteLength)
    }
    return this.#request("load_bars", session, { columns: bytes, metadata }, true, signal, 120_000)
  }

  mineFeatures(session: string, config: MiningConfig, signal?: AbortSignal): Promise<NativeFeatureInfo> {
    return this.#request("mine_features", session, { config }, false, signal, 480_000)
  }

  evalShards(session: string, candidates: number[][], signal?: AbortSignal): Promise<{ evaluated: NativeEvaluatedCandidate[] }> {
    return this.#request("eval_shards", session, { candidates }, false, signal, 900_000)
  }

  rankShards(session: string, candidates: number[][], signal?: AbortSignal): Promise<{ ranked: NativeRankedCandidate[] }> {
    return this.#request("eval_shards", session, { candidates, coarse: true }, false, signal, 900_000)
  }

  strictEval(session: string, candidates: number[][], signal?: AbortSignal): Promise<{ strict: NativeStrictVerdict[] }> {
    return this.#request("strict_eval", session, { candidates }, false, signal, 900_000)
  }

  async precise(session: string, payload: NativePrecisePayload, signal?: AbortSignal): Promise<NativePreciseResult> {
    const result = await this.#request<NativePreciseResult>("precise", session, { ...payload }, false, signal, 900_000)
    const invalid = () => new NativeEngineError("原生引擎返回的冠军缺少合格证明", "INVALID_QUALIFICATION")
    if (!result || ![result.champions, result.research_candidates, result.pending_candidates,
      result.rejected_candidates, result.best_seen].every(Array.isArray) ||
      !result.qualification_requirements || typeof result.qualification_requirements !== "object" ||
      result.champions.length + result.pending_candidates.length + result.rejected_candidates.length !== result.research_candidates.length) {
      throw invalid()
    }
    const remaining = new Map<string, number>()
    for (const candidate of result.research_candidates) {
      if (!Array.isArray(candidate.tokens)) throw invalid()
      const key = candidate.tokens.join(",")
      remaining.set(key, (remaining.get(key) ?? 0) + 1)
    }
    for (const candidate of [...result.champions, ...result.pending_candidates, ...result.rejected_candidates]) {
      if (!Array.isArray(candidate.tokens)) throw invalid()
      const key = candidate.tokens.join(","), count = remaining.get(key) ?? 0
      if (count < 1) throw invalid()
      remaining.set(key, count - 1)
    }
    for (const candidate of result.champions) {
      if (candidate.qualification?.status !== "qualified" || !Array.isArray(candidate.qualification.reasons) ||
        candidate.qualification.reasons.length !== 0 || !Number.isFinite(candidate.composite) ||
        candidate.metrics?.native_strict_passed !== true || candidate.metrics?.native_eval_precision !== "f64" ||
        candidate.metrics?.kernel_version !== "native-gpu-v1") throw invalid()
    }
    if (result.portfolio != null) {
      if (payload.final_generation !== true || !payload.include_portfolio) throw invalid()
      const numeric = (value: unknown): boolean => {
        if (typeof value === "number") return Number.isFinite(value)
        if (Array.isArray(value)) return value.every(numeric)
        if (value && typeof value === "object") return Object.values(value).every(numeric)
        return true
      }
      if (!numeric(result.portfolio)) throw invalid()
      if (payload.combo_super === true) {
        // 组合因子:成员池按优质/回捞分层截断至 5,可含被拒候选——只校验
        // 成员确属本代候选集且 2-5 个(与引擎侧 precise_ti 分层口径一致)
        const pool = new Set(result.research_candidates.map((c) => c.tokens.join(",")))
        const members = result.portfolio.members ?? []
        if (result.portfolio.n_factors !== members.length || members.length < 2 || members.length > 5
          || !members.every((tokens) => pool.has(tokens.join(",")))) throw invalid()
      } else if (result.champions.length < 2 || result.portfolio.n_factors !== result.champions.length) {
        throw invalid()
      }
    }
    return result
  }

  disposeSession(session: string): Promise<void> { return this.#request("dispose_session", session, {}, false, undefined, 30_000) }

  #request<T>(type: string, session: string, payload: Record<string, unknown>, binary: boolean, signal?: AbortSignal, timeout = 30_000): Promise<T> {
    const ws = this.#socket
    if (!ws || ws.readyState !== 1) return Promise.reject(new NativeEngineError("原生引擎连接断开", "DISCONNECTED"))
    if (signal?.aborted) return Promise.reject(new DOMException("已取消", "AbortError"))
    const id = String(++this.#seq)
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#pending.delete(id) }
      const abort = () => { cleanup(); reject(new DOMException("已取消", "AbortError")) }
      const timer = setTimeout(() => { cleanup(); reject(new NativeEngineError(`原生引擎 ${type} 超时`, "TIMEOUT")) }, timeout)
      this.#pending.set(id, { type, session, resolve: (value) => resolve(value as T), reject, cleanup })
      signal?.addEventListener("abort", abort, { once: true })
      const envelope = { type, request_id: id, session_id: session, Authorization: `Bearer ${this.#token}`, payload }
      try { ws.send(binary ? encode(envelope) : JSON.stringify(envelope)) }
      catch (error) { cleanup(); reject(error) }
    })
  }

  #receive(data: unknown): void {
    try {
      const message = (typeof data === "string" ? JSON.parse(data) : decode(new Uint8Array(data as ArrayBuffer))) as Envelope
      if (message.Authorization !== `Bearer ${this.#token}`) throw new NativeEngineError("原生引擎响应鉴权失败", "UNAUTHORIZED")
      const pending = this.#pending.get(message.request_id)
      if (!pending) return // Aborted/timed-out responses must not resolve another request.
      if (message.session_id !== pending.session) throw new NativeEngineError("原生引擎响应会话不匹配")
      if (message.type === "stage") { this.#options.onStage?.(String(message.payload.message)); return }
      if (message.type !== pending.type && message.type !== "error") throw new NativeEngineError("原生引擎响应类型不匹配")
      pending.cleanup()
      if (message.type === "error") pending.reject(new NativeEngineError(String(message.payload.message), String(message.payload.code)))
      else pending.resolve(message.payload)
    } catch (error) { this.close(error) }
  }

  #fail(error: unknown): void {
    const ws = this.#socket
    this.#socket = undefined
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
    for (const pending of [...this.#pending.values()]) { pending.cleanup(); pending.reject(error) }
    if (ws && ws.readyState !== 3) ws.close()
  }

  close(reason: unknown = new NativeEngineError("原生引擎连接已关闭")): void {
    this.#fail(reason)
  }
}
