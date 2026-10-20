//! Native account lifecycle. Preparation is server-only; restoration uses the center.
use crate::{execution_preparation as preparation,execution_worker::{self,Worker},local_store::LocalStoreState,market_data::{self,MarketDataState}};
use base64::{engine::general_purpose::STANDARD,Engine};
use ring::{agreement,digest,rand};
use serde_json::{json,Value};
use std::{path::PathBuf,sync::{Mutex,atomic::{AtomicBool,AtomicU64,Ordering}},time::Duration};
use tauri::Manager;
use zeroize::Zeroizing;
type Result<T>=std::result::Result<T,String>;

#[derive(Clone,PartialEq)]
struct Context {scope:String,binding:String,key_hash:String}
#[derive(Default)]
struct Managed {worker:Option<Worker>,scope:Option<String>,generation:u64}
impl Managed {fn matches(&self,scope:Option<&str>,generation:u64)->bool{self.scope.as_deref()==scope && self.generation==generation}}
#[derive(Default)]
pub struct ExecutionRuntime {
    context:Mutex<Option<Context>>,
    generation:AtomicU64,
    operation:tokio::sync::Mutex<Managed>,
    interrupt:Mutex<Option<tokio::sync::mpsc::Sender<()>>>,
    closing:AtomicBool,
    pub exit_ready:AtomicBool,
    pub exit_draining:AtomicBool,
}
fn hash(bytes:&[u8])->String{digest::digest(&digest::SHA256,bytes).as_ref().iter().map(|b|format!("{b:02x}")).collect()}
fn entropy(scope:&str)->String{format!("execution-preparation-v1:{scope}")}
fn database_path(app:&tauri::AppHandle,scope:&str,account:&str)->Result<PathBuf>{
    Ok(app.path().app_local_data_dir().map_err(|_|"本机执行器目录不可用")?.join("execution").join(hash(format!("{scope}:{account}").as_bytes())).join("runtime.db"))
}
fn location_entropy(scope:&str)->String{format!("execution-location-v1:{scope}")}
fn runtime_directory(app:&tauri::AppHandle)->Result<PathBuf>{
    let directory=app.path().resource_dir().map_err(|_|"客户端资源目录不可用")?.join("execution-worker");
    if directory.exists(){return Ok(directory);}
    #[cfg(debug_assertions)] {let directory=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/execution-worker");if directory.exists(){return Ok(directory);}}
    Err("本版本尚未安装独立交易执行器".into())
}
impl ExecutionRuntime {
    fn replace_context(&self,next:Option<Context>)->Result<(bool,u64)>{
        let mut current=self.context.lock().map_err(|_|"执行器状态不可用")?;
        let changed=*current!=next;
        if changed {*current=next;self.generation.fetch_add(1,Ordering::SeqCst);self.interrupt();}
        // Capture under the same lock: an older context call must never borrow
        // a newer call's generation and then drain its newly started worker.
        Ok((changed,self.generation.load(Ordering::SeqCst)))
    }
    pub(crate) fn action_generation(&self,scope:&str)->Result<u64>{
        let generation=self.generation.load(Ordering::SeqCst);
        self.check(scope,generation)?;Ok(generation)
    }
    pub(crate) fn check_action(&self,scope:&str,generation:u64)->Result<()> {
        self.check(scope,generation)
    }
    fn interrupt(&self){if let Ok(slot)=self.interrupt.lock(){if let Some(stop)=slot.as_ref(){let _=stop.try_send(());}}}
    pub(crate) fn interrupt_context(&self,scope:&str,generation:u64)->Result<()> {
        let current=self.context.lock().map_err(|_|"执行器状态不可用")?;
        if self.closing.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst)!=generation
            || current.as_ref().map(|c|c.scope.as_str())!=Some(scope){return Err("账号已切换，旧停止操作已取消".into());}
        self.interrupt();Ok(())
    }
    fn check(&self,scope:&str,generation:u64)->Result<()> {
        let context=self.context.lock().map_err(|_|"执行器状态不可用")?;
        self.check_locked(&context,scope,generation)
    }
    fn check_locked(&self,context:&Option<Context>,scope:&str,generation:u64)->Result<()> {
        if self.closing.load(Ordering::SeqCst) || self.generation.load(Ordering::SeqCst)!=generation
            || context.as_ref().map(|c|c.scope.as_str())!=Some(scope) {
            return Err("账号或数据配置已变化，执行器操作已取消".into());
        }Ok(())
    }
    fn current_binding(&self,app:&tauri::AppHandle,scope:&str,generation:u64)->Result<()> {
        self.check(scope,generation)?;
        let current=context(app,scope)?;
        let saved=self.context.lock().map_err(|_|"执行器状态不可用")?;
        self.check_locked(&saved,scope,generation)?;
        if saved.as_ref()!=Some(&current){return Err("本机账户或数据 Key 已变化，请重新同步准备数据".into());}Ok(())
    }
    async fn drain(&self,app:&tauri::AppHandle,managed:&mut Managed)->Result<bool> {
        let mut confirmed=true;
        if let Some(mut worker)=managed.worker.take(){
            let result=worker.close().await;
            confirmed=result.as_ref().is_ok_and(|status|status.state=="stopped");
            if let (Some(scope),Ok(status))=(managed.scope.as_ref(),&result){
                app.state::<LocalStoreState>().with(app,|db|db.cache(scope,"execution-lifecycle","account",&serde_json::to_value(status).map_err(|_|"执行器状态编码失败")?).map(|_|()))?;
            }
            if let Ok(mut slot)=self.interrupt.lock(){*slot=None;}
            result?;
        }
        managed.scope=None;Ok(confirmed)
    }
}
fn context(app:&tauri::AppHandle,scope:&str)->Result<Context>{
    if scope.is_empty() || scope.len()>1024{return Err("请先登录服务器账号".into());}
    let credential=crate::local_exchange::credentials(app,&app.state::<LocalStoreState>(),scope)?.filter(|c|c.server_bound).ok_or("请先同步服务器交易所账户")?;
    let key=market_data::read_key(app,scope)?;
    Ok(Context{scope:scope.into(),binding:crate::local_exchange::account_identity(&credential.api_key,credential.demo),key_hash:hash(key.as_bytes())})
}

