/** Public GitHub reverse proxies verified against our manifest and installer. */
export const GITHUB_UPDATE_PROXIES = [
  "https://gh-proxy.com/",
  "https://ghfast.top/",
] as const
export const UPDATE_MANIFEST = "https://gist.githubusercontent.com/roberts9012062/373489c602619a435df63257d034849d/raw/latest.json"

export interface UpdateChannel { mirror?: string; proxy?: string }

/** Custom transport proxy first; default mirror pool next, direct last. */
export function updateChannels(custom: string | undefined): UpdateChannel[] {
  return [
    ...(custom ? [{ proxy: custom }] : []),
    ...GITHUB_UPDATE_PROXIES.map(mirror => ({ mirror })),
    {},
  ]
}

export function manifestEndpoint(channel: UpdateChannel, now = Date.now()): string {
  return `${channel.mirror ?? ""}${UPDATE_MANIFEST}?atd_check=${now}`
}
