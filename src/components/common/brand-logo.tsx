/** The same generated master is used in the app, installer and system taskbar. */
export function BrandLogo({ size = 32 }: { size?: number }): React.JSX.Element {
  return <img
    src={size > 64 ? "/brand/256x256.png" : "/brand/64x64.png"}
    width={size}
    height={size}
    alt="周期领航 CyclePilot"
    className="shrink-0 object-contain"
  />
}
