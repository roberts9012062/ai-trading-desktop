/**
 * next/image → 原生 <img> 兼容 shim(当前业务代码暂无使用,保留备用)
 * 差异:无自动优化/懒加载策略;fill 模式用绝对定位铺满容器模拟。
 */
import type { CSSProperties } from "react"

interface NextImageProps {
  src: string
  alt: string
  width?: number | string
  height?: number | string
  fill?: boolean
  priority?: boolean
  sizes?: string
  quality?: number
  className?: string
  style?: CSSProperties
  placeholder?: string
  onLoad?: () => void
  onError?: () => void
}

export function Image({ src, alt, fill, width, height, style, ...rest }: NextImageProps) {
  // priority/sizes/quality/placeholder 为 Next 专属优化参数,不透传给原生 <img>
  const { priority: _priority, sizes: _sizes, quality: _quality, placeholder: _placeholder, ...imgRest } = rest
  const merged: CSSProperties | undefined = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...style }
    : style
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      style={merged}
      loading="lazy"
      {...(imgRest as Record<string, unknown>)}
    />
  )
}

export default Image
