import type {
  KlineBar,
  DepositRecord, AdminUser, AdminContract, SystemLog,
} from "@/types"

// 注：已移除 11 个零调用的 mock 函数（getContracts/getMockQuotes/getMockOrderBook/
// getMockTrades/getMockPositions/getMockPositionDetails/getMockOrders/getMockHistoryOrders/
// getMockAccount/getMockFundFlows/getMockMessages/getMockAnnouncements）。
// 仅保留 admin/history 页面仍在使用的 5 个。

/** 确定性伪随机（相同种子产生相同序列，避免 SSR Hydration 不匹配） */
function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 16807 + 0) % 2147483647
    return (s - 1) / 2147483646
  }
}

/** 周期对应的分钟数映射 */
const PERIOD_MINUTES: Record<string, number> = {
  tick: 1, "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1d": 1440,
}

/** 格式化日期为 lightweight-charts 可识别的时间字符串 */
function formatTime(date: Date, isDaily: boolean): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  if (isDaily) return `${y}-${m}-${d}`
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  return `${y}-${m}-${d} ${hh}:${mm}`
}

/** 不同周期使用不同种子，确保各周期 K 线走势不同 */
const PERIOD_SEEDS: Record<string, number> = {
  tick: 111, "1m": 222, "5m": 333, "15m": 444, "30m": 555, "60m": 666, "1d": 777,
}

/** 生成模拟 K 线数据（确定性，SSR 安全） */
export function getMockKlines(_code: string, period: string): KlineBar[] {
  const rng = seededRandom(PERIOD_SEEDS[period] ?? 777)
  const bars: KlineBar[] = []
  let price = 3680
  const baseTime = new Date("2026-05-29T15:00:00").getTime()
  const minutes = PERIOD_MINUTES[period] ?? 1
  const count = period === "1d" ? 120 : 200
  const isDaily = period === "1d"

  for (let i = count; i >= 0; i--) {
    const date = new Date(baseTime - i * minutes * 60000)
    const open = price
    const change = (rng() - 0.48) * price * 0.02
    const close = +(open + change).toFixed(2)
    const high = +(Math.max(open, close) + rng() * price * 0.005).toFixed(2)
    const low = +(Math.min(open, close) - rng() * price * 0.005).toFixed(2)
    bars.push({
      time: formatTime(date, isDaily),
      open: +open.toFixed(2),
      high,
      low,
      close,
      volume: Math.floor(rng() * 100000 + 5000),
      openInterest: Math.floor(rng() * 200000 + 5000),
    })
    price = close
  }
  return bars
}

// ===== 资产（出入金记录）=====

/** 获取模拟出入金记录 */
export function getMockDeposits(): DepositRecord[] {
  return [
    { id: "d1", applyTime: "2026-05-27 10:00:00", bank: "工商银行 ****8862", amount: 200000, status: "completed" },
    { id: "d2", applyTime: "2026-05-20 09:00:00", bank: "工商银行 ****8862", amount: 500000, status: "completed" },
    { id: "d3", applyTime: "2026-05-15 11:30:00", bank: "工商银行 ****8862", amount: -100000, status: "completed" },
  ]
}

// ===== 管理后台 =====

const ADMIN_USERS: AdminUser[] = [
  { id: "u1", username: "张三", phone: "138****1234", email: "zhangsan@example.com", registeredAt: "2026-03-15", realNameVerified: true, status: "active", riskRate: 32.5 },
  { id: "u2", username: "李四", phone: "139****5678", email: "lisi@example.com", registeredAt: "2026-04-01", realNameVerified: true, status: "active", riskRate: 85.2 },
  { id: "u3", username: "王五", phone: "137****9012", email: "wangwu@example.com", registeredAt: "2026-04-20", realNameVerified: false, status: "frozen", riskRate: 0 },
]

/** 获取模拟管理端用户列表 */
export function getMockAdminUsers(): AdminUser[] {
  return ADMIN_USERS
}

const ADMIN_CONTRACTS: AdminContract[] = [
  { code: "rb2610", name: "螺纹钢2510", exchange: "上期所", category: "黑色", multiplier: 10, minTick: 1, feeRate: 0.0001, marginRate: 0.10, status: "trading" },
  { code: "cu2607", name: "沪铜2607", exchange: "上期所", category: "有色", multiplier: 5, minTick: 10, feeRate: 0.00005, marginRate: 0.12, status: "trading" },
  { code: "au2612", name: "沪金2612", exchange: "上期所", category: "贵金属", multiplier: 1000, minTick: 0.02, feeRate: 0.0001, marginRate: 0.08, status: "trading" },
]

/** 获取模拟管理端合约列表 */
export function getMockAdminContracts(): AdminContract[] {
  return ADMIN_CONTRACTS
}

const SYSTEM_LOGS: SystemLog[] = [
  { id: "l1", time: "2026-05-29 10:30:15", level: "INFO", module: "交易引擎", message: "rb2610 撮合完成，成交量 1520 手" },
  { id: "l2", time: "2026-05-29 10:25:00", level: "WARN", module: "风控系统", message: "用户 u2 风险率达到 85.2%，已发送预警通知" },
  { id: "l3", time: "2026-05-29 09:00:00", level: "INFO", module: "系统", message: "系统启动完成，所有服务正常" },
  { id: "l4", time: "2026-05-28 23:50:00", level: "ERROR", module: "数据服务", message: "行情数据推送延迟 500ms，已自动恢复" },
]

/** 获取模拟系统日志 */
export function getMockSystemLogs(): SystemLog[] {
  return SYSTEM_LOGS
}
