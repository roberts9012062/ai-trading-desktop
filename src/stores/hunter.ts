import { create } from "zustand"
import { hunterApi, type Hunter, type HunterConfig } from "@/lib/hunter/api"

interface HunterState {
  groups: Hunter[]; error: string | null; progress: Record<string, string>; loaded: boolean;
  refresh: (signal?: AbortSignal) => Promise<void>;
  create: (cfg: HunterConfig) => Promise<void>;
  control: (id: string, action: "pause" | "resume" | "stop" | "stop_close") => Promise<void>;
  setProgress: (id: string, message: string) => void;
  reset: () => void;
}
let generation = 0
export const useHunterStore = create<HunterState>((set) => ({
  groups: [], error: null, progress: {}, loaded: false,
  refresh: async (signal) => {
    const started = generation
    try {
      const groups = await hunterApi.list(signal)
      if (!signal?.aborted && started === generation) set({ groups, error: null, loaded: true })
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
    set(s => ({ groups: s.groups.map(g => g.id === id ? group : g), error: null }))
  },
  setProgress: (id, message) => set(s => ({ progress: { ...s.progress, [id]: message } })),
  reset: () => { generation++; set({ groups: [], error: null, progress: {}, loaded: false }) },
}))
