/** Activated by desktop boot. Unit tests and legacy integrations remain explicit. */
let direct = false
export const directOkxMode = () => direct
export function enableDirectOkxMode(): void { direct = true }
export const OKX_REST_BASE = 'https://www.okx.com'
export const OKX_WS_BASE = 'wss://ws.okx.com'
export function directPrivateSocketAddress(demo: boolean, business = false): string {
  return `${demo ? 'wss://wspap.okx.com' : OKX_WS_BASE}/ws/v5/${business ? 'business' : 'private'}`
}
