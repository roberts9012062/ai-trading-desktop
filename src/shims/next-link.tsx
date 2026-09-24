/**
 * next/link → react-router 兼容 shim
 * 业务代码零改动:vite.config.ts 把 "next/link" 别名指向本文件。
 * 差异:忽略 prefetch/scroll 等 Next 专属 props;外链与锚点降级为原生 <a>。
 */
import { Link as RouterLink } from "react-router-dom"
import type { CSSProperties, MouseEventHandler, ReactNode } from "react"

interface NextLinkProps {
  href: string
  replace?: boolean
  prefetch?: boolean
  scroll?: boolean
  className?: string
  style?: CSSProperties
  target?: string
  title?: string
  id?: string
  "aria-label"?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
  children?: ReactNode
}

function isExternal(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href) || href.startsWith("#")
}

export function Link({ href, replace, children, ...rest }: NextLinkProps) {
  if (isExternal(href)) {
    return (
      <a href={href} {...(rest as Record<string, unknown>)}>
        {children}
      </a>
    )
  }
  return (
    <RouterLink to={href} replace={replace} {...(rest as Record<string, unknown>)}>
      {children}
    </RouterLink>
  )
}

export default Link
