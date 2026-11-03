import { invoke } from '@tauri-apps/api/core'
import { nativeCollection } from './collection-config'
import { normalizeHost } from './taskhost-client'

export const hostKeyStorageSupported = () => nativeCollection()
async function action(origin: string, operation: 'read' | 'save' | 'clear', key: string | null = null): Promise<string | null> {
  if (!hostKeyStorageSupported()) return null
  try {
    const value = await invoke<string | null>('desktop_saved_host_key', { origin: normalizeHost(origin), action: operation, key })
    if (operation === 'read' && value !== null && !/^thk_[A-Za-z0-9_-]{43}$/.test(value)) throw new Error()
    return value
  } catch { throw new Error('登录密钥安全存储未完成，请重新填写或检查本机数据目录；不会改为明文保存') }
}
export const readSavedHostKey = (origin: string) => action(origin, 'read')
export const saveHostKey = (origin: string, key: string) => action(origin, 'save', key)
export const clearSavedHostKey = (origin: string) => action(origin, 'clear')
