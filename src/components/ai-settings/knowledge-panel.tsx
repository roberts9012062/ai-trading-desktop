"use client"

import { useEffect, useState } from "react"
import { FileText, Trash2, RefreshCw, Loader2, Upload } from "lucide-react"
import {
  getKnowledgeDocuments,
  deleteKnowledgeDocument,
  uploadKnowledgeDocument,
  type KnowledgeDocument,
} from "@/lib/api"

/** 知识库文档管理面板 */
export function KnowledgePanel(): React.JSX.Element {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function fetchDocs() {
    setLoading(true)
    try {
      const docs = await getKnowledgeDocuments()
      setDocuments(docs)
    } catch {
      // 静默失败
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDocs()
  }, [])

  async function handleDelete(documentId: string) {
    setDeleting(documentId)
    try {
      await deleteKnowledgeDocument(documentId)
      setDocuments((prev) => prev.filter((d) => d.document_id !== documentId))
    } catch {
      // 静默失败
    } finally {
      setDeleting(null)
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ""
    setUploading(true)
    try {
      await uploadKnowledgeDocument(file)
      await fetchDocs()
    } catch {
      // 静默失败
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">知识库文档</h2>
        <div className="flex items-center gap-1">
          <input
            type="file"
            accept=".pdf,.txt,.md,.csv"
            className="hidden"
            onChange={handleUpload}
            id="knowledge-upload-settings"
          />
          <button
            onClick={() => document.getElementById("knowledge-upload-settings")?.click()}
            disabled={uploading}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="上传文档"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          </button>
          <button
            onClick={fetchDocs}
            disabled={loading}
            className="p-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* 文档列表 */}
      <div className="flex-1 overflow-y-auto">
        {loading && documents.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-xs text-[var(--text-muted)]">
            <Loader2 size={16} className="animate-spin mr-2" /> 加载中...
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-xs text-[var(--text-muted)] gap-2">
            <FileText size={24} />
            <span>暂无文档，点击上方上传按钮添加</span>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {documents.map((doc) => (
              <div
                key={doc.document_id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <FileText size={16} className="text-[var(--text-muted)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-[var(--text-primary)] truncate">
                    {doc.document_name}
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                    {doc.chunk_count} 个分块
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(doc.document_id)}
                  disabled={deleting === doc.document_id}
                  className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 shrink-0"
                  title="删除文档"
                >
                  {deleting === doc.document_id ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部统计 */}
      {documents.length > 0 && (
        <div className="px-4 py-2 border-t border-[var(--border)] text-[10px] text-[var(--text-muted)]">
          共 {documents.length} 个文档，{documents.reduce((s, d) => s + d.chunk_count, 0)} 个分块
        </div>
      )}
    </div>
  )
}