#[tauri::command]
pub async fn desktop_executor_context(app:tauri::AppHandle,scope:Option<String>)->Result<u64>{
    let state=app.state::<ExecutionRuntime>();
    let next_result=scope.as_ref().map(|scope|context(&app,scope)).transpose();
    // A cleared/broken credential or Key must retire the old owner as well.
    let next=next_result.as_ref().ok().cloned().flatten();
    let expected_scope=next.as_ref().map(|c|c.scope.clone());
    let (changed,generation)=state.replace_context(next)?;
    if changed {let mut managed=state.operation.lock().await;
        if state.generation.load(Ordering::SeqCst)!=generation{return Err("账号已切换，旧执行器上下文已取消".into());}
        // A concurrent start can already have drained the old generation and
        // installed this new one before this context call acquires the mutex.
        if !managed.matches(expected_scope.as_deref(),generation){state.drain(&app,&mut managed).await?;}
    }
    next_result?;
    Ok(generation)
}

async fn json_body(mut response:reqwest::Response)->Result<Zeroizing<Vec<u8>>>{
    let mut bytes=Zeroizing::new(Vec::new());
    while let Some(chunk)=response.chunk().await.map_err(|_|"服务器同步响应中断")?{
        if bytes.len()+chunk.len()>6*1024*1024{return Err("服务器同步响应过大".into());}bytes.extend_from_slice(&chunk);
    }Ok(bytes)
}
async fn server_reply(response:reqwest::Response)->Result<Zeroizing<Vec<u8>>>{
    match response.status().as_u16(){
        200..=299=>json_body(response).await,
        401|403=>Err("服务器登录或实盘授权已过期，请重新登录后同步".into()),
        404|503=>Err("服务器尚未启用独立执行器，请完成部署后同步".into()),
        409=>Err("服务器任务授权尚未准备完成，请稍后重新同步".into()),
        _=>Err("服务器同步失败，本机准备数据已保留".into()),
    }
}

