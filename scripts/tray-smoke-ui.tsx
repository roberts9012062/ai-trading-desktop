// This fixture intentionally omits desktop-boot and all trading/account modules.
import ReactDOM from "react-dom/client"
import { DesktopFrame } from "../src/components/common/desktop-titlebar"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import "../src/app/globals.css"

Object.assign(window, { probe: { ticks: 0, workerTicks: 0, maxGap: 0, last: performance.now(), preventClose: true, closeRequests: 0, closeGuardReady: false } })
if (isTauri()) {
  void getCurrentWindow().onCloseRequested(event => {
    const p = (window as any).probe
    p.closeRequests++
    if (p.preventClose) event.preventDefault()
  }).then(() => { (window as any).probe.closeGuardReady = true })
}
setInterval(() => {
  const p = (window as any).probe, now = performance.now()
  p.ticks++; p.maxGap = Math.max(p.maxGap, now - p.last); p.last = now
}, 100)
const worker = new Worker(URL.createObjectURL(new Blob([
  "let n=0;setInterval(()=>postMessage(++n),100)"
], { type: "text/javascript" })))
worker.onmessage = e => { (window as any).probe.workerTicks = e.data }
ReactDOM.createRoot(document.getElementById("root")!).render(
  <DesktopFrame><div className="h-full bg-[var(--bg-primary)] text-[var(--text-primary)] p-8">
    <h1>周期领航 · 托盘功能验收（托盘与最小化独立按钮）</h1>
    <p className="mt-6">独立测试窗口，无账号、交易请求或真实任务。隐藏后检查定时器与 Worker 是否持续运行。</p>
  </div></DesktopFrame>
)
