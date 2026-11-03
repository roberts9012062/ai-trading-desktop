import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { loginHost } from "@/lib/taskhost-client";
import { loginStandalone } from "@/lib/taskhost-standalone";
import { BrandLogo } from "@/components/common/brand-logo";
import {selectedLocalHostProfile} from '@/lib/taskhost-local-profile';

export default function HostConnectionPage() {
  const localProfile=selectedLocalHostProfile();
  const navigate = useNavigate(),
    [mode, setMode] = useState<"server" | "standalone">("server");
  const [origin, setOrigin] = useState(() => {
    try {
      return (
        localStorage.getItem("cyclepilot_host_address") ||
        "http://127.0.0.1:8787"
      );
    } catch {
      return "http://127.0.0.1:8787";
    }
  });
  const [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "server") {
        const session = await loginHost(origin, key.trim());
        try {
          localStorage.setItem("cyclepilot_host_address", session.origin);
        } catch {
          /* Address persistence is optional. */
        }
      } else await loginStandalone(key.trim());
      setKey("");
      navigate("/task-hosting", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-h-full flex items-center justify-center bg-[var(--bg-primary)] p-6">
      <main className="w-full max-w-lg border border-[var(--border)] rounded-xl bg-[var(--bg-secondary)] p-8">
        <BrandLogo size={44} />
        <p className="text-xs tracking-widest text-emerald-500 mt-6">
          CYCLEPILOT / TASK HOST
        </p>
        <h1 className="text-2xl font-semibold mt-3">连接任务托管</h1>
        <p className="text-sm text-[var(--text-muted)] mt-3 mb-7">
          服务器在线时创建与同步任务。服务器不可用时，单机入口直接读取 API VALUE
          COLLECTION 的已有托管任务。
        </p>
        <div className="flex gap-2 mb-6" role="group" aria-label="登录方式">
          {(["server", "standalone"] as const).map((value) => (
            <button
              key={value}
              disabled={busy}
              onClick={() => {
                setMode(value);
                setKey("");
                setError("");
              }}
              className={`flex-1 rounded border px-3 py-2 text-sm ${mode === value ? "border-emerald-500 text-emerald-500" : "border-[var(--border)]"}`}
            >
              {value === "server" ? "服务器握手" : "单机登录"}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="space-y-5">
          {mode==='server'&&<p className="rounded border border-[var(--border)] p-3 text-xs text-[var(--text-muted)]">{localProfile?`连接成功后会自动同步当前本地实盘配置“${localProfile.label}”的 API Collection Key 和 OKX 凭证，由服务器重新读取账户及持仓。不会创建、启动或恢复任务。`:'当前没有选中的本地实盘配置。连接后可在托管页配置数据；不会扫描其他账号或匿名存储。'}</p>}
          {mode === "server" && (
            <label className="block text-sm">
              服务器 IP 或 HTTPS 地址
              <input
                className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="https://192.0.2.10:8787"
                autoComplete="url"
                required
                disabled={busy}
              />
            </label>
          )}
          <label className="block text-sm">
            {mode === "server"
              ? "后台签发的登录密钥"
              : "API VALUE COLLECTION Key"}
            <input
              className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              type="password"
              autoComplete="off"
              placeholder={mode === "server" ? "thk_…" : "ac_…"}
              required
              disabled={busy}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-400 break-words">
              {error}
            </p>
          )}
          <button
            disabled={busy}
            className="w-full rounded bg-emerald-700 p-3 text-white disabled:opacity-50"
          >
            {busy
              ? "正在验证连接…"
              : mode === "server"
                ? "握手并连接服务器"
                : "验证中心 Key 并进入单机模式"}
          </button>
        </form>
        <p className="mt-5 text-xs text-[var(--text-muted)]">
          {mode === "server"
            ? "首次启动后端，需要先在后端管理页面注册管理员并生成登录密钥。远程连接必须使用受信任的 HTTPS 证书。"
            : "单机模式不提供新建任务。Key 保存在本机原生安全存储中，已有任务的操作以接口中心能力和执行权校验结果为准。"}
        </p>
      </main>
    </div>
  );
}