#[tauri::command]
pub async fn desktop_executor_prepare(app:tauri::AppHandle,scope:String,generation:u64,base:String,token:String)->Result<Value>{
    let token=Zeroizing::new(token);
    let state=app.state::<ExecutionRuntime>();state.current_binding(&app,&scope,generation)?;
    let base=crate::okx_analytics::server_base(&base)?;
    if !scope.starts_with(&(base.clone()+":")) || token.is_empty(){return Err("请先登录原服务器账号".into());}
    let key=market_data::read_key(&app,&scope)?;
    let client=reqwest::Client::builder().https_only(true).redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(30)).build().map_err(|_|"同步连接初始化失败")?;
    let response=client.post(format!("{base}/api/executor/registration")).bearer_auth(token.as_str()).json(&json!({"collection_key":key.as_str()})).send().await.map_err(|_|"服务器无法连接，不能新增或更新任务授权")?;
    let raw=server_reply(response).await?;
    let registration:Value=serde_json::from_slice(&raw).map_err(|_|"服务器任务登记格式无效")?;
    let account=registration["account_id"].as_str().ok_or("服务器未完成任务登记")?.to_owned();
    state.current_binding(&app,&scope,generation)?;
    let private=agreement::EphemeralPrivateKey::generate(&agreement::X25519,&rand::SystemRandom::new()).map_err(|_|"同步密钥生成失败")?;
    let public=private.compute_public_key().map_err(|_|"同步密钥生成失败")?;
    let response=client.post(format!("{base}/api/executor/bundle")).bearer_auth(token.as_str()).json(&json!({"account_id":account,"public_key":STANDARD.encode(public.as_ref())})).send().await.map_err(|_|"服务器暂时无法连接，本机准备数据已保留")?;
    let raw=server_reply(response).await?;
    let envelope:preparation::Envelope=serde_json::from_slice(&raw).map_err(|_|"服务器加密准备数据格式无效")?;
    let document=preparation::unseal(private,public.as_ref(),envelope)?;
    let keys=market_data::execution_request(&app,&app.state::<MarketDataState>(),&scope,"/v1/execution/authority-keys",None).await?;
    let credential=crate::local_exchange::credentials(&app,&app.state::<LocalStoreState>(),&scope)?.ok_or("请先同步交易所账户")?;
    let prepared=preparation::verify(document,&keys,&scope,&key,&credential,time::OffsetDateTime::now_utc().unix_timestamp(),false)?;
    if prepared.account_id!=account{return Err("服务器任务账户与加密准备数据不一致".into());}
    // Serialize all replacement/start/stop operations; keep the previous child
    // alive if fetching/verification fails. Recheck after draining and commit.
    let mut managed=state.operation.lock().await;
    state.current_binding(&app,&scope,generation)?;
    state.drain(&app,&mut managed).await?;
    state.current_binding(&app,&scope,generation)?;
    let sealed=market_data::protect(&prepared.document,entropy(&scope).as_bytes(),true)?;
    app.state::<LocalStoreState>().with(&app,|db|db.save_secret(&scope,"executor-preparation",&sealed))?;
    Ok(json!({"prepared":true,"account_id":prepared.account_id,"demo":prepared.demo}))
}

