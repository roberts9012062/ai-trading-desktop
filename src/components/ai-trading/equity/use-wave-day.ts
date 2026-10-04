import { useEffect, useState } from "react"
import { waveDayRange, type WaveDay } from "./equity-wave-day"

/** Only midnight/visibility changes the axis; ordinary quote refreshes never move it. */
export function useWaveDay(): WaveDay | null {
  const [day, setDay] = useState<WaveDay | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const sync = () => {
      const now = Date.now(), next = waveDayRange(now)
      setDay(previous => previous?.from === next.from ? previous : next)
      clearTimeout(timer)
      timer = setTimeout(sync, Math.max(1, next.to - now))
    }
    sync()
    document.addEventListener("visibilitychange", sync)
    window.addEventListener("focus", sync)
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", sync); window.removeEventListener("focus", sync) }
  }, [])
  return day
}
