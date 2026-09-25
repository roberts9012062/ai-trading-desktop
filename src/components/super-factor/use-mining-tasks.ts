"use client"

import { onKernelStage } from "@/lib/py-worker"

/**
 * 超级因子挖掘 —— 任务列表 + 进度更新 hook(M2 起面向 MiningRunner 编程)
 *
 * 数据流:
 * - 挂载/操作后:runner.list() 全量合并(多来源按 updated_at 倒序);
 * - 平时:runner.subscribe() 事件流增量 upsert(远端=内部轮询转事件,
 *   本地=按代推事件);
 * - 每 30s 一次全量对账,补齐事件流覆盖不到的删除/状态回退。
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { createRunner, type MiningRunner } from "@/lib/mining/runner"
import type {
  DeviceKind,
  MiningConfig,
  MiningTask,
  RunnerKind,
} from "@/lib/mining/types"
import type { Champion } from "@/lib/factor-lab-api"

// 仅本地 runner(服务端引擎已下线;createRunner 返回单例,模块级数组保证引用稳定,
// 避免 useEffect 反复重订阅);列表按 updated_at 倒序合并展示
const DEFAULT_RUNNERS: MiningRunner[] = [createRunner("local")]

function sortKey(t: MiningTask): string {
  return t.updated_at ?? t.created_at ?? ""
}

/** 多来源任务列表按 updated_at 倒序合并 */
function mergeLists(lists: MiningTask[][]): MiningTask[] {
  return lists
    .flat()
    .sort((a, b) => {
      const ka = sortKey(a)
      const kb = sortKey(b)
      return ka > kb ? -1 : ka < kb ? 1 : 0
    })
}

/** 单任务增量 upsert(保持排序) */
function upsertTask(prev: MiningTask[], t: MiningTask): MiningTask[] {
  const i = prev.findIndex((x) => x.id === t.id)
  return mergeLists([i >= 0 ? prev.map((x, j) => (j === i ? t : x)) : [...prev, t]])
}

export function useMiningTasks(runners: MiningRunner[] = DEFAULT_RUNNERS) {
  const [tasks, setTasks] = useState<MiningTask[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 创建/启动阶段文案(拉K线→内核准备;任务真正跑起来后清空) */
  const [startingPhase, setStartingPhase] = useState<string | null>(null)
  const tasksRef = useRef<MiningTask[]>([])
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  // worker 内核加载阶段(初始化/numpy/写入内核文件)实时透传到启动显示
  useEffect(() => onKernelStage(setStartingPhase), [])

  const refresh = useCallback(async () => {
    let firstErr: string | null = null
    const lists = await Promise.all(
      runners.map(async (r) => {
        try {
          return await r.list()
        } catch (e) {
          firstErr ??= e instanceof Error ? e.message : "加载任务失败"
          return [] as MiningTask[]
        }
      }),
    )
    setTasks(mergeLists(lists))
    setError(firstErr)
  }, [runners])

  // 初次加载
  useEffect(() => {
    void refresh()
  }, [refresh])

  // 事件流:增量 upsert
  useEffect(() => {
    const unsubs = runners.map((r) =>
      r.subscribe((t) => {
        setTasks((prev) => upsertTask(prev, t))
      }),
    )
    return () => {
      unsubs.forEach((u) => u())
    }
  }, [runners])

  // 低频全量对账(删除/状态回退兜底);递归 setTimeout,慢请求不堆叠
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      timer = setTimeout(async () => {
        await refresh()
        if (!stopped) schedule()
      }, 30_000)
    }
    schedule()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  /** 按 origin 路由到归属 runner */
  const runnerFor = useCallback(
    (origin: RunnerKind): MiningRunner =>
      runners.find((r) => r.kind === origin) ?? runners[0],
    [runners],
  )
  const runnerForId = useCallback(
    (id: string): MiningRunner => {
      const t = tasksRef.current.find((x) => x.id === id)
      return runnerFor(t?.origin ?? runners[0].kind)
    },
    [runners, runnerFor],
  )

  const createTask = useCallback(
    async (
      config: MiningConfig,
      opts: { device: DeviceKind; name?: string },
      origin: RunnerKind = runners[0].kind,
    ): Promise<void> => {
      setLoading(true)
      setError(null)
      setStartingPhase("提交创建请求…")
      try {
        await runnerFor(origin).create(config, {
          ...opts,
          onProgress: setStartingPhase,
        })
        setStartingPhase("等待本地引擎启动…")
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "创建任务失败")
        throw e
      } finally {
        setLoading(false)
        // 阶段文案延迟清空:给"内核加载"广播留出时间,任务 running 后自然接管
        setTimeout(() => setStartingPhase(null), 60_000)
      }
    },
    [runners, refresh, runnerFor],
  )

  const pauseTask = useCallback(
    async (id: string) => {
      try {
        await runnerForId(id).pause(id)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "暂停失败")
      }
    },
    [refresh, runnerForId],
  )

  const resumeTask = useCallback(
    async (id: string) => {
      try {
        await runnerForId(id).resume(id)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "恢复失败")
      }
    },
    [refresh, runnerForId],
  )

  const cancelTask = useCallback(
    async (id: string) => {
      try {
        await runnerForId(id).cancel(id)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "取消失败")
      }
    },
    [refresh, runnerForId],
  )

  const removeTask = useCallback(
    async (id: string) => {
      try {
        await runnerForId(id).remove(id)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : "删除失败")
      }
    },
    [refresh, runnerForId],
  )

  return {
    tasks,
    loading,
    error,
    startingPhase,
    refresh,
    createTask,
    pauseTask,
    resumeTask,
    cancelTask,
    removeTask,
  }
}

/** 加载完成任务的冠军因子(按需;按 origin 路由到归属 runner) */
export function useTaskChampions(
  task: MiningTask | null,
  runners: MiningRunner[] = DEFAULT_RUNNERS,
) {
  const [champions, setChampions] = useState<Champion[]>([])
  const [loading, setLoading] = useState(false)

  const taskId = task?.status === "completed" ? task.id : null
  const origin = task?.status === "completed" ? task.origin : null

  useEffect(() => {
    if (!taskId || !origin) {
      setChampions([])
      return
    }
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const runner = runners.find((r) => r.kind === origin)
        const list = runner ? await runner.champions(taskId) : []
        if (!cancelled) setChampions(list)
      } catch {
        if (!cancelled) setChampions([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskId, origin, runners])

  return { champions, loading }
}
