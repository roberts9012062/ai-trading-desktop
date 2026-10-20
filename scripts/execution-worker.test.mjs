import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {verifyExecutionArtifact} from './execution-worker.mjs'
import {verifyPinnedExecutionArtifact} from './fetch-execution-worker.mjs'

async function fixture(run){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'execution-artifact-test-'))
  const binary=Buffer.from('synthetic native test binary')
  const row={path:'execution-worker.exe',size:binary.length,sha256:createHash('sha256').update(binary).digest('hex')}
  const manifest={protocol:1,entry:'execution-worker.exe',build_id:'test',files:[row]}
  await fs.writeFile(path.join(root,'execution-worker.exe'),binary)
  const save=()=>fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest))
  await save()
  try{await run(root,manifest,save)}finally{
    for(const name of await fs.readdir(root))await fs.unlink(path.join(root,name))
    await fs.rmdir(root)
  }
}
test('complete compiler manifest verifies and altered or extra files block assembly',async()=>fixture(async root=>{
  assert.equal((await verifyExecutionArtifact(root)).build_id,'test')
  await fs.writeFile(path.join(root,'extra.dll'),'unlisted');await assert.rejects(verifyExecutionArtifact(root));await fs.unlink(path.join(root,'extra.dll'))
  await fs.writeFile(path.join(root,'execution-worker.exe'),'changed');await assert.rejects(verifyExecutionArtifact(root))
}))
test('private bytecode and escaping paths are rejected even with a declared checksum',async()=>fixture(async(root,manifest,save)=>{
  for(const file of ['../outside.dll','C:/key.dll','folder\\key.dll','app.py','APP.PYC','.env','nested/.env.local']){
    manifest.files[0].path=file;await save();await assert.rejects(verifyExecutionArtifact(root))
  }
}))
test('a package flag or empty manifest cannot claim that a runtime is installed',async()=>fixture(async(root,manifest,save)=>{
  manifest.files=[];await save();await assert.rejects(verifyExecutionArtifact(root))
}))
test('a self-consistent replacement manifest still fails the committed distribution pin',async()=>fixture(async(root,manifest,save)=>{
  const original=await fs.readFile(path.join(root,'manifest.json'))
  const lock={protocol:1,tag:'executor-runtime-test',asset:'execution-worker-test.zip',build_id:'test',sha256:'a'.repeat(64),manifest_sha256:createHash('sha256').update(original).digest('hex')}
  await verifyPinnedExecutionArtifact(lock,root)
  manifest.files[0].size=7;manifest.files[0].sha256=createHash('sha256').update('changed').digest('hex');await fs.writeFile(path.join(root,'execution-worker.exe'),'changed');await save()
  await verifyExecutionArtifact(root)
  await assert.rejects(verifyPinnedExecutionArtifact(lock,root),/摘要不匹配/)
}))
