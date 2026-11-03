import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { initializeDesktopLoginSession, completeDesktopLogin } from './desktop-login-session'
import { addShortlineFavorite, listShortlineFavorites, moveShortlineFavorite } from './shortline/server-api'
import { listFolders, createFolder, deleteFolder, listTaskFavorites } from './strategy-favorites-api'
import { addFactorFavorite, listFactorFavorites } from './factor-lab-api'
import { strategyTransfer, type StrategyFile } from './strategy-transfer'
import { exportLocalFavorites } from './local-strategy-favorites'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const fetchMock = vi.fn()
let values: Map<string, string>
function profile(id = 'owner', mode = 'live') { localStorage.setItem('qihuo_auth_user', JSON.stringify({ id, trading_mode: mode })) }
beforeEach(() => {
  vi.clearAllMocks(); values = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  vi.stubGlobal('fetch', fetchMock)
  initializeDesktopLoginSession('favorites-test', localStorage); completeDesktopLogin('local', 'taskhost')
  profile(); localStorage.setItem('atd_desktop_server', 'https://legacy.fixture')
  fetchMock.mockRejectedValue(new Error('old server must not be contacted'))
})
afterEach(() => vi.unstubAllGlobals())
const short = { name: '短线原配方', symbol: 'btcusdt', timeframe: '5m', tokens: [52, 0, 128], metrics: { annual_return: 12, evolution_recipe: { groups: [[52, 0, 128]], weights: [1] } } }
it('persists favorites and folders locally, preserves formula dialect and unfiles rather than deleting folder contents', async () => {
  const folder = await createFolder('shortline', '本地短线')
  const favorite = await addShortlineFavorite(short)
  await moveShortlineFavorite(favorite.id, folder.id)
  expect(await listFolders('shortline')).toEqual([folder])
  expect((await listShortlineFavorites())[0]).toMatchObject({ ...short, folder_id: folder.id })
  await deleteFolder(folder.id)
  expect(await listFolders('shortline')).toEqual([])
  expect((await listShortlineFavorites())[0]).toMatchObject({ ...short, folder_id: null })
  expect(await listShortlineFavorites('ethusdt')).toEqual([])
  expect(fetchMock).not.toHaveBeenCalled()
})
it('isolates users and trading modes while keeping the same profile when connecting to a different Go host', async () => {
  await addShortlineFavorite(short)
  profile('another'); expect(await listShortlineFavorites()).toEqual([])
  profile('owner', 'virtual'); expect(await listShortlineFavorites()).toEqual([])
  profile(); localStorage.setItem('cyclepilot_host_address', 'http://different.fixture:8788')
  expect(await listShortlineFavorites()).toHaveLength(1)
})
it('serializes concurrent writes without replacing existing favorites and keeps factor/shortline recipes separate', async () => {
  await Promise.all([addShortlineFavorite(short), addShortlineFavorite({ ...short, name: '第二项' }), addFactorFavorite({ name: '因子', tokens: [[52, 0, 128]], text: '原始公式', metrics: { evolution_recipe: { groups: [[52, 0, 128]], weights: [1] } } })])
  expect(await listShortlineFavorites()).toHaveLength(2)
  expect((await listFactorFavorites())[0].tokens).toEqual([[52, 0, 128]])
  const file = await exportLocalFavorites('all')
  expect(file.items.filter(i => i.kind === 'shortline').every(i => i.encoding === 'desktop-shortline-v1')).toBe(true)
  expect(file.items.find(i => i.kind === 'factor')?.encoding).toBe('server-v3')
})
it('imports old export files atomically with folders, task risk settings and duplicate detection; never creates or starts financial tasks', async () => {
  const file: StrategyFile = { format: 'cyclepilot-strategies', version: 1, items: [
    { kind: 'shortline', encoding: 'desktop-shortline-v1', folder: '旧短线', config: short },
    { kind: 'task', encoding: 'server-v3', config: { name: '旧任务', strategy_type: 'ai', leverage: 7, close_rules: { profit_lock: { enabled: true } } } },
  ] }
  expect((await strategyTransfer.preview(file)).items).toHaveLength(2)
  expect(await strategyTransfer.import(file, 'favorites', true, {})).toMatchObject({ imported: 2, duplicates: 0 })
  expect(await strategyTransfer.import(file, 'favorites', false, {})).toMatchObject({ imported: 0, duplicates: 2 })
  expect((await listTaskFavorites())[0]).toMatchObject({ task: null, task_id: null, snapshot: { leverage: 7, close_rules: { profit_lock: { enabled: true } } } })
  await expect(strategyTransfer.import(file, 'tasks', true, {})).rejects.toThrow('原有创建任务')
  const invalid = { ...file, items: [...file.items, { ...file.items[0], config: { ...short, api_key: 'fixture-only' } }] } as StrategyFile
  await expect(strategyTransfer.import(invalid, 'favorites', false, {})).rejects.toThrow('密钥')
  expect(await listShortlineFavorites()).toHaveLength(1)
  expect(fetchMock).not.toHaveBeenCalled()
})
it('uses the embedded desktop database and never falls back to the legacy server on a database error', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} })
  vi.mocked(invoke).mockRejectedValueOnce('database unavailable')
  await expect(listFolders('shortline')).rejects.toThrow('本地收藏读取失败')
  expect(fetchMock).not.toHaveBeenCalled()
  expect(invoke).toHaveBeenCalledWith('desktop_db', expect.objectContaining({ action: 'get', scope: 'https://legacy.fixture:owner:favorites:live' }))
})
it('reopens persisted native favorites without relying on renderer memory or adding them to remote record synchronization', async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} })
  const database = new Map<string, unknown>()
  vi.mocked(invoke).mockImplementation(async (_command, input: unknown) => {
    const args = input as { action: string; scope: string; value: unknown }
    if (args.action === 'put') database.set(args.scope, structuredClone(args.value))
    return structuredClone(database.has(args.scope) ? { value: database.get(args.scope) } : null) as never
  })
  await addShortlineFavorite(short)
  vi.resetModules()
  const reopened = await import('./local-strategy-favorites')
  // A renderer restart restores transport separately, then reads the same native document.
  const session = await import('./desktop-login-session')
  session.initializeDesktopLoginSession('reopened', localStorage); session.completeDesktopLogin('local', 'taskhost')
  expect((await reopened.exportLocalFavorites('shortline')).items[0].config).toEqual(short)
  expect([...database.keys()]).toEqual(['https://legacy.fixture:owner:favorites:live'])
  expect(fetchMock).not.toHaveBeenCalled()
})
it('never overwrites corrupt local data and refuses cross-kind folder moves', async () => {
  const folder = await createFolder('factor', '普通因子')
  const favorite = await addShortlineFavorite(short)
  await expect(moveShortlineFavorite(favorite.id, folder.id)).rejects.toThrow('分类不匹配')
  expect((await listShortlineFavorites())[0].folder_id).toBeNull()
  const key = 'local-strategy-favorites:https://legacy.fixture:owner:favorites:live'
  localStorage.setItem(key, '{damaged')
  await expect(addShortlineFavorite(short)).rejects.toThrow('无法读取')
  expect(localStorage.getItem(key)).toBe('{damaged')
})
