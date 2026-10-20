import {test} from 'node:test'
import assert from 'node:assert/strict'
import {assertDesktopStopped} from './desktop-build-guard.mjs'

test('a running trading desktop blocks packaging without terminating it',()=>{
  let calls=0
  assert.throws(()=>assertDesktopStopped({platform:'win32',run:(file,args)=>{
    calls++;assert.equal(file,'tasklist.exe');assert.deepEqual(args,['/FI','IMAGENAME eq ai-trading-desktop.exe','/FO','CSV','/NH'])
    return '"ai-trading-desktop.exe","1234","控制台","1","120,000 K"\r\n'
  }}),/正常退出/)
  assert.equal(calls,1)
})
test('localized empty results allow a build but process inspection failure blocks it',()=>{
  assert.doesNotThrow(()=>assertDesktopStopped({platform:'win32',run:()=> '信息: 没有运行的任务匹配指定标准。'}))
  assert.throws(()=>assertDesktopStopped({platform:'win32',run:()=>{throw Error('unavailable')}}),/已停止打包/)
})
test('non-Windows builds do not invoke Windows process commands',()=>{
  assert.doesNotThrow(()=>assertDesktopStopped({platform:'linux',run:()=>{throw Error('must not run')}}))
})
