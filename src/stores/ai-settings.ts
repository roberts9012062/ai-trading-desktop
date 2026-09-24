/**
 * AI 设置状态管理 —— 渠道、模型、加载状态
 */

import { create } from "zustand"
import type { AIProvider, AIModel, PresetProvider, ProviderTestResult } from "@/types"
import {
  getAIProviders,
  getAIModels,
  getPresetProviders,
  createAIProvider,
  updateAIProvider,
  deleteAIProvider,
  testAIProvider,
  batchCreateAIModels,
  updateAIModel,
  deleteAIModel,
} from "@/lib/api"

interface AISettingsState {
  /** 渠道列表 */
  providers: AIProvider[]
  /** 模型列表 */
  models: AIModel[]
  /** 预设渠道 */
  presets: PresetProvider[]
  /** 加载状态 */
  loadingProviders: boolean
  loadingModels: boolean
  /** 测试结果映射：providerId → result */
  testResults: Record<string, ProviderTestResult>

  /** 加载渠道列表 */
  fetchProviders: () => Promise<void>
  /** 加载模型列表 */
  fetchModels: () => Promise<void>
  /** 加载预设渠道 */
  fetchPresets: () => Promise<void>
  /** 添加渠道 */
  addProvider: (data: { name: string; api_type: string; base_url: string; api_key: string; thinking_enabled?: boolean | null }) => Promise<void>
  /** 更新渠道 */
  editProvider: (
    id: string,
    data: {
      name?: string
      api_type?: string
      base_url?: string
      api_key?: string
      is_active?: boolean
      thinking_enabled?: boolean | null
    },
  ) => Promise<void>
  /** 删除渠道 */
  removeProvider: (id: string) => Promise<void>
  /** 测试渠道 */
  testProvider: (id: string) => Promise<ProviderTestResult>
  /** 从渠道批量添加模型 */
  addModels: (providerId: string, models: Array<{ model_id: string; display_name: string; is_multimodal: boolean; is_custom: boolean; capabilities: string[] }>) => Promise<void>
  /** 更新模型 */
  editModel: (id: string, data: { display_name: string }) => Promise<void>
  /** 删除模型 */
  removeModel: (id: string) => Promise<void>
}

export const useAISettingsStore = create<AISettingsState>((set, get) => ({
  providers: [],
  models: [],
  presets: [],
  loadingProviders: false,
  loadingModels: false,
  testResults: {},

  fetchProviders: async () => {
    set({ loadingProviders: true })
    try {
      const providers = await getAIProviders()
      set({ providers })
    } finally {
      set({ loadingProviders: false })
    }
  },

  fetchModels: async () => {
    set({ loadingModels: true })
    try {
      const models = await getAIModels()
      set({ models })
    } finally {
      set({ loadingModels: false })
    }
  },

  fetchPresets: async () => {
    const presets = await getPresetProviders()
    set({ presets })
  },

  addProvider: async (data) => {
    await createAIProvider(data)
    await get().fetchProviders()
  },

  editProvider: async (id, data) => {
    await updateAIProvider(id, data)
    await get().fetchProviders()
  },

  removeProvider: async (id) => {
    await deleteAIProvider(id)
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      models: s.models.filter((m) => m.provider_id !== id),
    }))
  },

  testProvider: async (id) => {
    try {
      const result = await testAIProvider(id)
      set((s) => ({ testResults: { ...s.testResults, [id]: result } }))
      return result
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "测试失败，请稍后重试"
      const result: ProviderTestResult = {
        status: "error",
        message,
        models: [],
      }
      set((s) => ({ testResults: { ...s.testResults, [id]: result } }))
      return result
    }
  },

  addModels: async (providerId, models) => {
    await batchCreateAIModels(providerId, models)
    await get().fetchModels()
    await get().fetchProviders()
  },

  editModel: async (id, data) => {
    await updateAIModel(id, data)
    set((s) => ({
      models: s.models.map((m) =>
        m.id === id ? { ...m, display_name: data.display_name } : m
      ),
    }))
  },

  removeModel: async (id) => {
    await deleteAIModel(id)
    set((s) => ({
      models: s.models.filter((m) => m.id !== id),
    }))
  },
}))
