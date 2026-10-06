// This fixture intentionally omits desktop-boot and all trading/account modules.
import ReactDOM from "react-dom/client"
import { DesktopMinimizeDialog } from "../src/components/common/desktop-minimize-dialog"
import "../src/app/globals.css"

Object.assign(window, { probe: { ticks: 0, workerTicks: 0, maxGap: 0, last: performance.now() } })
setInterval(() => {
  const p = (window as any).probe, now = performance.now()
  p.ticks++; p.maxGap = Math.max(p.maxGap, now - p.last); p.last = now
}, 100)
const worker = new Worker(URL.createObjectURL(new Blob([
  "let n=0;setInterval(()=>postMessage(++n),100)"
], { type: "text/javascript" })))
worker.onmessage = e => { (window as any).probe.workerTicks = e.data }
ReactDOM.createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] p-8">
    <DesktopMinimizeDialog />
    <h1>周期领航 · 托盘功能验收（点击右上角最小化按钮）</h1>
    <p className="mt-6">独立测试窗口，无账号、交易请求或真实任务。隐藏后检查定时器与 Worker 是否持续运行。</p>
  </div>
)