#[tauri::command]
pub async fn desktop_executor_start(app:tauri::AppHandle,scope:String,generation:u64,restore:Option<bool>)->Result<Value>{
    let state=app.state::<ExecutionRuntime>();
    let mut managed=state.operation.lock().await;
    state.current_binding(&app,&scope,generation)?;
    let store=app.state::<LocalStoreState>();
    if restore==Some(true) && !store.with(&app,|db|db.get(&scope,"execution-preference","local"))?.is_some_and(|r|r.value["enabled"]==true){return Ok(json!({"state":"disabled"}));}
    if managed.matches(Some(&scope),generation){if let Some(worker)=managed.worker.as_ref(){if !worker.finished(){return Ok(json!({"state":"preparing","pid":worker.pid}));}}}
    state.drain(&app,&mut managed).await?;
    let sealed=store.with(&app,|db|db.secret(&scope,"executor-preparation"))?.ok_or("请先登录服务器同步执行器准备数据")?;
    let document=Zeroizing::new(market_data::protect(&sealed,entropy(&scope).as_bytes(),false)?);
    let keys=market_data::execution_request(&app,&app.state::<MarketDataState>(),&scope,"/v1/execution/authority-keys",None).await?;
    let key=market_data::read_key(&app,&scope)?;
    let credential=crate::local_exchange::credentials(&app,&store,&scope)?.ok_or("请先同步服务器交易所账户")?;
    let prepared=preparation::verify(document,&keys,&scope,&key,&credential,time::OffsetDateTime::now_utc().unix_timestamp(),true)?;
    let root=runtime_directory(&app)?;
    let executable=tauri::async_runtime::spawn_blocking(move||execution_worker::verified_artifact(&root)).await.map_err(|_|"执行器构建检查失败")??;
    state.current_binding(&app,&scope,generation)?;
    let database=database_path(&app,&scope,&prepared.account_id)?;
    std::fs::create_dir_all(database.parent().ok_or("本机执行器目录无效")?).map_err(|_|"本机执行器目录创建失败")?;
    let mut raw=Zeroizing::new(Vec::with_capacity(prepared.document.len()+32));raw.extend_from_slice(b"{\"document\":");raw.extend_from_slice(&prepared.document);raw.extend_from_slice(b"}\n");
    if raw.len()>64*1024*1024{return Err("执行器准备数据过大".into());}
    let binding=context(&app,&scope)?;
    let location=json!({"account_id":prepared.account_id,"binding":binding.binding,"key_hash":binding.key_hash}).to_string();
    let location=market_data::protect(location.as_bytes(),location_entropy(&scope).as_bytes(),true)?;
    store.with(&app,|db|db.save_secret(&scope,"executor-location",&location))?;
    store.with(&app,|db|db.cache(&scope,"execution-lifecycle","account",&json!({"state":"preparing","account_id":prepared.account_id})).map(|_|()))?;
    let worker=Worker::launch(&executable,&database,&prepared.account_id,raw)?;
    *state.interrupt.lock().map_err(|_|"执行器状态不可用")?=Some(worker.stopper());
    let pid=worker.pid;managed.worker=Some(worker);managed.scope=Some(scope.clone());managed.generation=generation;
    if let Err(error)=state.current_binding(&app,&scope,generation){state.drain(&app,&mut managed).await?;return Err(error);}
    store.with(&app,|db|db.cache(&scope,"execution-preference","local",&json!({"enabled":true})).map(|_|()))?;
    Ok(json!({"state":"preparing","pid":pid}))
}

#[tauri::command]
pub async fn desktop_executor_status(app:tauri::AppHandle,scope:String,generation:u64)->Result<Value>{
    let state=app.state::<ExecutionRuntime>();state.current_binding(&app,&scope,generation)?;
    let managed=state.operation.lock().await;
    state.current_binding(&app,&scope,generation)?;
    let store=app.state::<LocalStoreState>();
    let prepared=store.with(&app,|db|db.secret(&scope,"executor-preparation"))?.is_some();
    let enabled=store.with(&app,|db|db.get(&scope,"execution-preference","local"))?.is_some_and(|r|r.value["enabled"]==true);
    let installed=runtime_directory(&app).map(|d|d.join("manifest.json").is_file()).unwrap_or(false);
    let status=if managed.matches(Some(&scope),generation){managed.worker.as_ref().map(|w|w.status()).transpose()?.map(|s|serde_json::to_value(s).unwrap_or(Value::Null))}else{None};
    let status=match status {Some(status)=>status,None=>{
        let saved=store.with(&app,|db|db.get(&scope,"execution-lifecycle","account"))?;
        if let Some(saved)=saved {if saved.value["state"]=="stopped"{json!({"state":"stopped"})}else{json!({"state":"waiting_reconciliation"})}}else{json!({"state":if prepared{"prepared"}else{"not_prepared"}})}
    }};
    Ok(json!({"prepared":prepared,"runtime_installed":installed,"enabled":enabled,"worker":status}))
}

