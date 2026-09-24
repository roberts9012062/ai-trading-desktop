import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"
import test from "node:test"

const sourceUrl = new URL("./equity-data.ts", import.meta.url)

async function loadTaskPnlFunction() {
  const source = await readFile(sourceUrl, "utf8")
  const match = source.match(
    /export function taskLivePnl\([\s\S]*?^\}/m,
  )
  assert.ok(match, "taskLivePnl must remain directly testable")
  const executable = match[0]
    .replace("export ", "")
    .replace(/task: AITradingTask/g, "task")
    .replace(/_points: EquityPoint\[\] = \[\]/g, "points")
    .replace(/\): number/g, ")")
  return vm.runInNewContext(`(${executable.replace("function taskLivePnl", "function")})`)
}

async function loadHasOpenPositionFunction() {
  const source = await readFile(sourceUrl, "utf8")
  const match = source.match(
    /export function taskHasOpenPosition\([\s\S]*?^\}/m,
  )
  assert.ok(match, "taskHasOpenPosition must remain directly testable")
  const executable = match[0]
    .replace("export ", "")
    .replace(/task: AITradingTask/g, "task")
    .replace(/\): boolean/g, ")")
  return vm.runInNewContext(`(${executable.replace("function taskHasOpenPosition", "function")})`)
}

async function loadNotStartedBranchValue() {
  // lineForTradeSession 含 LineData[]/Time 等 TS 类型，无法用 vm 直接 eval。
  // 这里只校验「notStarted 分支返回的单点 value」是否等于 endValue——
  // 即修复点本身（原先 value: 0，修复后 value: endValue）。
  const source = await readFile(sourceUrl, "utf8")
  const notStartedBlock = source.match(
    /if \(notStarted\) \{\s*([\s\S]*?)\n\s*\}/,
  )
  assert.ok(
    notStartedBlock,
    "notStarted 分支必须保留，以便直接校验其返回值",
  )
  const body = notStartedBlock[1]
  // 不允许 value: 0（坍缩为零是原 BUG）
  assert.ok(
    !/value:\s*0\b/.test(body),
    "停盘等开盘时 Y 不得坍缩为 value: 0（原 BUG）",
  )
  // 必须返回 endValue（当前累计收益）
  assert.match(
    body,
    /value:\s*endValue\b/,
    "停盘等开盘时 Y 必须保留 endValue（当前累计收益）",
  )
  return true
}

test("open task shows only current unrealized pnl (not cumulative realized)", async () => {
  const taskLivePnl = await loadTaskPnlFunction()
  // 任务持多仓 1 手，当前浮盈 +50
  // 历史已平仓累计 realized = -80（不应叠加进对比图 Y 值）
  const task = {
    position_qty: 1,
    position_direction: "long",
    position_unrealized: 50,
  }
  const points = [{ realized_pnl: -80, unrealized_pnl: 50, cash_delta: -30 }]

  assert.equal(
    taskLivePnl(task, points),
    50,
    "开仓后 Y 值应只等于当前浮盈 unrealized，不叠加历史 realized",
  )
})

test("open losing position shows only its floating loss", async () => {
  const taskLivePnl = await loadTaskPnlFunction()
  // 持空仓浮亏 -20，历史 realized +100（不应叠加）
  const task = {
    position_qty: 1,
    position_direction: "short",
    position_unrealized: -20,
  }
  const points = [{ realized_pnl: 100, unrealized_pnl: -20, cash_delta: 80 }]

  assert.equal(taskLivePnl(task, points), -20)
})

test("flat task returns zero (filtered out of comparison anyway)", async () => {
  const taskLivePnl = await loadTaskPnlFunction()
  // 空仓：即便历史 realized 很高，对比图兜底返回 0
  const task = {
    position_qty: 0,
    position_direction: null,
    position_unrealized: 0,
  }
  const points = [{ realized_pnl: 500, unrealized_pnl: 0, cash_delta: 500 }]

  assert.equal(taskLivePnl(task, points), 0)
})

test("notStarted keeps endValue instead of zero on Y axis", async () => {
  // 直接校验修复点：notStarted 分支必须返回 value: endValue，而非坍缩为 0
  await loadNotStartedBranchValue()
})

test("taskHasOpenPosition filters out flat (no position) tasks", async () => {
  const taskHasOpenPosition = await loadHasOpenPositionFunction()
  // 已平仓：曾经下单 has_orders=true，但当前无仓
  const flatTask = {
    has_orders: true,
    has_open_position: false,
    position_qty: 0,
    position_direction: null,
  }
  assert.equal(
    taskHasOpenPosition(flatTask),
    false,
    "空仓任务（即便曾下单）不应进入对比图",
  )
  // 当前持多
  const longTask = {
    has_orders: true,
    has_open_position: true,
    position_qty: 1,
    position_direction: "long",
  }
  assert.equal(taskHasOpenPosition(longTask), true)
  // 从未下单
  const freshTask = {
    has_orders: false,
    has_open_position: false,
    position_qty: 0,
    position_direction: null,
  }
  assert.equal(taskHasOpenPosition(freshTask), false)
})
