"use client"

/**
 * AI 本地直连开关 —— 用户自己的 API key 直连 OpenAI 兼容接口
 * key 只存本机 localStorage,不经过服务器。开启后聊天走本地直连
 * (纯聊天,无工具/知识库/子代理);关闭则恢复服务端模式。
 */

import { useEffect, useState } from "react"
import { Plug, Check, X, Trash2 } from "lucide-react"
import {
  getLocalAiConfig,
  saveLocalAiConfig,
  type LocalAiConfig,
  type LocalAiProvider,
} from "@/lib/local-ai"

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function LocalAiSwitch(): React.JSX.Element {
  const [config, setConfig] = useState<LocalAiConfig>(() => getLocalAiConfig())
  const [open, setOpen] = useState(false)
  // 编辑态(provider id 正在编辑);'' = 列表视图
  const [editingId, setEditingId] = useState("")

  useEffect(() => {
    saveLocalAiConfig(config)
  }, [config])

  const activeProvider = config.providers.find((p) => p.id === config.activeProviderId)
  const activeLabel =
    config.enabled && activeProvider
      ? `${activeProvider.name}/${config.activeModel}`
      : "本地直连关"

  const patchProvider = (id: string, patch: Partial<LocalAiProvider>) => {
    setConfig((c) => ({
      ...c,
      providers: c.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
  }

  const addProvider = () => {
    const id = uid()
    setConfig((c) => ({
      ...c,
      providers: [
        ...c.providers,
        { id, name: "新 Provider", baseUrl: "https://api.deepseek.com/v1", apiKey: "", models: ["deepseek-chat"] },
      ],
    }))
    setEditingId(id)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="本地直连:用自己的 API Key 直连 OpenAI 兼容接口"
        className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors border ${
          config.enabled
            ? "border-emerald-600 text-emerald-400 bg-emerald-950/40"
            : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        }`}
      >
        <Plug className="w-3.5 h-3.5" />
        <span className="max-w-40 truncate">{activeLabel}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-96 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] shadow-xl p-3 text-xs">
          {/* 开关 */}
          <label className="flex items-center justify-between mb-2 cursor-pointer">
            <span className="text-[var(--text-primary)] font-medium">
              本地直连{config.enabled ? "(聊天不走服务器)" : "(关闭,走服务器)"}
            </span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
            />
          </label>

          {editingId === "" ? (
            <>
              {/* provider 列表 */}
              {config.providers.map((p) => (
                <div key={p.id} className="flex items-center gap-1 py-1">
                  <button
                    onClick={() =>
                      setConfig((c) => ({
                        ...c,
                        activeProviderId: p.id,
                        activeModel: p.models[0] ?? c.activeModel,
                      }))
                    }
                    className={`flex-1 text-left truncate rounded px-2 py-1 ${
                      config.activeProviderId === p.id
                        ? "bg-emerald-950/40 text-emerald-400"
                        : "hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {config.activeProviderId === p.id ? "● " : "○ "}
                    {p.name} ({p.models.length} 模型)
                  </button>
                  <button
                    onClick={() => setEditingId(p.id)}
                    className="px-1.5 py-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                    title="编辑"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() =>
                      setConfig((c) => ({
                        ...c,
                        providers: c.providers.filter((x) => x.id !== p.id),
                        activeProviderId: c.activeProviderId === p.id ? "" : c.activeProviderId,
                      }))
                    }
                    className="px-1.5 py-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <button
                onClick={addProvider}
                className="mt-1 w-full rounded border border-dashed border-[var(--border)] py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                + 添加 Provider(OpenAI 兼容)
              </button>

              {/* 模型选择 */}
              {activeProvider && activeProvider.models.length > 0 && (
                <div className="mt-2 border-t border-[var(--border)] pt-2">
                  <div className="text-[var(--text-muted)] mb-1">当前模型</div>
                  <div className="flex flex-wrap gap-1">
                    {activeProvider.models.map((m) => (
                      <button
                        key={m}
                        onClick={() => setConfig((c) => ({ ...c, activeModel: m }))}
                        className={`px-2 py-0.5 rounded border ${
                          config.activeModel === m
                            ? "border-emerald-600 text-emerald-400"
                            : "border-[var(--border)] text-[var(--text-secondary)]"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="mt-2 flex justify-end">
                <button
                  onClick={() => setOpen(false)}
                  className="rounded border border-[var(--border)] px-3 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <Check className="w-3.5 h-3.5 inline mr-1" />
                  完成
                </button>
              </div>
            </>
          ) : (
            (() => {
              const p = config.providers.find((x) => x.id === editingId)
              if (!p) return null
              const inputCls =
                "w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1 text-[var(--text-primary)]"
              return (
                <div className="space-y-2">
                  <div>
                    <div className="text-[var(--text-muted)] mb-1">名称</div>
                    <input className={inputCls} value={p.name} onChange={(e) => patchProvider(p.id, { name: e.target.value })} />
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] mb-1">Base URL(OpenAI 兼容,含 /v1)</div>
                    <input className={inputCls} value={p.baseUrl} onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value.trim() })} />
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] mb-1">API Key(仅存本机,不上传)</div>
                    <input className={inputCls} type="password" value={p.apiKey} onChange={(e) => patchProvider(p.id, { apiKey: e.target.value.trim() })} />
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)] mb-1">模型列表(逗号分隔)</div>
                    <input
                      className={inputCls}
                      value={p.models.join(", ")}
                      onChange={(e) =>
                        patchProvider(p.id, {
                          models: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
                        })
                      }
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditingId("")}
                      className="rounded border border-[var(--border)] px-3 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      <X className="w-3.5 h-3.5 inline mr-1" />
                      返回
                    </button>
                  </div>
                </div>
              )
            })()
          )}
        </div>
      )}
    </div>
  )
}
