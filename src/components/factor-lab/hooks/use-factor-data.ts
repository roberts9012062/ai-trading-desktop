"use client"

/** 因子实验室只读数据：模型/历史/收藏的加载与刷新 */

import { useCallback, useEffect, useState } from "react"
import type { AIModel } from "@/types"
import { getAIModels, getContractsApi } from "@/lib/api"
import { chatModelsOnly } from "@/lib/decision-model"
import {
  listFactorFavorites,
  listFactorHistory,
  type FactorFavoriteItem,
  type FactorHistoryItem,
} from "@/lib/factor-lab-api"

export interface FactorLabData {
  models: AIModel[]
  modelsLoading: boolean
  history: FactorHistoryItem[]
  histLoading: boolean
  favorites: FactorFavoriteItem[]
  favLoading: boolean
  /** 合约代码 → 中文名 */
  contractNameOf: (symbol: string) => string
  refreshHistory: (sym: string) => Promise<void>
  refreshFavorites: (sym: string) => Promise<void>
}

/** 模型/历史/收藏 加载 */
export function useFactorLabData(symbol: string): FactorLabData {
  const [models, setModels] = useState<AIModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [history, setHistory] = useState<FactorHistoryItem[]>([])
  const [histLoading, setHistLoading] = useState(false)
  const [favorites, setFavorites] = useState<FactorFavoriteItem[]>([])
  const [favLoading, setFavLoading] = useState(false)
  const [contractNames, setContractNames] = useState<Record<string, string>>(
    {},
  )

  const contractNameOf = useCallback(
    (sym: string): string =>
      contractNames[(sym || "").trim().toLowerCase()] || sym || "",
    [contractNames],
  )

  const refreshHistory = useCallback(async (sym: string) => {
    if (!sym.trim()) {
      setHistory([])
      return
    }
    setHistLoading(true)
    try {
      setHistory(await listFactorHistory(sym.trim().toLowerCase()))
    } catch {
      setHistory([])
    } finally {
      setHistLoading(false)
    }
  }, [])

  const refreshFavorites = useCallback(async (sym: string) => {
    setFavLoading(true)
    try {
      setFavorites(await listFactorFavorites(sym.trim() || undefined))
    } catch {
      setFavorites([])
    } finally {
      setFavLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshHistory(symbol)
    void refreshFavorites(symbol)
  }, [symbol, refreshHistory, refreshFavorites])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setModelsLoading(true)
      try {
        const list = chatModelsOnly(await getAIModels())
        if (!cancelled) setModels(list)
      } catch {
        if (!cancelled) setModels([])
      } finally {
        if (!cancelled) setModelsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 加载合约中文名（收藏默认名用）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await getContractsApi()
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const c of list) {
          map[c.symbol.trim().toLowerCase()] = c.name || c.symbol
        }
        setContractNames(map)
      } catch {
        // 中文名加载失败不影响主流程
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return {
    models,
    modelsLoading,
    history,
    histLoading,
    favorites,
    favLoading,
    contractNameOf,
    refreshHistory,
    refreshFavorites,
  }
}
