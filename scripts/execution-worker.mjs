/** Assemble only compiled private artifacts. No private repository access is required. */
import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
export const DESTINATION=path.join(ROOT,'resources','execution-worker')

function relativeFile(raw){
  if(typeof raw!=='string'||!raw||raw.length>512||/[\\:\x00-\x1f\x7f]/.test(raw)||raw.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p))||/\.py(?:c|o|w)?$/i.test(raw)||raw.split('/').some(p=>/^\.env(?:\.|$)/i.test(p)))throw Error('执行器目录包含不安全文件')
  return raw
}
async function regular(file,directory=false){
  const info=await fs.lstat(file)
  if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile()))throw Error('执行器文件类型无效')
  return info
}
async function enumerate(root,directory,files){
  await regular(directory,true)
  for(const name of await fs.readdir(directory)){
    const file=path.join(directory,name),info=await fs.lstat(file)
    if(info.isSymbolicLink())throw Error('执行器不能包含链接')
    if(info.isDirectory())await enumerate(root,file,files)
    else {await regular(file);files.add(relativeFile(path.relative(root,file).split(path.sep).join('/')))}
    if(files.size>10000)throw Error('执行器分发文件过多')
  }
}
export async function verifyExecutionArtifact(directory){
  directory=path.resolve(directory);await regular(directory,true)
  const manifestPath=path.join(directory,'manifest.json')
  if((await regular(manifestPath)).size>2*1024*1024)throw Error('执行器清单过大')
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'))
  if(Object.keys(manifest).sort().join(',')!=='build_id,entry,files,protocol'||manifest.protocol!==1||manifest.entry!=='execution-worker.exe'||typeof manifest.build_id!=='string'||!manifest.build_id||manifest.build_id.length>128||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>9999)throw Error('执行器清单版本不兼容')
  const expected=new Set(['manifest.json'])
  for(const item of manifest.files){
    const relative=relativeFile(item.path)
    if(Object.keys(item).sort().join(',')!=='path,sha256,size'||expected.has(relative)||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.size)||item.size<0)throw Error('执行器清单条目无效')
    expected.add(relative)
    const file=path.join(directory,relative)
    if((await regular(file)).size!==item.size)throw Error('执行器文件长度不匹配')
    const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk)
    if(hash.digest('hex')!==item.sha256)throw Error('执行器文件摘要不匹配')
  }
  const actual=new Set();await enumerate(directory,directory,actual)
  if(!expected.has('execution-worker.exe')||actual.size!==expected.size||[...actual].some(name=>!expected.has(name)))throw Error('执行器包含清单以外文件')
  return manifest
}

export async function assembleExecutionArtifact(source,destination=DESTINATION){
  source=path.resolve(source);destination=path.resolve(destination)
  if(source===destination)return verifyExecutionArtifact(destination)
  const manifest=await verifyExecutionArtifact(source)
  const parent=path.dirname(destination)
  await fs.mkdir(parent,{recursive:true})
  const staging=path.join(parent,`.execution-worker-staging-${randomUUID()}`)
  await fs.mkdir(staging)
  for(const name of [...manifest.files.map(row=>row.path),'manifest.json']){
    const target=path.join(staging,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(source,name),target)
  }
  await verifyExecutionArtifact(staging)
  let backup
  try{await fs.lstat(destination);backup=path.join(parent,`.execution-worker-previous-${randomUUID()}`);await fs.rename(destination,backup)}catch(error){if(error.code!=='ENOENT')throw error}
  try{await fs.rename(staging,destination)}catch(error){if(backup)await fs.rename(backup,destination);throw error}
  // Prior artifacts are retained for rollback under ignored resources. There is
  // no recursive delete, and source/compiler directories are never mutated.
  return manifest
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [action,source]=process.argv.slice(2)
    const manifest=action==='--check'?await verifyExecutionArtifact(DESTINATION):action==='--assemble'&&source?await assembleExecutionArtifact(source):null
    if(!manifest)throw Error('Usage: node scripts/execution-worker.mjs --check | --assemble COMPILED_DIRECTORY')
    console.log(JSON.stringify({build_id:manifest.build_id,files:manifest.files.length,verified:true}))
  }catch(error){console.error(error.message);process.exitCode=1}
}
