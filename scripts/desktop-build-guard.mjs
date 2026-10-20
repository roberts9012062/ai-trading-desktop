import {execFileSync} from 'node:child_process'

/** A build must never force-kill a process holding a trading lease/journal. */
export function assertDesktopStopped({platform=process.platform,run=execFileSync}={}){
  if(platform!=='win32')return
  let output
  try{output=run('tasklist.exe',['/FI','IMAGENAME eq ai-trading-desktop.exe','/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true,timeout:10000})}
  catch{throw Error('无法核对客户端是否已退出，已停止打包')}
  if(String(output).split(/\r?\n/).some(line=>/^"ai-trading-desktop\.exe",/i.test(line.trim()))){
    throw Error('客户端仍在运行。请正常退出并等待账户执行器完成交接，再重新打包；打包脚本不会强制结束交易进程。')
  }
}
