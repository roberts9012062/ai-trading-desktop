/** Research configuration stays on the selected desktop profile, independently of the task server. */
import { invoke } from '@tauri-apps/api/core'
import { collectionScope, nativeCollection } from './collection-config'
import { desktopSessionUsesTaskHost } from './desktop-login-session'
import type { StrategyFile, TransferKind, TransferPreview } from './strategy-transfer'

type Config = Record<string, unknown>
interface Folder { id: string; kind: TransferKind; name: string; created_at: string }
interface Favorite { id: string; kind: TransferKind; folder_id: string | null; created_at: string; config: Config; note: string | null; model?: StrategyFile['items'][number]['model'] }
interface Document { version: 1; folders: Folder[]; favorites: Favorite[] }
const collection = 'local-strategy-favorites'
const queues = new Map<string, Promise<unknown>>()
const kinds: TransferKind[] = ['factor', 'shortline', 'task']
const taskFields = new Set('name icon symbol symbol_name timeframe extra_timeframes ai_bars_limit decision_interval_sec eval_interval_sec margin_per_trade leverage margin_mode funding_source strategy_type strategy_params model_row_id side_mode position_mode fixed_qty qty_min qty_max allocated_capital capital_usage_min_pct capital_usage_max_pct risk_style custom_prompt_enabled custom_prompt close_rules stop_rules max_profit_pct max_loss_pct loss_cooldown_enabled loss_cooldown_limit max_hold_days close_on_stop auto_start status_at_save'.split(' '))
const factorFields = new Set('name symbol timeframe tokens text composite metrics note'.split(' '))
const privateField = /^(?:api_?key|api_?secret|secret_?key|private_?key|password|passphrase|api_passphrase|access_token|refresh_token|credentials|credential_id|exchange_credential_id|host_credential_id|profit_lock_state|loss_cooldown_state|factor_entry_state|user_id|task_id)$/i
export const localFavoritesEnabled = () => desktopSessionUsesTaskHost()

function scope(): string {
  const user = JSON.parse(localStorage.getItem('qihuo_auth_user') || 'null')
  if (!user?.id || !['live', 'virtual'].includes(user.trading_mode)) throw new Error('请先选择本地账户配置')
  return `${collectionScope()}:favorites:${user.trading_mode}`
}
function active(expected: string) {
  if (!localFavoritesEnabled() || scope() !== expected) throw new Error('账户或交易盘已切换，请重新读取收藏')
}
function safe(value: unknown, depth = 0): void {
  if (depth > 30) throw new Error('收藏配置层级过深')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('收藏包含无效数值')
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (privateField.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('收藏配置不能包含账户密钥、身份或运行状态')
    safe(child, depth + 1)
  }
}
function config(kind: TransferKind, value: Config): Config {
  safe(value)
  const fields = kind === 'task' ? taskFields : factorFields
  if (Object.keys(value).some(key => !fields.has(key))) throw new Error('收藏配置包含不支持的字段，请使用导出的配置文件')
  if (kind !== 'task') {
    const tokens = value.tokens
    const groups = Array.isArray(tokens) && Array.isArray(tokens[0]) ? tokens : [tokens]
    if (!groups.length || groups.length > 256 || !groups.every(group => Array.isArray(group) && group.length > 0 && group.length <= 256 && group.every(token => Number.isInteger(token) && token >= 0 && token <= 10000))) throw new Error('收藏公式编码无效')
  }
  if (value.name != null && (typeof value.name !== 'string' || value.name.length > 120)) throw new Error('收藏名称不能超过 120 个字符')
  for (const [field, max] of [['symbol', 32], ['timeframe', 16], ['text', 20000], ['note', 500]] as const) {
    if (value[field] != null && (typeof value[field] !== 'string' || (value[field] as string).length > max)) throw new Error('收藏文本字段格式无效或超出长度限制')
  }
  if (value.composite != null && typeof value.composite !== 'number') throw new Error('收藏评分格式无效')
  if (value.metrics != null && (typeof value.metrics !== 'object' || Array.isArray(value.metrics))) throw new Error('收藏指标格式无效')
  const copy = structuredClone(value)
  // A saved preference never imports a running task or grants execution authority.
  if (kind === 'task') delete copy.auto_start
  return copy
}
function folderName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('文件夹名称须为 1–80 个字符')
  return value.trim()
}
function validateDocument(raw: unknown): Document {
  const doc = raw as Document
  if (!doc || doc.version !== 1 || !Array.isArray(doc.folders) || !Array.isArray(doc.favorites)
    || doc.folders.some(f => !f || !kinds.includes(f.kind) || typeof f.id !== 'string' || typeof f.name !== 'string')
    || doc.favorites.some(f => !f || !kinds.includes(f.kind) || typeof f.id !== 'string' || !f.config || typeof f.config !== 'object')) throw new Error('本地收藏数据格式损坏，请保留数据并从备份恢复')
  return structuredClone(doc)
}
async function read(expected: string): Promise<Document> {
  let value: unknown
  if (nativeCollection()) {
    try { value = (await invoke<{ value: unknown; deleted?: boolean } | null>('desktop_db', { scope: expected, action: 'get', collection, id: 'current', value: null }))?.value }
    catch { throw new Error('本地收藏读取失败，请检查客户端数据目录；不会改用旧服务器') }
  } else {
    const raw = localStorage.getItem(`${collection}:${expected}`)
    try { value = raw ? JSON.parse(raw) : undefined } catch { throw new Error('本地收藏数据无法读取，请保留数据并从备份恢复') }
  }
  active(expected)
  return value == null ? { version: 1, folders: [], favorites: [] } : validateDocument(value)
}
async function write(expected: string, doc: Document) {
  active(expected)
  const raw = JSON.stringify(doc)
  if (new TextEncoder().encode(raw).length > 4 * 1024 * 1024) throw new Error('本地收藏超过 4 MB，请先导出备份并分批整理；原数据已保留')
  try {
    if (nativeCollection()) await invoke('desktop_db', { scope: expected, action: 'put', collection, id: 'current', value: doc })
    else localStorage.setItem(`${collection}:${expected}`, raw)
  } catch { throw new Error('本地收藏保存未确认，请检查磁盘空间并刷新核对；不会改用旧服务器') }
  active(expected)
}
async function transaction<T>(change: boolean, work: (doc: Document) => T): Promise<T> {
  const expected = scope(), before = queues.get(expected) ?? Promise.resolve()
  const operation = before.catch(() => {}).then(async () => {
    active(expected)
    const doc = await read(expected), result = work(doc)
    if (change) await write(expected, doc)
    return structuredClone(result)
  })
  queues.set(expected, operation)
  try { return await operation } finally { if (queues.get(expected) === operation) queues.delete(expected) }
}
function folderFor(doc: Document, kind: TransferKind, id: unknown): string | null {
  if (id == null) return null
  if (typeof id !== 'string' || !doc.folders.some(f => f.id === id && f.kind === kind)) throw new Error('收藏文件夹不存在或分类不匹配')
  return id
}
function item(f: Favorite): Config {
  return f.kind === 'task'
    ? { id: f.id, folder_id: f.folder_id, task_id: null, note: f.note, snapshot: f.config, task: null, created_at: f.created_at }
    : { name: '', symbol: null, timeframe: null, text: '', composite: null, metrics: null, note: null, ...f.config, id: f.id, folder_id: f.folder_id, created_at: f.created_at }
}
const canonical = (v: unknown): string => JSON.stringify(v && typeof v === 'object' ? Array.isArray(v) ? v.map(e => JSON.parse(canonical(e))) : Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical((v as Config)[k]))])) : v ?? null)

