import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {artifactLock,verifyArchive} from './fetch-execution-worker.mjs'
const lock=()=>({protocol:1,tag:'executor-runtime-build-1',asset:'execution-worker-build-1.zip',sha256:'a'.repeat(64),manifest_sha256:'b'.repeat(64),build_id:'build-1'})
test('only exact pinned assets in the desktop repository are accepted',()=>{
  assert.deepEqual(artifactLock(lock()),lock())
  for(const change of [{tag:'latest'},{asset:'../worker.zip'},{asset:'https://example.com/key.zip'},{sha256:'A'.repeat(64)},{manifest_sha256:'invalid'},{repository:'private/source'},{build_id:'../../source'}])assert.throws(()=>artifactLock({...lock(),...change}))
})
test('a changed downloaded archive cannot reach extraction',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'execution-download-test-'))
  const archive=path.join(directory,'worker.zip'),bytes=Buffer.from('synthetic archive')
  try{
    await fs.writeFile(archive,bytes)
    const checksum=createHash('sha256').update(bytes).digest('hex')
    await verifyArchive(archive,checksum)
    await fs.writeFile(archive,'modified')
    await assert.rejects(verifyArchive(archive,checksum),/摘要不匹配/)
  }finally{await fs.unlink(archive);await fs.rmdir(directory)}
})
test('real Windows ZIP extraction rejects traversal, links, devices and case collisions',{skip:process.platform!=='win32'},()=>{
  const script=fileURLToPath(new URL('./test-execution-extraction.ps1',import.meta.url))
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{encoding:'utf8',windowsHide:true,timeout:20000})
  assert.match(output,/7 real ZIP cases passed/)
})
