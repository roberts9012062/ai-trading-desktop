/**
 * next/navigation → react-router 兼容 shim
 * 覆盖项目实际用到的 4 个 hook:useRouter / usePathname / useSearchParams / useParams。
 * 差异:refresh 用 navigate(0) 触发整页刷新;prefetch 为空实现。
 */
import {
  useLocation,
  useNavigate,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from "react-router-dom"

interface NextRouter {
  push: (href: string) => void
  replace: (href: string) => void
  back: () => void
  forward: () => void
  refresh: () => void
  prefetch: (href: string) => void
}

export function useRouter(): NextRouter {
  const navigate = useNavigate()
  return {
    push: (href) => navigate(href),
    replace: (href) => navigate(href, { replace: true }),
    back: () => navigate(-1),
    forward: () => navigate(1),
    refresh: () => navigate(0),
    prefetch: () => {},
  }
}

export function usePathname(): string {
  return useLocation().pathname
}

/** Next 版返回只读 URLSearchParams;react-router 版返回 [params, setter],这里只取 params 保持签名兼容 */
export function useSearchParams(): URLSearchParams {
  const [searchParams] = useRouterSearchParams()
  return searchParams
}

export function useParams<
  Params extends Record<string, string | undefined> = Record<string, string | undefined>,
>(): Params {
  return useRouterParams() as Params
}
