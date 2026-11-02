import type { CenterSnapshotInfo } from '@/lib/taskhost-snapshot'

interface Props {
  available: boolean
  busy: boolean
  info?: CenterSnapshotInfo
  onSync: () => void
  onRead: () => void
}

export function SnapshotPanel({ available, busy, info, onSync, onRead }: Props) {
  return <section className="mt-4 border-t border-[var(--border)] pt-3" aria-label="中心检查点">
    <div className="flex flex-wrap gap-3">
      <button className="rounded border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-40" disabled={busy || !available} onClick={onSync}>同步检查点</button>
      <button className="rounded border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-40" disabled={busy || !available} onClick={onRead}>读取已存检查点</button>
    </div>
    {info ? <p className="mt-3 text-sm text-[var(--text-secondary)]">
      已存版本 {info.checkpoint_seq} · {info.record_count} 条状态 · {info.task_count} 个任务<br />
      同步时间：{new Date(info.synced_at).toLocaleString('zh-CN')}
    </p> : <p className="mt-3 text-xs text-[var(--text-muted)]">{available ? '尚未读取已存检查点。' : '请更新 Go 服务器至 v0.1.1 或以上，以使用检查点同步。'}</p>}
    <p className="mt-2 text-xs text-[var(--text-muted)]">检查点加密保存在服务器，仅供状态核对；已保存不代表已取得执行权，也不会启动任务。</p>
  </section>
}
