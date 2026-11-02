/** Public compiled Go artifact only; never private repository/source credentials. */
import {createHash,randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PREFIX='https://github.com/roberts9012062/ai-trading-desktop/releases/download/taskhost-go-runtime-';
const hash=/^[a-f0-9]{64}$/;
const names={'windows-x86_64':'taskhost-go-worker.exe','linux-x86_64':'taskhost-go-worker'};
export function artifactPin(lock,platform='windows-x86_64'){
  const p=lock?.platforms?.[platform];
  if(!lock||Object.keys(lock).sort().join(',')!=='platforms,protocol'||lock.protocol!=='taskhost-go-worker-v1'||!p
    ||Object.keys(p).sort().join(',')!=='sha256,size,url'||!hash.test(p.sha256)||!Number.isSafeInteger(p.size)||p.size<=0||p.size>100*1024**2
    ||typeof p.url!=='string'||!p.url.startsWith(PREFIX)||!/^https:\/\/github\.com\/roberts9012062\/ai-trading-desktop\/releases\/download\/taskhost-go-runtime-[0-9]+\.[0-9]+\.[0-9]+\/taskhost-worker-[0-9]+\.[0-9]+\.[0-9]+-(windows-amd64\.exe|linux-amd64)$/.test(p.url)
    ||!names[platform]||!p.url.endsWith(platform==='windows-x86_64'?'windows-amd64.exe':'linux-amd64'))throw Error('Go 执行器尚未固定到已验证公开二进制，已停止打包');
  return p;
}
export async function verifyGoArtifact(directory,pin,platform='windows-x86_64'){
  const file=path.join(directory,names[platform]);const info=await fs.lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size!==pin.size)throw Error('Go 执行器文件大小或类型不匹配');
  const raw=await fs.readFile(file);if(createHash('sha256').update(raw).digest('hex')!==pin.sha256)throw Error('Go 执行器 SHA-256 不匹配');return file;
}
export async function verifyReleaseGoArtifact(root=ROOT,platform='windows-x86_64'){
  const lock=JSON.parse(await fs.readFile(path.join(root,'taskhost-go-worker.lock.json'),'utf8'));
  const pin=artifactPin(lock,platform);
  const file=await verifyGoArtifact(path.join(root,'resources','taskhost-go-worker'),pin,platform);
  return {protocol:lock.protocol,platform,sha256:pin.sha256,size:pin.size,file};
}
export async function fetchGoArtifact({root=ROOT,platform='windows-x86_64',fetcher=fetch}={}){
  const lock=JSON.parse(await fs.readFile(path.join(root,'taskhost-go-worker.lock.json'),'utf8'));const pin=artifactPin(lock,platform);
  let url=new URL(pin.url),reply;
  for(let hop=0;hop<4;hop++){
    reply=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(60000),headers:{'User-Agent':'CyclePilot-pinned-Go-artifact'}});
    if([301,302,303,307,308].includes(reply.status)){
      const next=new URL(reply.headers.get('location')||'',url);
      if(next.protocol!=='https:'||next.username||next.password||!['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))throw Error('Go 执行器下载重定向不受信任');
      await reply.body?.cancel();url=next;reply=null;continue;
    }break;
  }
  if(!reply?.ok||!reply.body)throw Error('Go 执行器公开二进制下载失败');
  const chunks=[];let total=0;
  for await(const part of reply.body){total+=part.byteLength;if(total>pin.size){await reply.body.cancel().catch(()=>{});throw Error('Go 执行器下载大小不匹配');}chunks.push(part);}
  const bytes=Buffer.concat(chunks);
  if(total!==pin.size||createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw Error('Go 执行器公开二进制摘要不匹配');
  const directory=path.join(root,'resources','taskhost-go-worker');await fs.mkdir(directory,{recursive:true});
  const target=path.join(directory,names[platform]),temp=path.join(directory,`.verified-${randomUUID()}`);
  await fs.writeFile(temp,bytes,{flag:'wx',mode:0o700});await fs.rename(temp,target);await verifyGoArtifact(directory,pin,platform);
  return {protocol:lock.protocol,platform,verified:true,sha256:pin.sha256};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await fetchGoArtifact()));}catch{console.error('已停止 Go 执行器打包：固定版本或公开二进制校验未通过');process.exitCode=1;}
}