/** Only these nonfinancial routes are intercepted. Never turn a task route into a local task. */
export async function tryLocalFavoriteRequest(path: string, options: RequestInit = {}): Promise<Response | null> {
  const url = new URL(path, 'http://favorites.invalid')
  const match = url.pathname.match(/^\/api\/(strategy-folders|factor-lab\/favorites|shortline\/favorites|ai-trading\/task-favorites)(?:\/([^/]+))?$/)
  if (!match || !localFavoritesEnabled()) return null
  options.signal?.throwIfAborted()
  const method = (options.method || 'GET').toUpperCase(), body = options.body ? JSON.parse(String(options.body)) as Config : {}
  const folders = match[1] === 'strategy-folders', id = match[2] ? decodeURIComponent(match[2]) : null
  const kind: TransferKind = folders ? (url.searchParams.get('kind') ?? body.kind) as TransferKind : match[1].startsWith('shortline') ? 'shortline' : match[1].startsWith('factor') ? 'factor' : 'task'
  const result = await transaction(method !== 'GET', doc => {
    if (folders) {
      if (!id && (!kinds.includes(kind))) throw new Error('收藏文件夹分类无效')
      if (method === 'GET' && !id) return { items: doc.folders.filter(f => f.kind === kind) }
      if (method === 'POST' && !id) {
        const name = folderName(body.name)
        if (doc.folders.some(f => f.kind === kind && f.name === name)) throw new Error('该分类已有同名文件夹')
        const folder = { id: crypto.randomUUID(), kind, name, created_at: new Date().toISOString() }
        doc.folders.push(folder); return folder
      }
      const folder = doc.folders.find(f => f.id === id)
      if (!folder) throw new Error('收藏文件夹不存在')
      if (method === 'PATCH') {
        const name = folderName(body.name)
        if (doc.folders.some(f => f.kind === folder.kind && f.id !== id && f.name === name)) throw new Error('该分类已有同名文件夹')
        folder.name = name; return folder
      }
      if (method === 'DELETE') {
        doc.folders = doc.folders.filter(f => f.id !== id)
        doc.favorites.forEach(f => { if (f.folder_id === id) f.folder_id = null }); return {}
      }
    } else {
      const rows = doc.favorites.filter(f => f.kind === kind)
      if (method === 'GET' && !id) return { items: rows.filter(f => !url.searchParams.get('symbol') || f.config.symbol === url.searchParams.get('symbol')).map(item) }
      if (method === 'POST' && id === 'reorder') {
        if (!Array.isArray(body.ids) || new Set(body.ids).size !== body.ids.length || body.ids.some(id => !rows.some(f => f.id === id))) throw new Error('收藏排序包含重复或无效编号')
        const ids = body.ids as string[], ordered = [...ids.map(id => rows.find(f => f.id === id)!), ...rows.filter(f => !ids.includes(f.id))]
        let index = 0; doc.favorites = doc.favorites.map(f => f.kind === kind ? ordered[index++] : f); return {}
      }
      if (method === 'POST' && !id) {
        if (kind === 'task') throw new Error('请先导入任务配置到收藏夹，再通过原有创建任务表单确认；不能按旧任务编号读取服务器任务')
        const { folder_id, ...payload } = body
        const favorite: Favorite = { id: crypto.randomUUID(), kind, folder_id: folderFor(doc, kind, folder_id), config: config(kind, payload), created_at: new Date().toISOString(), note: typeof payload.note === 'string' ? payload.note : null }
        doc.favorites.push(favorite); return item(favorite)
      }
      const favorite = rows.find(f => f.id === id)
      if (!favorite) throw new Error('本地收藏不存在，请刷新列表')
      if (method === 'DELETE') { doc.favorites = doc.favorites.filter(f => f.id !== id); return {} }
      if (method === 'PATCH') {
        if (Object.keys(body).some(k => !['folder_id', 'name', 'note'].includes(k))) throw new Error('不支持的收藏修改字段')
        if ('folder_id' in body) favorite.folder_id = folderFor(doc, kind, body.folder_id)
        const { folder_id: _folder, ...patch } = body
        favorite.config = config(kind, { ...favorite.config, ...patch }); return item(favorite)
      }
    }
    throw new Error('不支持的本地收藏操作')
  })
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
}
function checked(file: StrategyFile): StrategyFile {
  if (!file || file.format !== 'cyclepilot-strategies' || file.version !== 1 || !Array.isArray(file.items) || !file.items.length || file.items.length > 500) throw new Error('文件格式不受支持')
  if (new TextEncoder().encode(JSON.stringify(file)).length > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请分批导入')
  return { ...file, items: file.items.map(i => {
    if (!kinds.includes(i.kind) || i.encoding !== (i.kind === 'shortline' ? 'desktop-shortline-v1' : 'server-v3') || !i.config || typeof i.config !== 'object' || Array.isArray(i.config)) throw new Error('文件分类或公式编码无效')
    if (i.model) safe(i.model)
    if (i.folder != null) folderName(i.folder)
    return { ...i, config: config(i.kind, i.config) }
  }) }
}
export async function previewLocalFavorites(raw: StrategyFile): Promise<TransferPreview> {
  const file = checked(raw)
  return transaction(false, () => ({ models: [], items: file.items.map((i, index) => ({ index, kind: i.kind, name: String(i.config.name || '未命名配置'), symbol: typeof i.config.symbol === 'string' ? i.config.symbol : null, timeframe: typeof i.config.timeframe === 'string' ? i.config.timeframe : null, category: i.kind === 'shortline' ? '短线因子' : i.kind === 'factor' ? '因子' : 'AI 任务', folder: i.folder || '未分类', conflict: false, requires_model: false, model_row_id: null })) }))
}
export async function importLocalFavorites(raw: StrategyFile): Promise<{ imported: number; duplicates: number; items: { kind: TransferKind; id: string; created?: boolean }[] }> {
  const file = checked(raw)
  return transaction(true, doc => {
    let imported = 0, duplicates = 0
    const items = file.items.map(i => {
      const existing = doc.favorites.find(f => f.kind === i.kind && canonical(f.config) === canonical(i.config))
      if (existing) { duplicates++; return { kind: i.kind, id: existing.id } }
      let folder: Folder | undefined
      if (i.folder) {
        const name = folderName(i.folder)
        folder = doc.folders.find(f => f.kind === i.kind && f.name === name)
        if (!folder) { folder = { id: crypto.randomUUID(), kind: i.kind, name, created_at: new Date().toISOString() }; doc.folders.push(folder) }
      }
      const favorite: Favorite = { id: crypto.randomUUID(), kind: i.kind, config: i.config, folder_id: folder?.id ?? null, created_at: new Date().toISOString(), note: i.note ?? null, model: i.model }
      doc.favorites.push(favorite); imported++; return { kind: i.kind, id: favorite.id }
    })
    return { imported, duplicates, items }
  })
}
export async function exportLocalFavorites(kind: TransferKind | 'all', id?: string): Promise<StrategyFile> {
  return transaction(false, doc => {
    const favorites = doc.favorites.filter(f => (kind === 'all' || f.kind === kind) && (!id || f.id === id))
    if (!favorites.length) throw new Error('当前分类没有可导出的本地收藏')
    return { format: 'cyclepilot-strategies', version: 1, exported_at: new Date().toISOString(), items: favorites.map(f => ({ kind: f.kind, encoding: f.kind === 'shortline' ? 'desktop-shortline-v1' : 'server-v3', config: config(f.kind, f.config), folder: doc.folders.find(folder => folder.id === f.folder_id)?.name ?? null, note: f.note, ...(f.model ? { model: f.model } : {}) })) }
  })
}
