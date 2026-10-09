export function hunterPositionLimit(isAdmin: boolean, strategy?: string): number {
  return isAdmin ? (strategy === "hunter-pivot" ? 10 : 4) : 3
}

export function validateHunterPositions(value: number, limit: number): string | null {
  return Number.isInteger(value) && value >= 1 && value <= limit
    ? null : `同时运行的交易子任务数量须为 1～${limit} 个`
}
