import { create } from "zustand"
import { hunterApi, type Hunter, type HunterConfig } from "@/lib/hunter/api"
import type { Cycle, Direction } from "@/lib/hunter/rules"

export interface HunterWatch { symbol: string; cycle: Cycle; direction: Direction; stage: string; expires: number }

interface HunterState {
  groups: Hunter[]; error: string | null; progress: Record<string, string>; loaded: boolean;
  watches: Record<string, HunterWatch[]>;
  refresh: (signal?: AbortSignal) => Promise<void>;
  create: (cfg: HunterConfig) => Promise<void>;
  control: (id: string, action: "pause" | "resume" | "stop" | "stop_close" | "upgrade") => Promise<void>;
  setProgress: (id: string, message: string) => void;
  setWatch: (id: string, cycle: Cycle, entries: HunterWatch[]) => void;
  reset: () => void;
}
let generation = 0
export const useHunterStore = create<HunterState>((set) => ({
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
  control: async (id, action) => {
    const started = generation
    const group = await hunterApi.control(id, action)
    if (started !== generation) throw new Error("会话已切换，请在当前账户重新查看猎手")
    set(s => ({ groups: s.groups.map(g => g.id === id ? group : g), error: null,
      watches: { ...s.watches, [id]: group.status === "running" ? s.watches[id] ?? [] : [] } }))
  },
  setProgress: (id, message) => set(s => ({ progress: { ...s.progress, [id]: message } })),
  setWatch: (id, cycle, entries) => set(s => ({ watches: { ...s.watches, [id]: [...(s.watches[id] ?? []).filter(x => x.cycle !== cycle), ...entries].slice(-150) } })),
  reset: () => { generation++; set({ groups: [], error: null, progress: {}, loaded: false, watches: {} }) },
}))
