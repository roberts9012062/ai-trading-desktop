"use client"

/**
 * 实盘交易所凭证管理 —— OKX / Binance(币安) / Gate(芝麻开门)
 *
 * 每所一套 API 凭证（OKX 需额外 passphrase），可绑定该所模拟盘环境：
 * - OKX Demo Trading / Binance demo-fapi / Gate 期货 testnet
 * Secret AES-256-GCM 加密入库，界面只回显掩码。
 */

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react"
import {
  VENUES,
  deleteCredentialApi,
  getCredentialsApi,
  saveCredentialApi,
  testCredentialApi,
  type TradingVenue,
  type VenueCredential,
} from "@/lib/live-api"

type EditState = {
  apiKey: string
  secret: string
  passphrase: string
  demo: boolean
}

const EMPTY: EditState = { apiKey: "", secret: "", passphrase: "", demo: false }

function VenueCard({
  venue,
  name,
  credential,
  onSaved,
}: {
  venue: TradingVenue
  name: string
  credential: VenueCredential | undefined
  onSaved: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<EditState>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    if (credential) {
      setForm((f) => ({ ...f, demo: credential.demo }))
    }
  }, [credential])

  const save = async () => {
    setError("")
    setMessage("")
    if (!form.apiKey.trim()) {
      setError("请填写 API Key")
      return
    }
    if (!form.secret.trim() && !credential) {
      setError("首次配置必须填写 Secret")
      return
    }
    setBusy(true)
    try {
      const res = await saveCredentialApi({
        venue,
        api_key: form.apiKey.trim(),
        secret: form.secret.trim(),
        passphrase: venue === "okx" ? form.passphrase.trim() : "",
        demo: form.demo,
      })
      if (res.ok === false) {
        setError(res.error ?? "保存失败")
      } else {
        setMessage("已保存")
        setForm((f) => ({ ...f, secret: "", passphrase: "" }))
        setEditing(false)
        onSaved()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setError("")
    setMessage("")
    setTesting(true)
    try {
      const res = await testCredentialApi(venue)
      if (res.ok) {
        setMessage(`连通正常 · 权益 ${Number(res.equity ?? 0).toFixed(2)} USDT${res.demo ? "（模拟盘）" : ""}`)
      } else {
        setError(res.error ?? "连通失败")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "连通失败")
    } finally {
      setTesting(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await deleteCredentialApi(venue)
      setMessage("已删除凭证")
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败")
    } finally {
      setBusy(false)
    }
  }

  const configured = Boolean(credential)

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{name}</span>
        {configured ? (
          credential!.last_check_ok === true ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--accent-up)]">
              <ShieldCheck className="w-3 h-3" /> 已连通
            </span>
          ) : credential!.last_check_ok === false ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--accent-danger)]">
              <ShieldAlert className="w-3 h-3" /> 连通异常
            </span>
          ) : (
            <span className="text-[10px] text-[var(--text-muted)]">已配置</span>
          )
        ) : (
          <span className="text-[10px] text-[var(--text-muted)]">未配置</span>
        )}
        {credential?.demo && (
          <span className="text-[10px] px-1 rounded bg-[var(--accent-warn)]/15 text-[var(--accent-warn)]">
            模拟盘
          </span>
        )}
        {configured && (
          <span className="ml-auto font-num text-[10px] text-[var(--text-muted)]">
            {credential!.api_key_masked}
          </span>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">API Key</Label>
              <Input
                className="h-8 text-xs font-num"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder={credential ? credential.api_key_masked : "输入 API Key"}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Secret{configured ? "（留空保留原值）" : ""}</Label>
              <Input
                className="h-8 text-xs font-num"
                type="password"
                value={form.secret}
                onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                placeholder="输入 Secret"
              />
            </div>
          </div>
          {venue === "okx" && (
            <div className="space-y-1">
              <Label className="text-xs">Passphrase（OKX 专用）</Label>
              <Input
                className="h-8 text-xs font-num"
                type="password"
                value={form.passphrase}
                onChange={(e) => setForm((f) => ({ ...f, passphrase: e.target.value }))}
                placeholder={configured ? "留空保留原值" : "输入口令"}
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={form.demo}
              onChange={(e) => setForm((f) => ({ ...f, demo: e.target.checked }))}
            />
            模拟盘凭证（OKX Demo / Binance demo-fapi / Gate testnet）
          </label>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void save()}>
              {busy && <Loader2 className="w-3 h-3 animate-spin" />}保存
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => {
                setEditing(false)
                setError("")
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {configured ? (
            <>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={testing} onClick={() => void test()}>
                {testing && <Loader2 className="w-3 h-3 animate-spin" />}测试连通
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditing(true)}>
                更新
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs text-[var(--accent-danger)]" disabled={busy} onClick={() => void remove()}>
                删除
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditing(true)}>
              配置 API 凭证
            </Button>
          )}
        </div>
      )}

      {error && <p className="text-[11px] text-[var(--accent-danger)] break-all">{error}</p>}
      {credential?.last_error && !error && (
        <p className="text-[10px] text-[var(--text-muted)] break-all">{credential.last_error}</p>
      )}
      {message && <p className="text-[11px] text-[var(--accent-up)]">{message}</p>}
    </div>
  )
}

export function ExchangeCredentialsPanel(): React.JSX.Element {
  const [credentials, setCredentials] = useState<VenueCredential[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = async () => {
    try {
      setCredentials(await getCredentialsApi())
    } catch {
      setCredentials([])
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">实盘交易所接入</h3>
        <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
          三所对等接入 · 凭证加密存储 · 实盘下单前请先测试连通
        </p>
      </div>
      {loaded ? (
        <div className="grid gap-3 md:grid-cols-3">
          {VENUES.map((v) => (
            <VenueCard
              key={v.venue}
              venue={v.venue}
              name={v.name}
              credential={credentials.find((c) => c.venue === v.venue)}
              onSaved={() => void load()}
            />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载凭证配置…
        </div>
      )}
      <p className={cn("text-[10px] text-[var(--text-muted)]")}>
        安全提示：API Key 仅开启「合约交易」权限，禁止提币权限；Secret 使用 AES-256-GCM 加密存储，可随时在交易所侧吊销。
      </p>
    </div>
  )
}
