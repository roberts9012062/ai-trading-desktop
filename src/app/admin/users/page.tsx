"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import {
  Search,
  Eye,
  Snowflake,
  Sun,
  Plus,
  Trash2,
  RefreshCw,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { showConfirm } from "@/stores/dialog"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { UserCreateForm } from "@/components/admin/user-create-form"
import {
  deleteAdminUserApi,
  listAdminUsersApi,
  updateAdminUserApi,
  type AdminUserItem,
} from "@/lib/admin-api"

function formatTime(iso: string): string {
  if (!iso) return "-"
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false })
  } catch {
    return iso
  }
}

/** 用户管理 —— 真实后端 CRUD */
export default function AdminUsersPage(): React.JSX.Element {
  const [items, setItems] = useState<AdminUserItem[]>([])
  const [total, setTotal] = useState(0)
  const [keyword, setKeyword] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await listAdminUsersApi({
        keyword,
        status: statusFilter,
        limit: 50,
        offset: 0,
      })
      setItems(res.items)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [keyword, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  async function toggleFreeze(user: AdminUserItem): Promise<void> {
    const next = user.status === "active" ? "frozen" : "active"
    try {
      await updateAdminUserApi(user.id, { status: next })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败")
    }
  }

  async function handleDelete(user: AdminUserItem): Promise<void> {
    if (
      !(await showConfirm({
        title: "删除用户",
        description: `确认删除用户「${user.username}」？其交易与 AI 数据将一并删除。`,
        variant: "destructive",
        confirmText: "删除",
      }))
    ) {
      return
    }
    try {
      await deleteAdminUserApi(user.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败")
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">
          用户管理
          <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
            共 {total} 人
          </span>
        </h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" />
            刷新
          </Button>
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            <Plus className="w-3.5 h-3.5" />
            新增用户
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 rounded-md bg-[var(--accent-danger)]/15 text-[var(--accent-danger)] text-sm">
          {error}
        </div>
      )}

      {showCreate && (
        <UserCreateForm
          onCreated={async () => {
            setShowCreate(false)
            await load()
          }}
          onError={setError}
          onCancel={() => setShowCreate(false)}
        />
      )}

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              <Input
                placeholder="搜索用户名/手机号/邮箱"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-muted)]">状态：</span>
              {(["all", "active", "frozen"] as const).map((s) => (
                <Button
                  key={s}
                  variant={statusFilter === s ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStatusFilter(s)}
                >
                  {s === "all" ? "全部" : s === "active" ? "正常" : "冻结"}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户名</TableHead>
                <TableHead>手机号</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>注册时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>实盘权益</TableHead>
                <TableHead>虚拟盘权益</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center text-[var(--text-muted)] py-8"
                  >
                    加载中…
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                items.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="text-[var(--text-primary)] font-medium">
                      {user.username}
                    </TableCell>
                    <TableCell className="font-num">
                      {user.phone || "-"}
                    </TableCell>
                    <TableCell className="text-[var(--text-secondary)]">
                      {user.email || "-"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {user.role === "admin" ? "管理员" : "用户"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-num text-[var(--text-secondary)] text-xs">
                      {formatTime(user.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          user.status === "active" ? "up" : "destructive"
                        }
                      >
                        {user.status === "active" ? "正常" : "冻结"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-num text-sm">
                      <div>
                        ¥
                        {Number(
                          user.live_equity ?? user.total_equity ?? 0,
                        ).toLocaleString()}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        风险{" "}
                        {Number(
                          user.live_risk_rate ?? user.risk_rate ?? 0,
                        ).toFixed(1)}
                        %
                      </div>
                    </TableCell>
                    <TableCell className="font-num text-sm">
                      <div>
                        ¥
                        {Number(user.virtual_equity ?? 0).toLocaleString()}
                      </div>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        风险 {Number(user.virtual_risk_rate ?? 0).toFixed(1)}%
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 flex-wrap">
                        <Link href={`/admin/users/${user.id}`}>
                          <Button variant="ghost" size="sm">
                            <Eye className="w-3.5 h-3.5" />
                            查看
                          </Button>
                        </Link>
                        <Button
                          variant={
                            user.status === "active" ? "outline" : "default"
                          }
                          size="sm"
                          onClick={() => void toggleFreeze(user)}
                        >
                          {user.status === "active" ? (
                            <>
                              <Snowflake className="w-3.5 h-3.5" />
                              冻结
                            </>
                          ) : (
                            <>
                              <Sun className="w-3.5 h-3.5" />
                              解冻
                            </>
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleDelete(user)}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-[var(--accent-danger)]" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              {!loading && items.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center text-[var(--text-muted)] py-8"
                  >
                    暂无匹配用户
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
