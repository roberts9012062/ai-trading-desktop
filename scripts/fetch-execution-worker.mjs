/** CI reads a pinned compiled asset from THIS repository, never private source. */
import {execFileSync} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {assembleExecutionArtifact,verifyExecutionArtifact,DESTINATION} from './execution-worker.mjs'
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const REPOSITORY='roberts9012062/ai-trading-desktop'

export function artifactLock(value){
  if(!value||Object.keys(value).sort().join(',')!=='asset,build_id,manifest_sha256,protocol,sha256,tag'||value.protocol!==1
    ||typeof value.tag!=='string'||!/^executor-runtime-[A-Za-z0-9_-]{1,128}$/.test(value.tag)
    ||typeof value.asset!=='string'||!/^[A-Za-z0-9_-]{1,180}\.zip$/.test(value.asset)
    ||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)
    ||typeof value.manifest_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.manifest_sha256)
    ||typeof value.build_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.build_id))throw Error('执行器分发锁定文件无效')
  return value
}
export async function verifyArchive(file,checksum){
  const info=await fs.lstat(file)
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024**3)throw Error('执行器压缩包类型或大小无效')
  const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk)
  if(digest.digest('hex')!==checksum)throw Error('执行器压缩包摘要不匹配')
}
export async function verifyPinnedExecutionArtifact(lock,directory=DESTINATION){
  artifactLock(lock)
  await verifyArchive(path.join(directory,'manifest.json'),lock.manifest_sha256)
  const manifest=await verifyExecutionArtifact(directory)
  if(manifest.build_id!==lock.build_id)throw Error('执行器构建编号与分发锁定文件不一致')
  return manifest
}
async function readArtifactLock(root){
  const lockPath=path.join(root,'execution-worker.lock.json')
  let info
  try{info=await fs.lstat(lockPath)}catch(error){if(error.code==='ENOENT')throw Error('缺少执行器分发锁定文件，已停止发布');throw error}
  if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw Error('执行器分发锁定文件类型或大小无效')
  return artifactLock(JSON.parse(await fs.readFile(lockPath,'utf8')))
}
export async function verifyReleaseExecutionArtifact(root=ROOT){
  const lock=await readArtifactLock(root)
  const conf=JSON.parse(await fs.readFile(path.join(root,'src-tauri','tauri.conf.json'),'utf8'))
  if(conf.bundle?.resources?.['../resources/execution-worker']!=='execution-worker')throw Error('独立执行器尚未配置为安装包资源，已停止发布')
  return verifyPinnedExecutionArtifact(lock,path.join(root,'resources','execution-worker'))
}
export async function fetchExecutionArtifact(){
  if(process.platform!=='win32')throw Error('执行器分发目标为 Windows x64')
  if(process.env.GITHUB_REPOSITORY&&process.env.GITHUB_REPOSITORY!==REPOSITORY)throw Error('执行器只能从当前桌面仓库获取')
  const lock=await readArtifactLock(ROOT)
  const directory=path.join(ROOT,'.local-data',`execution-fetch-${randomUUID()}`)
  await fs.mkdir(directory,{recursive:true})
  execFileSync('gh',['release','download',lock.tag,'--repo',REPOSITORY,'--pattern',lock.asset,'--dir',directory],{cwd:ROOT,stdio:'inherit',windowsHide:true})
  const archive=path.join(directory,lock.asset);await verifyArchive(archive,lock.sha256)
  const extracted=path.join(directory,'compiled')
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'scripts','extract-execution-worker.ps1'),'-Archive',archive,'-Destination',extracted],{cwd:ROOT,stdio:'inherit',windowsHide:true})
  const manifest=await verifyPinnedExecutionArtifact(lock,extracted)
  await assembleExecutionArtifact(extracted)
  await verifyPinnedExecutionArtifact(lock)
  return {build_id:manifest.build_id,files:manifest.files.length,verified:true}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await fetchExecutionArtifact()))}catch(error){console.error(error.message);process.exitCode=1}
}
