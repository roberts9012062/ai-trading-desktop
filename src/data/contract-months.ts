/**
 * 全品种交割月份合约清单 - 与后端 backend/app/data/contract_months.py 同步
 *
 * 不同交易所品种的交割月份规则不同:
 * - 上期所/大商所/郑商所/能源中心/广期所:多数是 1/5/9 或 1/5/10 月,或单月
 * - 中金所股指期货(IF/IC/IH/IM):当月、下月、随后两个季月(动态)
 * - 中金所国债期货(T/TF/TS/TL):最近 3 个季月(动态)
 *
 * symbol 格式:小写 code + YYMM,如 rb2610、au2612、if2606
 */

/** 各品种代码 → 常见交割月份数组(中金所股指和国债不在此处,用动态生成函数) */
export const CODE_MONTHS: Record<string, number[]> = {
  // 上期所 (SHFE)
  RB: [1, 5, 10], HC: [1, 5, 10], CU: [1, 5, 9], AL: [1, 5, 9],
  ZN: [1, 5, 9], PB: [1, 5, 9], NI: [1, 5, 9], SN: [1, 5, 9],
  AU: [2, 4, 6, 8, 10, 12], AG: [2, 4, 6, 8, 10, 12],
  SS: [1, 5, 9], BU: [1, 5, 9], RU: [1, 3, 5, 7, 9, 11],
  NR: [1, 5, 9], SP: [1, 5, 9], WR: [1, 5, 10],

  // 大商所 (DCE)
  I: [1, 5, 9], J: [1, 5, 9], JM: [1, 5, 9], M: [1, 5, 9],
  Y: [1, 5, 9], P: [1, 5, 9], C: [1, 3, 5, 7, 9, 11],
  CS: [1, 3, 5, 7, 9, 11], A: [1, 3, 5, 7, 9, 11], B: [1, 3, 5, 7, 9, 11],
  JD: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], RR: [1, 5, 9],
  L: [1, 5, 9], V: [1, 5, 9], PP: [1, 5, 9], EG: [1, 5, 9],
  EB: [1, 5, 9], PG: [1, 5, 9], FB: [1, 5, 9], BB: [1, 5, 9],

  // 郑商所 (CZCE)
  CF: [1, 3, 5, 7, 9, 11], CY: [1, 3, 5, 7, 9, 11], SR: [1, 3, 5, 7, 9, 11],
  TA: [1, 3, 5, 7, 9, 11], MA: [1, 3, 5, 7, 9, 11], FG: [1, 3, 5, 7, 9, 11],
  SA: [1, 3, 5, 7, 9, 11], UR: [1, 3, 5, 7, 9, 11], AP: [1, 3, 5, 7, 9, 10, 11, 12],
  CJ: [1, 3, 5, 7, 9, 11], WH: [1, 3, 5, 7, 9, 11], PM: [1, 3, 5, 7, 9, 11],
  RI: [1, 3, 5, 7, 9, 11], RS: [1, 3, 5, 7, 9, 11], RM: [1, 3, 5, 7, 9, 11],
  OI: [1, 3, 5, 7, 9, 11], PF: [1, 3, 5, 7, 9, 11], SH: [1, 3, 5, 7, 9, 11],
  LH: [1, 3, 5, 7, 9, 11],

  // 广期所 (GFEX)
  SI: [1, 5, 9], LC: [1, 5, 9],

  // 能源中心 (INE)
  SC: [1, 3, 5, 7, 9], LU: [1, 3, 5, 7, 9], BC: [1, 3, 5, 7, 9],
  EC: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
}

/** 中金所股指期货品种 */
export const CFFEX_INDEX_CODES: ReadonlySet<string> = new Set(["IF", "IC", "IH", "IM"])

/** 中金所国债期货品种 */
export const CFFEX_BOND_CODES: ReadonlySet<string> = new Set(["T", "TF", "TS", "TL"])

const QUARTER_MONTHS = [3, 6, 9, 12]

/** 中金所股指期货的月份:当月、下月、随后两个季月 */
export function generateCffexIndexMonths(now: Date): Array<{ year: number; month: number }> {
  const year = now.getFullYear()
  const month = now.getMonth() + 1

  const result: Array<{ year: number; month: number }> = [
    { year, month },
  ]

  // 下月
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  result.push(next)

  // 随后两个季月(在下月之后)
  let cur = next
  let count = 0
  while (count < 2) {
    const future = cur.month === 12 ? { year: cur.year + 1, month: 1 } : { year: cur.year, month: cur.month + 1 }
    cur = future
    if (QUARTER_MONTHS.includes(cur.month)) {
      result.push(cur)
      count++
    }
  }
  return result
}

/** 中金所国债期货的月份:最近 3 个季月(3/6/9/12) */
export function generateBondMonths(now: Date): Array<{ year: number; month: number }> {
  const result: Array<{ year: number; month: number }> = []
  let year = now.getFullYear()
  let month = now.getMonth() + 1

  while (result.length < 3) {
    if (QUARTER_MONTHS.includes(month)) {
      result.push({ year, month })
    }
    if (month === 12) {
      year++
      month = 1
    } else {
      month++
    }
  }
  return result
}

/** 判断是否为中金所股指品种 */
export function isCffexIndex(code: string): boolean {
  return CFFEX_INDEX_CODES.has(code)
}

/** 判断是否为中金所国债品种 */
export function isCffexBond(code: string): boolean {
  return CFFEX_BOND_CODES.has(code)
}

/** 生成 symbol:小写 code + 2位年 + 2位月,如 rb2610 */
export function makeSymbol(code: string, year: number, month: number): string {
  return `${code.toLowerCase()}${year % 100}${month.toString().padStart(2, "0")}`
}
