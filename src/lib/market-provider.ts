import {collectionStatus} from './collection-config'
/** Desktop reads prefer the scoped Collection key. Never bypass a configured
 * relay on timeout, revoked permission, or unreadable encrypted configuration. */
let direct = false
export const directOkxMode = () => {
  if(!direct)return false
  const status=collectionStatus()
  return direct&&!status.configured&&!status.loading&&!status.configUnavailable
}
export function enableDirectOkxMode(): void { direct = true }
export const OKX_REST_BASE = 'https://www.okx.com'
export const OKX_WS_BASE = 'wss://ws.okx.com'
export function directPrivateSocketAddress(demo: boolean, business = false): string {
  return `${demo ? 'wss://wspap.okx.com' : OKX_WS_BASE}/ws/v5/${business ? 'business' : 'private'}`
}