fn snapshot_location(app:&tauri::AppHandle,scope:&str,generation:u64)->Result<Option<(PathBuf,String,String)>>{
    let state=app.state::<ExecutionRuntime>();state.current_binding(&app,&scope,generation)?;
    let binding=context(&app,&scope)?;
    let location=app.state::<LocalStoreState>().with(&app,|db|db.secret(&scope,"executor-location"))?;
    let Some(location)=location else{return Ok(None);};
    let raw=Zeroizing::new(market_data::protect(&location,location_entropy(&scope).as_bytes(),false)?);
    let location:Value=serde_json::from_slice(&raw).map_err(|_|"本机任务快照位置无效")?;
    if location["binding"]!=binding.binding || location["key_hash"]!=binding.key_hash{return Err("本机任务快照与当前交易账户配置不匹配，请同步准备数据".into());}
    let account=location["account_id"].as_str().filter(|v|v.len()==64 && v.bytes().all(|c|c.is_ascii_hexdigit() && !c.is_ascii_uppercase())).ok_or("本机任务快照账户编号无效")?.to_owned();
    let subject=scope.rsplit_once(':').map(|(_,subject)|subject.to_owned()).ok_or("请先登录服务器账号")?;
    let database=database_path(&app,&scope,&account)?;
    Ok(Some((database,subject,account)))
}

#[tauri::command]
pub async fn desktop_executor_snapshot(app:tauri::AppHandle,scope:String,generation:u64)->Result<Value>{
    let Some((database,subject,account))=snapshot_location(&app,&scope,generation)? else{return Ok(json!(crate::execution_snapshot::Snapshot::absent()));};
    let snapshot=tauri::async_runtime::spawn_blocking(move||crate::execution_snapshot::read(&database,&subject,&account)).await.map_err(|_|"本机任务快照读取失败")??;
    app.state::<ExecutionRuntime>().current_binding(&app,&scope,generation)?;
    Ok(json!(snapshot))
}

#[tauri::command]
pub async fn desktop_executor_history(app:tauri::AppHandle,scope:String,generation:u64,task_id:String,kind:String,offset:u32)->Result<Value>{
    let (database,subject,account)=snapshot_location(&app,&scope,generation)?.ok_or("尚无本机任务历史，请先同步准备数据")?;
    let history=tauri::async_runtime::spawn_blocking(move||crate::execution_snapshot::read_history(&database,&subject,&account,&task_id,&kind,offset)).await.map_err(|_|"本机任务历史读取失败")??;
    app.state::<ExecutionRuntime>().current_binding(&app,&scope,generation)?;
    Ok(json!(history))
}

#[tauri::command]
pub async fn desktop_executor_stop(app:tauri::AppHandle,scope:String,generation:u64)->Result<()> {
    let state=app.state::<ExecutionRuntime>();state.interrupt_context(&scope,generation)?;
    let mut managed=state.operation.lock().await;state.check(&scope,generation)?;
    app.state::<LocalStoreState>().with(&app,|db|db.cache(&scope,"execution-preference","local",&json!({"enabled":false})).map(|_|()))?;
    if state.drain(&app,&mut managed).await?{Ok(())}else{Err("进程已退出，交接未确认，请核对账户交易结果".into())}
}

/// Tray hiding never calls this. It runs after window-close guards accepted,
/// and before the updater starts an installer which may terminate this process.
pub async fn shutdown(app:&tauri::AppHandle)->Result<()> {
    let state=app.state::<ExecutionRuntime>();state.closing.store(true,Ordering::SeqCst);
    state.generation.fetch_add(1,Ordering::SeqCst);state.interrupt();
    let result={let mut managed=state.operation.lock().await;state.drain(app,&mut managed).await};
    // Existing submissions retain their original journal/receipt. New or queued
    // sends fail the generation guard. Do not install over an in-flight manual
    // operation; actual exit may still terminate after this bounded wait.
    let market=app.state::<MarketDataState>();
    let manual=tokio::time::timeout(Duration::from_secs(45),market.manual_slot.lock()).await;
    if manual.is_err(){return Err("手动操作结果未确认，请核对账户后重试更新".into());}
    if result?{Ok(())}else{Err("执行器退出未确认，请核对账户状态".into())}
}
pub fn allow_resume_after_failed_update(app:&tauri::AppHandle){app.state::<ExecutionRuntime>().closing.store(false,Ordering::SeqCst);}

