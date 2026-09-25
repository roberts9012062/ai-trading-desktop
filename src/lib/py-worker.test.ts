/**
 * Pyodide Worker 单例可靠性单测(P1-9 回归)
 *
 * 锁定四件事:
 * - 正常请求-响应往返;
 * - rpc 超时不再无限等待:reject 并废弃卡死实例,下次 rpc 自动重建;
 * - worker 启动失败(reqId=0 广播 error)不再被静默丢弃:reject 全部 pending;
 * - cancelPyWorker() 立即 terminate 并 reject 全部 pending。
 * (selectFactor 竞态保护是 hook 内逻辑,靠 typecheck + 手动验证覆盖)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message: string }) => void) | null = null
  terminated = false
  posted: { type: string; reqId: number }[] = []

  constructor(_url: URL, _opts?: unknown) {
    FakeWorker.instances.push(this)
  }

  postMessage(msg: { type: string; reqId: number }): void {
    this.posted.push(msg)
  }

  terminate(): void {
    this.terminated = true
  }

  /** 以 worker 身份向宿主回消息 */
  emit(msg: unknown): void {
    this.onmessage?.({ data: msg })
  }
}

/** 每个用例拿全新的 py-worker 模块(单例状态隔离) */
async function loadPyWorker() {
  return await import("@/lib/py-worker")
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.instances = []
  vi.stubGlobal("Worker", FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("py-worker rpc 可靠性", () => {
  it("正常往返:worker 回 result 后 resolve,实例保持存活", async () => {
    const { ensurePyWorker } = await loadPyWorker()
    const p = ensurePyWorker().factorRun({ mode: "search" }, [])
    const w = FakeWorker.instances[0]
    expect(w.posted[0].type).toBe("factor_run")
    w.emit({ type: "result", reqId: w.posted[0].reqId, report: { ok: 1 } })
    await expect(p).resolves.toEqual({ ok: 1 })
    expect(w.terminated).toBe(false)
  })

  it("超时:reject 并废弃卡死实例,下次 rpc 拉起新 worker", async () => {
    vi.useFakeTimers()
    const { ensurePyWorker } = await loadPyWorker()
    const p = ensurePyWorker().factorRun({}, [])
    const w1 = FakeWorker.instances[0]
    // 先挂 rejection 处理器再推进定时器,避免 reject 瞬间无人接管
    const expectTimeout = expect(p).rejects.toThrow("本地计算超时")

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 10)
    await expectTimeout
    expect(w1.terminated).toBe(true)

    // 下一次 rpc 必须拿到新实例,而不是复用已 terminate 的死 worker
    const p2 = ensurePyWorker().factorRun({}, [])
    const w2 = FakeWorker.instances[1]
    expect(w2).toBeDefined()
    expect(w2).not.toBe(w1)
    w2.emit({ type: "result", reqId: w2.posted[0].reqId, report: null })
    await expect(p2).resolves.toBeNull()
  })

  it("启动失败(reqId=0 广播):reject 全部 pending 并废弃实例,下次 rpc 重建自愈", async () => {
    const { ensurePyWorker } = await loadPyWorker()
    const p1 = ensurePyWorker().factorRun({}, [])
    const p2 = ensurePyWorker().run({}, [])
    const w1 = FakeWorker.instances[0]
    const e1 = expect(p1).rejects.toThrow("内核加载失败: CDN 不可达")
    const e2 = expect(p2).rejects.toThrow("内核加载失败: CDN 不可达")

    // 修复前:reqId=0 在 pending 里无对应项,错误被静默丢弃,用户永远转圈
    w1.emit({ type: "error", reqId: 0, message: "内核加载失败: CDN 不可达" })
    await e1
    await e2
    expect(w1.terminated).toBe(true)

    const p3 = ensurePyWorker().factorRun({}, [])
    const w2 = FakeWorker.instances[1]
    expect(w2).not.toBe(w1)
    w2.emit({ type: "result", reqId: w2.posted[0].reqId, report: "ok" })
    await expect(p3).resolves.toBe("ok")
  })

  it("超时后晚到的 result 被静默丢弃,不抛错", async () => {
    vi.useFakeTimers()
    const { ensurePyWorker } = await loadPyWorker()
    const p = ensurePyWorker().factorRun({}, [])
    const w1 = FakeWorker.instances[0]
    const reqId = w1.posted[0].reqId
    const expectTimeout = expect(p).rejects.toThrow("本地计算超时")

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 10)
    await expectTimeout
    expect(() => w1.emit({ type: "result", reqId, report: 1 })).not.toThrow()
  })

  it("cancelPyWorker:pending 全部 reject、worker 被 terminate、后续 rpc 重建", async () => {
    const { ensurePyWorker, cancelPyWorker } = await loadPyWorker()
    const p = ensurePyWorker().factorRun({}, [])
    const w1 = FakeWorker.instances[0]
    const expectCancel = expect(p).rejects.toThrow("已取消本地搜索")

    cancelPyWorker("已取消本地搜索")
    await expectCancel
    expect(w1.terminated).toBe(true)

    const p2 = ensurePyWorker().factorRun({}, [])
    const w2 = FakeWorker.instances[1]
    w2.emit({ type: "result", reqId: w2.posted[0].reqId, report: "ok" })
    await expect(p2).resolves.toBe("ok")
  })

  it("普通计算错误(reqId 匹配):只 reject 对应请求,worker 不废弃", async () => {
    const { ensurePyWorker } = await loadPyWorker()
    const p = ensurePyWorker().factorRun({}, [])
    const w = FakeWorker.instances[0]
    const expectErr = expect(p).rejects.toThrow("ValueError: bad tokens")

    w.emit({ type: "error", reqId: w.posted[0].reqId, message: "ValueError: bad tokens" })
    await expectErr
    expect(w.terminated).toBe(false)
  })
})
