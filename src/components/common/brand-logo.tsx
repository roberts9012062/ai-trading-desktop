/**
 * 品牌图标(与桌面图标同设计语言):深蓝渐变圆角底 + 上涨K线 + 比特币 ₿ 徽章
 * 替换原 qihuo 的 "Q" 字 logo;用于登录/注册页与顶栏。
 */
export function BrandLogo({ size = 32 }: { size?: number }): React.JSX.Element {
  const id = `brand-g-${size}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="AI Trading Desktop"
      style={{ borderRadius: "22%", flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0B1220" />
          <stop offset="1" stopColor="#1D2B4F" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="64" height="64" rx="14" fill={`url(#${id})`} />
      {/* K线:红/绿/红/大阳线,低到高 */}
      <rect x="12.6" y="35" width="1.4" height="14.4" rx="0.7" fill="#EF4444" />
      <rect x="10.6" y="37.5" width="5.4" height="8.1" rx="1.1" fill="#EF4444" />
      <rect x="22.6" y="28.8" width="1.4" height="16.2" rx="0.7" fill="#22C55E" />
      <rect x="20.4" y="31.3" width="5.8" height="10" rx="1.1" fill="#22C55E" />
      <rect x="32.6" y="33.1" width="1.4" height="11" rx="0.7" fill="#F87171" />
      <rect x="30.6" y="35" width="5.4" height="5.3" rx="1.1" fill="#F87171" />
      <rect x="43.1" y="18.1" width="1.8" height="18.1" rx="0.9" fill="#4ADE80" />
      <rect x="40.6" y="20.6" width="6.8" height="12.5" rx="1.2" fill="#4ADE80" />
      {/* ₿ 徽章 */}
      <circle cx="48.5" cy="14" r="8.6" fill="#F7931A" />
      <text
        x="48.5"
        y="14"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="900"
        fontSize="11.5"
        fill="#FFFFFF"
      >
        B
      </text>
      <rect x="42.6" y="11.6" width="5.6" height="1.7" rx="0.85" fill="#F7931A" />
      <rect x="42.6" y="15.1" width="5.6" height="1.7" rx="0.85" fill="#F7931A" />
    </svg>
  )
}
