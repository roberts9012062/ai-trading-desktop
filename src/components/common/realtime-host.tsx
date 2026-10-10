import { useEffect, useRef, useState } from 'react'
import { isTauri, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { attachRealtimeRuntime, realtimeCount, stopAllRealtime } from '@/lib/realtime-factor/runtime'

export function RealtimeHost() {
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false)
  const closing=useRef(false)
  useEffect(()=>attachRealtimeRuntime(),[])
  useEffect(()=>{
    let disposed=false,unlisten:(()=>void)|undefined
    if(isTauri())void getCurrentWindow().onCloseRequested(event=>{
      if(closing.current||realtimeCount()>0){event.preventDefault();setConfirm(true)}
    }).then(stop=>{if(disposed)stop();else unlisten=stop})
    const before=(event:BeforeUnloadEvent)=>{
      if(realtimeCount()>0){event.preventDefault();event.returnValue=''}
    }
    window.addEventListener('beforeunload',before)
    return()=>{disposed=true;unlisten?.();window.removeEventListener('beforeunload',before)}
  },[])
  const exit=async()=>{
    setBusy(true)
    closing.current=true
    await stopAllRealtime('客户端退出，恢复原任务频率')
    closing.current=false;setConfirm(false);setBusy(false)
    await invoke('desktop_close_window')
  }
  return <Dialog open={confirm} onOpenChange={v=>{if(!busy)setConfirm(v)}}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>有秒级任务正在运行</DialogTitle></DialogHeader>
      <p className="text-sm leading-relaxed text-[var(--text-secondary)]">退出后，秒级任务将恢复原来的分析频率，已有持仓由服务器继续管理。最小化或收起到托盘可以保持秒级运行。</p>
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={()=>setConfirm(false)}>取消</Button><Button disabled={busy} onClick={()=>void exit()}>{busy?'正在交接…':'恢复普通模式并退出'}</Button></div>
    </DialogContent>
  </Dialog>
}
