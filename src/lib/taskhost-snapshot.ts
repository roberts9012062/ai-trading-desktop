import { hostRequest } from './taskhost-client'

/** Counters stay decimal strings so JavaScript cannot round center versions. */
export interface CenterSnapshotInfo {
  account_id: string
  revision: string
  checkpoint_seq: string
  epoch: string
  record_count: number
  task_count: number
  synced_at: string
}

const accountPattern = /^[a-f0-9]{64}$/
function counter(value: unknown, positive = false): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,18})$/.test(value)
    && BigInt(value) <= 9223372036854775807n && (!positive || value !== '0')
}
function parseInfo(body: Record<string, unknown>, account: string): CenterSnapshotInfo {
  if (body.execution_authority !== false) throw new Error('检查点不能代表执行权，服务器响应无效')
  const info = body.snapshot as Partial<CenterSnapshotInfo> | undefined
  if (!info || info.account_id !== account || !counter(info.revision, true) || !counter(info.checkpoint_seq)
    || !counter(info.epoch) || !Number.isSafeInteger(info.record_count) || info.record_count! < 0 || info.record_count! > 100000
    || !Number.isSafeInteger(info.task_count) || info.task_count! < 0 || info.task_count! > 5000
    || typeof info.synced_at !== 'string' || !Number.isFinite(Date.parse(info.synced_at))) {
    throw new Error('服务器检查点元数据无效，请重新同步核对')
  }
  return { account_id: account, revision: info.revision, checkpoint_seq: info.checkpoint_seq, epoch: info.epoch,
    record_count: info.record_count!, task_count: info.task_count!, synced_at: info.synced_at }
}

/** Explicit read-only center pull through the authenticated server; never retried. */
export async function syncCenterSnapshot(account: string): Promise<CenterSnapshotInfo> {
  if (!accountPattern.test(account)) throw new Error('中心账户编号无效')
  const body = await hostRequest<Record<string, unknown>>('/api/v1/collection/snapshots', {
    method: 'POST', body: JSON.stringify({ account_id: account }),
  })
  return parseInfo(body, account)
}

/** Reads stored historical metadata without contacting the center. */
export async function readCenterSnapshot(account: string): Promise<CenterSnapshotInfo> {
  if (!accountPattern.test(account)) throw new Error('中心账户编号无效')
  return parseInfo(await hostRequest<Record<string, unknown>>(`/api/v1/collection/snapshots/${account}`), account)
}