/// Credential/Key commits synchronously revoke pending native starts and signal
/// the active child. Its existing account still drains under center fencing.
pub(crate) fn invalidate_account(app:&tauri::AppHandle,scope:&str){
    let Some(state)=app.try_state::<ExecutionRuntime>() else{return;};
    if let Ok(mut context)=state.context.lock(){
        if context.as_ref().is_some_and(|c|c.scope==scope){
            *context=None;state.generation.fetch_add(1,Ordering::SeqCst);state.interrupt();
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_account_generations_and_shutdown_cannot_start_a_worker(){
        let state=ExecutionRuntime::default();
        *state.context.lock().unwrap()=Some(Context{scope:"server:user".into(),binding:"key-demo".into(),key_hash:"key-hash".into()});
        state.generation.store(4,Ordering::SeqCst);
        assert!(state.check("server:user",4).is_ok());
        assert_eq!(state.action_generation("server:user").unwrap(),4);
        assert!(state.action_generation("server:other").is_err());
        assert!(state.check_action("server:user",4).is_ok());
        assert!(state.check("server:other",4).is_err());
        assert!(state.check("server:user",3).is_err());
        state.closing.store(true,Ordering::SeqCst);
        assert!(state.action_generation("server:user").is_err());
        assert!(state.check_action("server:user",4).is_err());
        assert!(state.check("server:user",4).is_err());
        state.closing.store(false,Ordering::SeqCst);state.generation.fetch_add(1,Ordering::SeqCst);
        assert!(state.check_action("server:user",4).is_err());
        assert!(state.check("server:user",4).is_err());
    }
    #[test]
    fn context_retirement_cannot_reuse_old_credentials_or_stop_a_newer_matching_launch(){
        let mut managed=Managed{scope:Some("server:user".into()),generation:4,..Managed::default()};
        assert!(managed.matches(Some("server:user"),4));
        assert!(!managed.matches(Some("server:other"),4));
        assert!(!managed.matches(Some("server:user"),5));
        // A start for generation 5 wins the operation mutex before the matching
        // context retirement. That retirement must now leave it alone.
        managed.generation=5;
        assert!(managed.matches(Some("server:user"),5));
        assert!(!managed.matches(None,5));
    }
    #[test]
    fn each_context_retains_its_own_generation_before_retirement_waits(){
        let state=ExecutionRuntime::default();
        let first=Context{scope:"server:first".into(),binding:"first".into(),key_hash:"key".into()};
        let second=Context{scope:"server:second".into(),binding:"second".into(),key_hash:"key".into()};
        let (changed,first_generation)=state.replace_context(Some(first)).unwrap();
        assert!(changed);
        let (changed,second_generation)=state.replace_context(Some(second.clone())).unwrap();
        assert!(changed);assert!(second_generation>first_generation);
        assert!(state.check("server:first",first_generation).is_err());
        assert_eq!(state.replace_context(Some(second)).unwrap(),(false,second_generation));
        assert!(state.check("server:second",second_generation).is_ok());
        // The delayed first retirement sees its stale generation and exits;
        // it cannot acquire the second generation by reading after the swap.
        assert_ne!(state.generation.load(Ordering::SeqCst),first_generation);
    }
    #[test]
    fn delayed_stop_cannot_signal_the_new_accounts_worker(){
        let state=ExecutionRuntime::default();
        let (_,old)=state.replace_context(Some(Context{scope:"server:old".into(),binding:"old".into(),key_hash:"key".into()})).unwrap();
        let (_,new)=state.replace_context(Some(Context{scope:"server:new".into(),binding:"new".into(),key_hash:"key".into()})).unwrap();
        let (stop,mut control)=tokio::sync::mpsc::channel(1);
        *state.interrupt.lock().unwrap()=Some(stop);
        assert!(state.interrupt_context("server:old",old).is_err());
        assert!(control.try_recv().is_err());
        state.interrupt_context("server:new",new).unwrap();
        assert_eq!(control.try_recv().unwrap(),());
    }
}
