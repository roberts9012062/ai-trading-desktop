export type DonationKind = "crypto" | "wechat" | "alipay"
export interface DonationChannel { enabled: boolean; qr_image: string; address: string; network: string; currency: string }
export interface DonationConfig { enabled: boolean; crypto: DonationChannel; wechat: DonationChannel; alipay: DonationChannel }
export interface ListedDonation extends Omit<DonationChannel, "enabled"> { kind: DonationKind; label: string }
export interface PublicDonations { enabled: boolean; channels: ListedDonation[] }
export const donationLabels: Record<DonationKind, string> = { crypto: "虚拟币打赏", wechat: "微信打赏", alipay: "支付宝打赏" }
export const donationKinds: DonationKind[] = ["crypto", "wechat", "alipay"]
export function emptyDonations(): DonationConfig {
  const channel = (): DonationChannel => ({ enabled: false, qr_image: "", address: "", network: "", currency: "" })
  return { enabled: false, crypto: channel(), wechat: channel(), alipay: channel() }
}
const base = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")
async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("access_token")
  const response = await fetch(`${base}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store" })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map((r: {msg?: string}) => r.msg ?? "配置无效").join("；") : body.detail
    throw new Error(typeof detail === "string" ? detail : "打赏配置加载失败，请重试")
  }
  return body as T
}
export const getDonations = () => call<PublicDonations>("/api/donations")
export const getAdminDonations = () => call<DonationConfig>("/api/admin/donations")
export const saveDonations = (config: DonationConfig) => call<DonationConfig>("/api/admin/donations", { method: "PUT", body: JSON.stringify(config) })

export async function readDonationImage(file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024) throw new Error("二维码图片不能超过 2MB")
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("请选择 PNG、JPEG 或 WebP 图片")
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("读取图片失败，请重新选择"))
    reader.readAsDataURL(file)
  })
}
