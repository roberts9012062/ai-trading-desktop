/**
 * Pyodide 回测 Worker —— 在独立线程加载 Pyodide + 回测内核,不卡 UI
 *
 * 协议:
 *   入:{ type: "run", reqId, payload, bars }
 *     | { type: "factor_run", reqId, payload, bars }
 *     | { type: "engine_run", reqId, payload, bars }
 *     | { type: "mine_start", reqId, sessionId, payload, bars }   // M3 挖掘会话
 *     | { type: "mine_step", reqId, sessionId }
 *     | { type: "mine_dispose", reqId, sessionId }
 *   出:{ type: "ready" } | { type: "result", reqId, report } | { type: "error", reqId, message }
 *
 * 内核为纯 Python(factor 策略已桩化,无 numpy),核心 wasm ~6MB,
 * 仅首次加载较慢;worker 常驻,后续回测秒级。
 * mine_* 会话:mine_start 传一次 bars(会话持有引用),mine_step 每次只跑
 * 一代就返回——控制权交回 JS,暂停/取消落在代边界,无需 Python 侧埋标志。
 */

/// <reference lib="webworker" />

const ctx = self as unknown as Worker

const PYODIDE_VERSION = "0.26.4"
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full`

function errText(err: unknown): string {
  let msg = ""
  if (err instanceof Error) msg = `${err.message}\n${err.stack ?? ""}`
  else if (typeof err === "string") msg = err
  else {
    try {
      msg = JSON.stringify(err) ?? String(err)
    } catch {
      msg = String(err)
    }
  }
  // Python 异常(message 含完整 traceback):只保留最后的异常语句一行,
  // 用户看到干净的业务错误而非整段堆栈
  const excLines = msg.match(
    /(?:^|\n)[A-Za-z_][\w.]*(?:Error|Exception|InvalidURL): [^\n]+/g,
  )
  if (excLines && excLines.length > 0) {
    return excLines[excLines.length - 1].trim().slice(0, 600)
  }
  return msg.slice(0, 600)
}

interface PyodideInterface {
  FS: {
    writeFile: (path: string, data: string, opts?: { encoding?: string }) => void
    mkdirTree: (path: string) => void
  }
  runPython: <T = unknown>(code: string) => T
  loadPackage: (name: string) => Promise<void>
}

interface Kernel {
  run: (payloadJson: string, barsJson: string) => string
}

/** 因子内核:基础内核 + numpy + 因子文件,含分代步进挖掘会话入口 */
interface FactorKernel extends Kernel {
  mine_start: (payloadJson: string, barsJson: string) => string
  mine_step: (sessionId: string) => string
  mine_dispose: (sessionId: string) => string
  /** 策略回测入口(bootstrap):factor 策略的信号实现在 factor_np.py,
   *  依赖 numpy,须在因子内核环境执行(本 handle 的 run 是 factor_local) */
  btRun: (payloadJson: string, barsJson: string) => string
}

let kernelPromise: Promise<Kernel> | null = null
let pyodideInstance: PyodideInterface | null = null
let factorPromise: Promise<FactorKernel> | null = null
let enginePromise: Promise<Kernel> | null = null

async function loadEngineKernel(): Promise<Kernel> {
  await ensureKernel()
  const pyodide = pyodideInstance!
  const engine = pyodide.runPython<{ run: (a: string, b: string) => string }>(
    "import engine_local; engine_local",
  )
  return { run: engine.run }
}

function ensureEngineKernel(): Promise<Kernel> {
  if (!enginePromise) {
    enginePromise = loadEngineKernel().catch((err) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

async function writeFiles(files: string[]): Promise<void> {
  const pyodide = pyodideInstance!
  // Emscripten FS 不自动创建目录:先建全部子目录
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split("/")
    parts.pop()
    for (let i = 1; i <= parts.length; i++) dirs.add(`/pykernel/${parts.slice(0, i).join("/")}`)
  }
  for (const d of dirs) pyodide.FS.mkdirTree(d)
  for (const f of files) {
    const code = await (await fetch(`/pykernel/${f}`)).text()
    pyodide.FS.writeFile(`/pykernel/${f}`, code, { encoding: "utf8" })
  }
}

async function loadKernel(): Promise<Kernel> {
  const { loadPyodide } = (await import(`${CDN}/pyodide.mjs`)) as {
    loadPyodide: (opts: unknown) => Promise<PyodideInterface>
  }
  const pyodide = await loadPyodide({ indexURL: `${CDN}/` })
  pyodideInstance = pyodide

  const manifest = (await (await fetch("/pykernel/kernel-files.json")).json()) as {
    files: string[]
    factorFiles: string[]
  }
  await writeFiles(manifest.files)
  pyodide.runPython("import sys; sys.path.insert(0, '/pykernel')")
  // import 语句本身不返回值,需以模块对象作为最后表达式取回
  const bootstrap = pyodide.runPython<{ run: (a: string, b: string) => string }>(
    "import bootstrap; bootstrap",
  )
  return { run: bootstrap.run }
}

/** 因子内核:在基础内核之上懒加载 numpy + 因子文件(首次约 10MB) */
async function loadFactorKernel(): Promise<FactorKernel> {
  await ensureKernel()
  const pyodide = pyodideInstance!
  await pyodide.loadPackage("numpy")
  const manifest = (await (await fetch("/pykernel/kernel-files.json")).json()) as {
    factorFiles: string[]
  }
  await writeFiles(manifest.factorFiles)
  const factorLocal = pyodide.runPython<{
    run: (a: string, b: string) => string
    mine_start: (a: string, b: string) => string
    mine_step: (a: string) => string
    mine_dispose: (a: string) => string
  }>("import factor_local; factor_local")
  const bootstrap = pyodide.runPython<{ run: (a: string, b: string) => string }>(
    "import bootstrap; bootstrap",
  )
  return {
    run: factorLocal.run,
    mine_start: factorLocal.mine_start,
    mine_step: factorLocal.mine_step,
    mine_dispose: factorLocal.mine_dispose,
    btRun: bootstrap.run,
  }
}

function ensureFactorKernel(): Promise<FactorKernel> {
  if (!factorPromise) {
    factorPromise = loadFactorKernel().catch((err) => {
      factorPromise = null
      throw err
    })
  }
  return factorPromise
}

function ensureKernel(): Promise<Kernel> {
  if (!kernelPromise) {
    kernelPromise = loadKernel().catch((err) => {
      kernelPromise = null // 失败可重试
      throw err
    })
  }
  return kernelPromise
}

ctx.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as {
    type: string
    reqId: number
    payload?: unknown
    bars?: unknown
    sessionId?: string
  }

  // 分代步进挖掘会话(M3):独立入口,不占用 run(mode) 的 bars 双参契约
  if (msg.type === "mine_start" || msg.type === "mine_step" || msg.type === "mine_dispose") {
    try {
      const kernel = await ensureFactorKernel()
      let resultJson: string
      if (msg.type === "mine_start") {
        resultJson = kernel.mine_start(
          JSON.stringify(msg.payload ?? {}),
          JSON.stringify(msg.bars ?? []),
        )
      } else if (msg.type === "mine_step") {
        resultJson = kernel.mine_step(String(msg.sessionId ?? ""))
      } else {
        resultJson = kernel.mine_dispose(String(msg.sessionId ?? ""))
      }
      ctx.postMessage({ type: "result", reqId: msg.reqId, report: JSON.parse(resultJson) })
    } catch (err) {
      ctx.postMessage({ type: "error", reqId: msg.reqId, message: errText(err) })
    }
    return
  }

  if (msg.type !== "run" && msg.type !== "factor_run" && msg.type !== "engine_run") return
  const { reqId, payload, bars } = msg
  // factor 策略回测在因子内核执行:信号实现 strategies/factor_np.py 依赖
  // numpy(基础内核无 numpy,委托桩会给出"需要因子内核"提示)——worker
  // 在此保证加载,用户无感
  const isFactorStrategy =
    msg.type === "run" &&
    String((payload as { strategy_type?: unknown } | undefined)?.strategy_type ?? "")
      .trim()
      .toLowerCase() === "factor"
  try {
    const kernel =
      msg.type === "run" && !isFactorStrategy ? await ensureKernel()
      : msg.type === "run" || msg.type === "factor_run" ? await ensureFactorKernel()
      : await ensureEngineKernel()
    const runner = isFactorStrategy ? (kernel as FactorKernel).btRun : kernel.run
    const resultJson = runner(JSON.stringify(payload), JSON.stringify(bars))
    ctx.postMessage({ type: "result", reqId, report: JSON.parse(resultJson) })
  } catch (err) {
    ctx.postMessage({
      type: "error",
      reqId,
      message: errText(err),
    })
  }
}

void ensureKernel()
  .then(() => ctx.postMessage({ type: "ready" }))
  .catch((err) => ctx.postMessage({ type: "error", reqId: 0, message: `内核加载失败: ${errText(err)}` }))
