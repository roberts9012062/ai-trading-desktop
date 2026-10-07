import { create } from "zustand"
import { hunterApi, type Hunter, type HunterConfig } from "@/lib/hunter/api"
import type { Cycle, Direction } from "@/lib/hunter/rules"
import type { ProfitLockConfig } from "@/lib/ai-trading-api"

export interface HunterWatch { symbol: string; cycle: Cycle; direction: Direction; stage: string; expires: number }

interface HunterState {
  groups: Hunter[]; error: string | null; progress: Record<string, string>; loaded: boolean;
  watches: Record<string, HunterWatch[]>;
  refresh: (signal?: AbortSignal) => Promise<void>;
  create: (cfg: HunterConfig) => Promise<void>;
  setHosting: (id: string, location: "desktop" | "server") => Promise<void>;
  setProfitLock: (id: string, config: ProfitLockConfig) => Promise<void>;
  control: (id: string, action: "pause" | "resume" | "stop" | "stop_close" | "upgrade" | "upgrade_adaptive" | "upgrade_swing" | "set_pool", poolSize?: number) => Promise<void>;
  setProgress: (id: string, message: string) => void;
  setWatch: (id: string, cycle: Cycle, entries: HunterWatch[]) => void;
  reset: () => void;
}
let generation = 0
export const useHunterStore = create<HunterState>((set) => ({
  setHosting: async (id, location) => {
    const started = generation
    const group = await hunterApi.hosting(id, location)
    if (started !== generation) throw new Error("会话已切换，请查看当前账户猎手")
    set(s => ({ groups: s.groups.map(g => g.id === id ? group : g), watches: { ...s.watches, [id]: [] },
      progress: { ...s.progress, [id]: location === "server" ? "已挂载服务器，关闭客户端后继续搜索和交易" : "已解除服务器托管，等待桌面扫描" } }))
  },
  setProfitLock: async (id, config) => {
    const started = generation
    const updated = await hunterApi.setProfitLock(id, config)
    if (started !== generation) throw new Error("会话已切换，请重新查看当前账户猎手")
    set(s => ({ groups: s.groups.map(group => group.id === id ? { ...group, config: { ...group.config, profit_lock: updated.profit_lock } } : group) }))
    void import("@/stores/ai-trading").then(m => m.useAITradingStore.getState().loadTasks({ silent: true })).catch(() => {})
  },
  groups: [], error: null, progress: {}, loaded: false, watches: {},
  refresh: async (signal) => {
    const started = generation
    try {
      const groups = await hunterApi.list(signal)
      if (!signal?.aborted && started === generation) set(s => ({ groups, error: null, loaded: true,
        watches: Object.fromEntries(Object.entries(s.watches).filter(([id]) => groups.some(g => g.id === id && g.status === "running"))) }))
    } catch (e) {
      if (!signal?.aborted && started === generation) set({ error: e instanceof Error ? e.message : "猎手加载失败", loaded: true })
      throw e
    }
  },
  create: async (cfg) => {
    const started = generation
    const group = await hunterApi.create(cfg)
    if (started !== generation) throw new Error("会话已切换，请在当前账户重新查看猎手")
    set(s => ({ groups: [group, ...s.groups], error: null }))
  },
  control: async (id, action, poolSize) => {
    const started = generation
    const group = await hunterApi.control(id, action, poolSize)
    if (started !== generation) throw new Error("会话已切换，请在当前账户重新查看猎手")
    set(s => ({ groups: s.groups.map(g => g.id === id ? group : g), error: null,
      watches: { ...s.watches, [id]: group.status === "running" ? s.watches[id] ?? [] : [] } }))
    if (action === "stop" || action === "stop_close") {
      void import("@/stores/ai-market").then(m => {
        if (started === generation) return m.useAiMarketStore.getState().loadTasks(true)
      }).catch(() => {})
    }
  },
  setProgress: (id, message) => set(s => ({ progress: { ...s.progress, [id]: message } })),
  setWatch: (id, cycle, entries) => set(s => ({ watches: { ...s.watches, [id]: [...(s.watches[id] ?? []).filter(x => x.cycle !== cycle), ...entries].slice(-150) } })),
  reset: () => { generation++; set({ groups: [], error: null, progress: {}, loaded: false, watches: {} }) },
}))
