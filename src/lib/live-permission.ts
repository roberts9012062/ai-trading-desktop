export const REAL_TRADING_PROTECTION_MESSAGE = "本项目处于实验探索阶段。为保护用户资金安全，暂不开放未经管理员批准的实盘接入和真实资金交易。请使用 OKX 模拟盘或虚拟盘进行研究体验。"

export function canConnectExchange(demo: boolean, approved: boolean): boolean {
  return demo || approved
}

export function isRealTradingProtection(error: unknown): boolean {
  return error instanceof Error && error.message.includes("未经管理员批准")
}
