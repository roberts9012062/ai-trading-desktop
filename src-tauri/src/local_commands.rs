//! Manual exchange commands. No task creation, background loops or replay.
use super::*;
use tauri::Manager;
use crate::local_store::Intent;
use crate::market_data::{execution_request,private_command};
use std::collections::HashMap;
#[path="local_orders.rs"]
mod orders;

fn unique()->Result<String>{
    use ring::rand::{SecureRandom,SystemRandom};
    let mut bytes=[0u8;16];SystemRandom::new().fill(&mut bytes).map_err(|_|"无法生成交易指令编号")?;
    Ok(bytes.iter().map(|b|format!("{b:02x}")).collect())
}
fn center_account(uid:&str,demo:bool)->Result<String>{
    if uid.is_empty()||uid.len()>100||!uid.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){return Err("交易所账户身份无效".into())}
    Ok(digest::digest(&digest::SHA256,format!("okx-account:{demo}:{uid}").as_bytes()).as_ref().iter().map(|b|format!("{b:02x}")).collect())
}
fn claim(account:&str,owner:&str,epoch:u64)->Value{json!({"account_id":account,"owner":owner,"epoch":epoch,"role":"manual"})}
fn stop_target(value:&Value)->Result<(String,u64)>{
    if value["enrolled"]!=true{return Err("当前账户尚未登记服务器任务".into())}
    let account=value["account_id"].as_str().filter(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase())).ok_or("接口中心账户绑定格式异常")?;
    let epoch=value["epoch"].as_u64().ok_or("接口中心账户执行状态不完整")?;
    Ok((account.into(),epoch))
}
fn stop_response(account:&str,value:&Value)->Result<Value>{
    if value["account_id"].as_str()!=Some(account)||value["recovery_required"]!=true||value["epoch"].as_u64().is_none_or(|epoch|epoch==0)||!value["unresolved_commands"].is_boolean(){return Err("接口中心未确认账户停止，请重新核对账户状态".into())}
    let pending=value["unresolved_commands"]==true;
    Ok(json!({"ok":true,"recovery_required":true,"unresolved_commands":pending,"message":if pending{"接口中心已停止当前 OKX 账户全部自动任务，仍有交易结果待核对；本次操作未撤单或平仓，请先核对原指令。"}else{"接口中心已停止当前 OKX 账户全部自动任务。本次操作未撤单或平仓，请手动处理持仓与委托，确认账户清空后再通过服务器手动启动任务。"}}))
}
fn rows(value:Value)->Result<Vec<Value>>{value.as_array().cloned().ok_or("接口中心执行状态格式异常".into())}
async fn read(app:&tauri::AppHandle,market:&MarketDataState,scope:&str,credential:&NativeCredentials,path:&str,owner:&str)->Result<Vec<Value>>{
    let value=crate::market_data::private_request(app,market,scope,||{let mut request=signed(credential,"GET",path,"")?;request["execution_owner"]=json!(owner);Ok(request)}).await?;
    if value["code"]!="0"{return Err(format!("交易所核对失败：{}",value["msg"].as_str().unwrap_or("未取得完整账户状态")))}
    value["data"].as_array().cloned().ok_or("交易所核对数据格式异常".into())
}
fn lookup_path(lookup:&Value)->Result<String>{
    let path=lookup["path"].as_str().ok_or("缺少对账地址")?;
    if !["/api/v5/trade/order","/api/v5/trade/order-algo"].contains(&path){return Err("不支持的交易对账，请保留停止状态".into())}
    let params=lookup["params"].as_object().filter(|p|!p.is_empty()&&p.len()<=2).ok_or("无效的对账参数")?;
    let mut url=reqwest::Url::parse(&format!("https://www.okx.com{path}")).map_err(|_|"对账地址错误")?;
    for (name,value) in params{
        if !["instId","clOrdId","ordId","algoId","algoClOrdId"].contains(&name.as_str()){return Err("无效的对账参数".into())}
        let value=value.as_str().filter(|s|!s.is_empty()&&s.len()<=100).ok_or("无效的对账编号")?;
        url.query_pairs_mut().append_pair(name,value);
    }
    Ok(format!("{}?{}",url.path(),url.query().ok_or("缺少对账编号")?))
}
async fn reconcile_remote(app:&tauri::AppHandle,market:&MarketDataState,scope:&str,credential:&NativeCredentials,account:&str,owner:&str)->Result<()>{
    let path=format!("/v1/execution/unresolved?account_id={account}");
    let pending=rows(execution_request(app,market,scope,&path,None).await?)?;
    // The coordinator serializes commands; a bounded list must be entirely
    // resolved, never interpreted as a partial successful reconciliation.
    for item in pending{
        let lookups=item["lookups"].as_array().filter(|v|!v.is_empty()).ok_or("上一笔交易缺少可验证结果，请保持任务停止并核对交易所")?;
        for lookup in lookups{read(app,market,scope,credential,&lookup_path(lookup)?,owner).await?;}
    }
    if !rows(execution_request(app,market,scope,&path,None).await?)?.is_empty(){return Err("上一笔交易结果尚未确认，已阻止重复操作".into())}
    Ok(())
}
fn settle_local(db:&mut crate::local_store::Store,namespace:&str,local:&[Value],remote:&[Value],new_epoch:u64)->Result<()>{
    for item in local{
        let id=item["id"].as_str().ok_or("本机交易编号损坏")?;
        let request=&item["request"];
        if let Some(found)=remote.iter().find(|r|r["id"].as_str()==Some(id)){
            if found["request"]["method"]!=request["method"]||found["request"]["path"]!=request["path"]||found["request"]["body"]!=request["body"]{return Err("本机与接口中心的交易指令不一致".into())}
            match found["status"].as_str(){
                Some("reconciled")=>db.reconcile_intent(namespace,id)?,
                Some("complete")=>{
                    let raw=found["raw"].as_str().ok_or("交易结果记录缺失")?;
                    let value:Value=serde_json::from_str(raw).map_err(|_|"交易结果记录损坏")?;
                    if !valid_ack(&value,request["path"].as_str().unwrap_or(""),&serde_json::from_str::<Value>(request["body"].as_str().unwrap_or("")).map_err(|_|"本机交易指令损坏")?){return Err("上一笔交易回执不完整，请保持停止并核对交易所".into())}
                    db.finish_intent(namespace,id,Some(&value))?;
                },
                _=>return Err("上一笔交易结果尚未确认".into()),
            }
        }else{
            // Absence alone is NOT evidence. A newer exclusive epoch first
            // fences every delayed request made by the old native process.
            let old=request["epoch"].as_u64().ok_or("旧交易指令缺少执行权记录")?;
            if old>=new_epoch{return Err("旧交易指令仍可能在途，请等待执行权过期后重新核对".into())}
            db.reconcile_intent(namespace,id)?;
        }
    }
    Ok(())
}
async fn reconcile_local(app:&tauri::AppHandle,market:&MarketDataState,store:&LocalStoreState,scope:&str,namespace:&str,account:&str,epoch:u64)->Result<()>{
    let local=store.with(app,|db|db.unresolved_intents(namespace))?;
    for batch in local.chunks(20){
        let ids=batch.iter().map(|r|r["id"].as_str().filter(|id|id.len()==32&&id.bytes().all(|b|b.is_ascii_hexdigit())).ok_or("本机交易编号损坏")).collect::<std::result::Result<Vec<_>,_>>()?.join(",");
        let remote=rows(execution_request(app,market,scope,&format!("/v1/execution/intents?account_id={account}&ids={ids}"),None).await?)?;
        store.with(app,|db|settle_local(db,namespace,batch,&remote,epoch))?;
    }
    Ok(())
}
fn cancel_body(route:&str,query:&HashMap<String,String>)->Result<(&'static str,Value)>{
    let raw=route.strip_prefix("/api/live/orders/").ok_or("无效的撤单地址")?;
    let raw=raw.replace("%3A",":").replace("%3a",":");
    let (algo,id)=raw.strip_prefix("algo:").map(|id|(true,id)).unwrap_or((false,&raw));
    if id.is_empty()||id.len()>32||!id.bytes().all(|b|b.is_ascii_digit()){return Err("无效的撤单编号".into())}
    let inst=instrument(query.get("symbol").ok_or("撤单必须指定合约")?)?;
    Ok(if algo{("/api/v5/trade/cancel-algos",json!([{"instId":inst,"algoId":id}]))}else{("/api/v5/trade/cancel-order",json!({"instId":inst,"ordId":id}))})
}
fn close_body(body:&Value,positions:&[Value],id:&str)->Result<Value>{
    let inst=instrument(body["symbol"].as_str().ok_or("平仓必须指定合约")?)?;
    let side=body["pos_side"].as_str();
    if !body["pos_side"].is_null()&&!matches!(side,Some("long"|"short"|"net")){return Err("无效的持仓方向".into())}
    let positions:Vec<_>=positions.iter().filter(|r|r["instId"]==inst&&num(&r["pos"])!=0.0&&side.map(|s|r["posSide"]==s||r["posSide"]=="net"&&((s=="long"&&num(&r["pos"])>0.0)||(s=="short"&&num(&r["pos"])<0.0))).unwrap_or(true)).collect();
    if positions.len()!=1{return Err("未找到唯一的待平持仓，请刷新并选择正确方向".into())}
    let row=positions[0];let mode=row["mgnMode"].as_str().filter(|m|matches!(*m,"cross"|"isolated")).ok_or("持仓保证金模式无效")?;
    let side=row["posSide"].as_str().filter(|s|matches!(*s,"long"|"short"|"net")).ok_or("持仓方向无效")?;
    // autoCxl=false: never silently cancel protective orders as a side effect.
    Ok(json!({"instId":inst,"mgnMode":mode,"posSide":side,"clOrdId":id,"autoCxl":false}))
}
fn valid_ack(value:&Value,path:&str,body:&Value)->bool{
    let Some(code)=value["code"].as_str() else{return false};
    if !value["data"].is_array(){return false}
    if code!="0"{return code.parse::<u32>().is_ok_and(|n|n!=0)}
    let Some(rows)=value["data"].as_array().filter(|r|r.len()==1) else{return false};
    let row=&rows[0];
    if let Some(value)=row.get("sCode"){let Some(code)=value.as_str() else{return false};if code!="0"{return code.parse::<u32>().is_ok_and(|n|n!=0)}}
    let original=if body.is_array(){&body[0]}else{body};
    if path=="/api/v5/account/set-leverage"{
        return ["instId","mgnMode","posSide","lever"].iter().all(|key|original.get(*key).is_none()||if *key=="lever"{Decimal::from_str(&strval(&row[*key])).ok().zip(Decimal::from_str(&strval(&original[*key])).ok()).is_some_and(|(a,b)|a==b)}else{row[*key]==original[*key]})
    }
    if path=="/api/v5/trade/order"&&(!row["ordId"].as_str().is_some_and(|s|!s.is_empty())||row["sCode"]!="0"){return false}
    let identity=if path.ends_with("cancel-algos"){"algoId"}else if matches!(path,"/api/v5/trade/close-position"|"/api/v5/trade/order"){"clOrdId"}else{"ordId"};
    row[identity].as_str().is_some_and(|id|!id.is_empty()&&row[identity]==original[identity])
        &&(row.get("instId").is_none()||row["instId"]==original["instId"])
}

struct Submission<'a>{app:&'a tauri::AppHandle,market:&'a MarketDataState,store:&'a LocalStoreState,scope:&'a str,credential:&'a NativeCredentials,namespace:&'a str,account:&'a str,owner:&'a str,epoch:u64,generation:u64}
impl Submission<'_>{
    async fn send(&self,path:&str,command:&Value,id:&str,metadata:Option<Value>)->Result<Value>{
        self.app.state::<crate::execution_runtime::ExecutionRuntime>().check_action(self.scope,self.generation)?;
        execution_request(self.app,self.market,self.scope,"/v1/execution/renew",Some(claim(self.account,self.owner,self.epoch))).await?;
        let encoded=serde_json::to_string(command).map_err(|_|"交易指令编码失败")?;
        let request=json!({"method":"POST","path":path,"query":"","body":encoded,"owner":self.owner,"epoch":self.epoch,"metadata":metadata});
        let hash:String=digest::digest(&digest::SHA256,format!("{path}:{encoded}").as_bytes()).as_ref().iter().map(|b|format!("{b:02x}")).collect();
        let dispatched=std::sync::atomic::AtomicBool::new(false);
        let result=private_command(self.app,self.market,self.scope,||{
            self.app.state::<crate::execution_runtime::ExecutionRuntime>().check_action(self.scope,self.generation)?;
            let mut value=signed(self.credential,"POST",path,&encoded)?;
            value["execution"]=json!({"owner":self.owner,"epoch":self.epoch,"intent_id":id});Ok(value)
        },||{
            self.app.state::<crate::execution_runtime::ExecutionRuntime>().check_action(self.scope,self.generation)?;
            if let Some(stamp)=metadata.as_ref().and_then(|m|m.get("quote_ts")).filter(|s|!s.is_null()){orders::validate_quote_time(stamp)?;}
            self.store.with(self.app,|db|match db.begin_command(self.namespace,id,&hash,&request)?{
            Intent::Fresh=>{
                self.app.state::<crate::execution_runtime::ExecutionRuntime>().check_action(self.scope,self.generation)?;
                // A contended SQLite commit may itself take several seconds.
                if let Some(stamp)=metadata.as_ref().and_then(|m|m.get("quote_ts")).filter(|s|!s.is_null()){orders::validate_quote_time(stamp)?;}
                dispatched.store(true,std::sync::atomic::Ordering::SeqCst);Ok(())
            },Intent::Known(value)=>Err(format!("交易指令已处理（{}），不能重复发送",value["code"].as_str().unwrap_or("已记录"))),Intent::Unknown=>Err("上一笔交易结果未知，不能重复发送".into())
        })}).await;
        let raw=match result{
            Ok(value) if valid_ack(&value,path,command)=>{self.store.with(self.app,|db|db.finish_intent(self.namespace,id,Some(&value)))?;value},
            Err(error) if !dispatched.load(std::sync::atomic::Ordering::SeqCst)=>return Err(error),
            _=>{self.store.with(self.app,|db|db.finish_intent(self.namespace,id,None))?;return Err("交易结果尚未确认，已阻止重复发送。请稍后再次核对账户；程序重启不会重发指令。".into())},
        };
        if raw["code"]!="0"||raw["data"][0]["sCode"].as_str().is_some_and(|s|s!="0"){
            return Err(format!("{}交易所拒绝操作：{}",if path=="/api/v5/trade/order"{"[ORDER_REJECTED] "}else{""},raw["data"][0]["sMsg"].as_str().filter(|s|!s.is_empty()).or_else(||raw["msg"].as_str()).unwrap_or("请核对账户参数")))
        }
        Ok(raw)
    }
}

fn receipt_result(id:&str,record:&Value)->Result<Option<Value>>{
    if record["id"]!=id||record["request"]["path"]!="/api/v5/trade/order"{return Err("接口中心下单记录不匹配".into())}
    let command:Value=serde_json::from_str(record["request"]["body"].as_str().ok_or("接口中心下单记录缺失")?).map_err(|_|"接口中心下单记录损坏")?;
    if command["clOrdId"]!=id{return Err("接口中心下单编号不匹配".into())}
    if record["status"]=="complete"{
        let raw:Value=serde_json::from_str(record["raw"].as_str().ok_or("原始回执缺失")?).map_err(|_|"原始回执损坏")?;
        if !valid_ack(&raw,"/api/v5/trade/order",&command){return Ok(None)}
        if raw["code"]!="0"||raw["data"][0]["sCode"].as_str().is_some_and(|c|c!="0"){return Ok(Some(json!({"state":"rejected","message":"上一笔下单已被交易所明确拒绝，可核对参数后重新提交。"})))}
        let order_id=raw["data"][0]["ordId"].as_str().ok_or("交易所订单编号缺失")?;
        return Ok(Some(json!({"state":"accepted","message":format!("上一笔下单已受理，交易所订单号 {order_id}。请在委托和成交记录中确认执行情况；本次核对未发送新订单。")})))
    }
    if record["status"]=="reconciled"{
        let proof=&record["request"]["_settlement_proofs"]["0"];
        if proof["clOrdId"]!=id||proof["instId"]!=command["instId"]||!proof["ordId"].as_str().is_some_and(|s|!s.is_empty()){return Ok(None)}
        return Ok(Some(json!({"state":"reconciled","message":format!("上一笔下单已由交易所记录确认，订单号 {}。请核对委托与成交；本次核对未重新发送订单。",proof["ordId"].as_str().unwrap_or(""))})))
    }
    Ok(None)
}

async fn receipt(app:&tauri::AppHandle,market:&MarketDataState,store:&LocalStoreState,scope:&str,credential:&NativeCredentials,id:&str)->Result<Value>{
    if !credential.server_bound||id.len()!=32||!id.bytes().all(|b|b.is_ascii_hexdigit()){return Err("请先同步账户并提供有效下单编号".into())}
    let owner=format!("manual_{}",unique()?);
    let config=read(app,market,scope,credential,"/api/v5/account/config",&owner).await?;
    let account=center_account(config.first().and_then(|c|c["uid"].as_str()).ok_or("交易所账户身份缺失")?,credential.demo)?;
    let path=format!("/v1/execution/intents?account_id={account}&ids={id}");
    let mut remote=rows(execution_request(app,market,scope,&path,None).await?)?;
    if let Some(record)=remote.first(){
        if receipt_result(id,record)?.is_none(){
            let command:Value=serde_json::from_str(record["request"]["body"].as_str().ok_or("下单记录缺失")?).map_err(|_|"下单记录损坏")?;
            let lookup=lookup_path(&json!({"path":"/api/v5/trade/order","params":{"instId":command["instId"],"clOrdId":id}}))?;
            // A failed/empty lookup remains unknown. This endpoint never sends
            // an order, even when no local journal entry exists.
            let _=read(app,market,scope,credential,&lookup,&owner).await;
            remote=rows(execution_request(app,market,scope,&path,None).await?)?;
        }
        if let Some(record)=remote.first(){if let Some(result)=receipt_result(id,record)?{return Ok(result)}}
        return Ok(json!({"state":"unknown","message":"上一笔下单结果仍未确认，已保留请求编号并阻止重复发送，请稍后继续核对。"}))
    }
    read(app,market,scope,credential,"/api/v5/account/positions",&owner).await?;
    read(app,market,scope,credential,"/api/v5/trade/orders-pending",&owner).await?;
    let lease=execution_request(app,market,scope,"/v1/execution/acquire",Some(claim(&account,&owner,0))).await?;
    let epoch=lease["epoch"].as_u64().ok_or("执行权记录缺失")?;
    let outcome=async{
        if !rows(execution_request(app,market,scope,&path,None).await?)?.is_empty(){return Err("下单记录已变化，请重新核对".into())}
        reconcile_local(app,market,store,scope,&format!("{scope}:commands:{account}"),&account,epoch).await?;
        Ok(json!({"state":"not_sent","message":"接口中心未登记这笔下单，旧执行权已隔离。可核对参数后重新提交；本次核对未发送订单。"}))
    }.await;
    let _=execution_request(app,market,scope,"/v1/execution/release",Some(claim(&account,&owner,epoch))).await;
    outcome
}

pub(super) async fn execute(app:&tauri::AppHandle,market:&MarketDataState,store:&LocalStoreState,scope:&str,credential:&NativeCredentials,route:&str,query:&HashMap<String,String>,body:&Value)->Result<Value>{
    let generation=app.state::<crate::execution_runtime::ExecutionRuntime>().action_generation(scope)?;
    // This explicit control request can stop new scheduling while an earlier
    // financial request is being reconciled. It never submits an exchange write.
    if route=="/api/live/local-execution/stop-account"{return run(app,market,store,scope,credential,route,query,body,generation).await}
    // Reject overlapping actions instead of leaving a second financial command
    // queued in native code after the UI/account has already changed.
    let _guard=market.manual_slot.try_lock().map_err(|_|"另一笔手动操作正在核对或发送，请等待结果")?;
    if route=="/api/live/local-order"{return receipt(app,market,store,scope,credential,query.get("client_request_id").map(String::as_str).unwrap_or("")).await}
    let result=run(app,market,store,scope,credential,route,query,body,generation).await;
    if route=="/api/live/orders"{
        if let Err(error)=result{
            if error.starts_with("[ORDER_NOT_SENT]")||error.starts_with("[ORDER_REJECTED]"){return Err(error)}
            let id=body["client_request_id"].as_str().unwrap_or("");
            let not_sent=store.with(app,|db|db.order_command(scope,id)).is_ok_and(|v|v.is_none());
            return Err(format!("[{}] {error}",if not_sent{"ORDER_NOT_SENT"}else{"ORDER_OUTCOME_UNKNOWN"}))
        }
    }
    result
}

async fn run(app:&tauri::AppHandle,market:&MarketDataState,store:&LocalStoreState,scope:&str,credential:&NativeCredentials,route:&str,query:&HashMap<String,String>,body:&Value,generation:u64)->Result<Value>{
    if !credential.server_bound{return Err("请先同步服务器交易所账户".into())}
    if route!="/api/live/local-execution/stop-account"&&!credential.demo&&permission(app,store,scope)?["enabled"]!=true{return Err("实盘账户未授权".into())}
    if route=="/api/live/local-execution/stop-account"{
        // Existing center binding was verified by an exchange config response.
        // No exchange request or private-order queue can delay this control.
        let binding=account_identity(&credential.api_key,credential.demo);
        let target=execution_request(app,market,scope,"/v1/execution/account-for-key",Some(json!({"key_fingerprint":binding}))).await?;
        let (account,epoch)=stop_target(&target)?;
        let state=app.state::<crate::execution_runtime::ExecutionRuntime>();
        state.check_action(scope,generation)?;
        let response=execution_request(app,market,scope,"/v1/execution/stop-account",Some(json!({"account_id":account,"expected_epoch":epoch}))).await?;
        let result=stop_response(&account,&response)?;
        state.interrupt_context(scope,generation)?;
        return Ok(result)
    }
    let owner=format!("manual_{}",unique()?);
    let config=read(app,market,scope,credential,"/api/v5/account/config",&owner).await?;
    let account=center_account(config.first().and_then(|c|c["uid"].as_str()).ok_or("交易所账户身份缺失")?,credential.demo)?;
    let namespace=format!("{scope}:commands:{account}");
    let id=if route=="/api/live/orders"{
        let id=body["client_request_id"].as_str().filter(|id|id.len()==32&&id.bytes().all(|b|b.is_ascii_hexdigit())).ok_or("下单请求编号缺失或无效")?.to_owned();
        if let Some(saved)=store.with(app,|db|db.order_command(scope,&id))?{
            if saved["namespace"]!=namespace||saved["request"]["metadata"]["input"]!=*body{return Err("同一请求编号不能修改下单内容或切换交易账户".into())}
            let command:Value=serde_json::from_str(saved["request"]["body"].as_str().ok_or("本机下单记录损坏")?).map_err(|_|"本机下单记录损坏")?;
            if saved["status"]=="complete"{
                let raw=&saved["raw"];
                if !valid_ack(raw,"/api/v5/trade/order",&command){return Err("原始下单回执不完整".into())}
                if raw["code"]!="0"||raw["data"][0]["sCode"].as_str().is_some_and(|c|c!="0"){return Err("[ORDER_REJECTED] 上一次下单已被交易所拒绝，请核对参数后重新提交".into())}
                return orders::ack(&command,&saved["request"]["metadata"]["spec"],raw)
            }
            reconcile_remote(app,market,scope,credential,&account,&owner).await?;
            let remote=rows(execution_request(app,market,scope,&format!("/v1/execution/intents?account_id={account}&ids={id}"),None).await?)?;
            if let Some(found)=remote.iter().find(|r|r["id"]==id&&r["status"]=="complete"){
                if found["request"]["path"]!="/api/v5/trade/order"||found["request"]["body"]!=saved["request"]["body"]{return Err("本机与接口中心下单内容不一致".into())}
                let raw:Value=serde_json::from_str(found["raw"].as_str().ok_or("接口中心回执缺失")?).map_err(|_|"接口中心回执损坏")?;
                if !valid_ack(&raw,"/api/v5/trade/order",&command){return Err("接口中心下单回执不完整".into())}
                store.with(app,|db|db.finish_intent(&namespace,&id,Some(&raw)))?;
                if raw["code"]!="0"||raw["data"][0]["sCode"].as_str().is_some_and(|c|c!="0"){return Err("[ORDER_REJECTED] 上一次下单已被交易所拒绝，请核对参数后重新提交".into())}
                return orders::ack(&command,&saved["request"]["metadata"]["spec"],&raw)
            }
            if remote.is_empty(){
                read(app,market,scope,credential,"/api/v5/account/positions",&owner).await?;
                read(app,market,scope,credential,"/api/v5/trade/orders-pending",&owner).await?;
                let lease=execution_request(app,market,scope,"/v1/execution/acquire",Some(claim(&account,&owner,0))).await?;
                let epoch=lease["epoch"].as_u64().ok_or("执行权记录缺失")?;
                let outcome=reconcile_local(app,market,store,scope,&namespace,&account,epoch).await;
                let _=execution_request(app,market,scope,"/v1/execution/release",Some(claim(&account,&owner,epoch))).await;
                outcome?;
                return Err("[ORDER_NOT_SENT] 上次下单未在接口中心登记，旧执行权已隔离；请核对参数后重新提交".into())
            }
            let params=lookup_path(&json!({"path":"/api/v5/trade/order","params":{"instId":command["instId"],"clOrdId":id}}))?;
            let actual=read(app,market,scope,credential,&params,&owner).await?;
            if remote.iter().any(|r|r["id"]==id&&r["status"]=="reconciled")&&actual.len()==1{
                store.with(app,|db|db.reconcile_intent(&namespace,&id))?;
                let mut result=order(&actual[0],&saved["request"]["metadata"]["spec"]);result["reconciled"]=json!(true);return Ok(result)
            }
            // No financial replay is allowed, even if the original command is
            // absent from the center. The user must review the original order.
            return Err("上一笔下单尚未取得可验证结果，请先核对交易所，不会重复发送".into())
        }
        id
    }else{unique()?};
    reconcile_remote(app,market,scope,credential,&account,&owner).await?;
    let order_inputs=if route=="/api/live/orders"{Some(orders::load(app,market,store,scope,credential,body,config.first().ok_or("缺少账户配置")?,&owner).await?)}else{None};
    let positions=read(app,market,scope,credential,"/api/v5/account/positions",&owner).await?;
    read(app,market,scope,credential,"/api/v5/trade/orders-pending",&owner).await?;
    app.state::<crate::execution_runtime::ExecutionRuntime>().check_action(scope,generation)?;
    let lease=execution_request(app,market,scope,"/v1/execution/acquire",Some(claim(&account,&owner,0))).await?;
    let epoch=lease["epoch"].as_u64().filter(|n|*n>0).ok_or("接口中心未返回有效执行权")?;
    let outcome=async{
        reconcile_local(app,market,store,scope,&namespace,&account,epoch).await?;
        let submission=Submission{app,market,store,scope,credential,namespace:&namespace,account:&account,owner:&owner,epoch,generation};
        if let Some(inputs)=order_inputs{
            if lease["recovery_required"]==true{return Err("账户已停机锁定，请先手动平仓并核对，停止的任务需登录服务器手动启动".into())}
            let plan=orders::build(body,config.first().ok_or("缺少账户配置")?,inputs,&positions,&id)?;
            if let Some(change)=plan.leverage{submission.send("/api/v5/account/set-leverage",&change,&unique()?,None).await?;}
            let raw=submission.send("/api/v5/trade/order",&plan.command,&id,Some(json!({"input":body,"spec":plan.spec,"quote_ts":plan.quote_ts}))).await?;
            return orders::ack(&plan.command,&plan.spec,&raw)
        }
        if route=="/api/live/local-execution/confirm-flat"{
            for kind in ALGO_TYPES{if !read(app,market,scope,credential,&format!("/api/v5/trade/orders-algo-pending?ordType={kind}"),&owner).await?.is_empty(){return Err("交易所仍有策略委托，请先撤单再确认".into())}}
            let current=read(app,market,scope,credential,"/api/v5/account/positions",&owner).await?;
            if !current.iter().all(|row|row["pos"].as_str().and_then(|s|Decimal::from_str(s).ok())==Some(Decimal::ZERO)){return Err("交易所仍有持仓或返回不完整，请先手动平仓".into())}
            if !read(app,market,scope,credential,"/api/v5/trade/orders-pending",&owner).await?.is_empty(){return Err("交易所仍有普通挂单，请先撤单再确认".into())}
            app.state::<crate::execution_runtime::ExecutionRuntime>().check_action(scope,generation)?;
            let result=execution_request(app,market,scope,"/v1/execution/confirm-flat",Some(claim(&account,&owner,epoch))).await?;
            return Ok(json!({"ok":true,"recovery_required":result["recovery_required"],"message":"交易所已确认空仓且无待执行委托；本次确认不会启动任务。恢复停止的任务仍需登录服务器手动启动。"}))
        }
        let (path,command)=if route=="/api/live/positions/close"{("/api/v5/trade/close-position",close_body(body,&positions,&id)?)}else{cancel_body(route,query)?};
        let raw=submission.send(path,&command,&id,None).await?;
        Ok(json!({"ok":true,"command_id":id,"raw":raw}))
    }.await;
    // Releasing cannot erase unknown outcomes; the coordinator blocks it.
    let _=execution_request(app,market,scope,"/v1/execution/release",Some(claim(&account,&owner,epoch))).await;
    outcome
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn account_stop_requires_a_confirmed_matching_center_response(){
        let response=json!({"account_id":"account","epoch":4,"recovery_required":true,"unresolved_commands":false});
        assert_eq!(stop_response("account",&response).unwrap()["ok"],true);
        assert!(stop_response("other",&response).is_err());
        assert!(stop_response("account",&json!({"account_id":"account","epoch":4,"recovery_required":false})).is_err());
        assert!(stop_response("account",&json!({"account_id":"account","epoch":4,"recovery_required":true})).is_err());
        let pending=json!({"account_id":"account","epoch":5,"recovery_required":true,"unresolved_commands":true});
        assert_eq!(stop_response("account",&pending).unwrap()["unresolved_commands"],true);
    }
    #[test]fn account_stop_target_requires_verified_enrollment_and_typed_epoch(){
        let account="a".repeat(64);
        let value=json!({"account_id":account,"epoch":4,"enrolled":true});
        assert_eq!(stop_target(&value).unwrap(),("a".repeat(64),4));
        assert!(stop_target(&json!({"account_id":account,"epoch":4,"enrolled":false})).is_err());
        assert!(stop_target(&json!({"account_id":"bad","epoch":4,"enrolled":true})).is_err());
        assert!(stop_target(&json!({"account_id":account,"epoch":"4","enrolled":true})).is_err());
    }
    #[test]fn close_uses_actual_mode_and_requires_a_unique_nonzero_position(){
        let body=json!({"symbol":"btcusdt","pos_side":null});
        let rows=vec![json!({"instId":"BTC-USDT-SWAP","pos":"-3","posSide":"net","mgnMode":"isolated"})];
        let value=close_body(&body,&rows,"uniqueClient1").unwrap();
        assert_eq!(value["mgnMode"],"isolated");assert_eq!(value["posSide"],"net");assert_eq!(value["autoCxl"],false);
        assert!(close_body(&body,&[],"id").is_err());assert!(close_body(&body,&[rows[0].clone(),rows[0].clone()],"id").is_err());
        assert!(close_body(&json!({"symbol":"btcusdt","pos_side":"long"}),&rows,"id").is_err());
    }
    #[test]fn cancellation_keeps_order_kind_and_instrument_explicit(){
        let query=HashMap::from([("symbol".into(),"ethusdt".into())]);
        let (path,body)=cancel_body("/api/live/orders/algo%3A123",&query).unwrap();
        assert!(path.ends_with("cancel-algos"));assert_eq!(body[0]["instId"],"ETH-USDT-SWAP");assert_eq!(body[0]["algoId"],"123");
        assert!(cancel_body("/api/live/orders/123?bad",&query).is_err());assert!(cancel_body("/api/live/orders/123",&HashMap::new()).is_err());
    }
    #[test]fn incomplete_or_wrong_ack_is_never_a_success(){
        let body=json!({"instId":"BTC-USDT-SWAP","clOrdId":"unique"});let path="/api/v5/trade/close-position";
        assert!(!valid_ack(&json!({"code":"0","data":[]}),path,&body));
        assert!(!valid_ack(&json!({"code":"0","data":[{"clOrdId":"other"}]}),path,&body));
        assert!(valid_ack(&json!({"code":"0","data":[{"clOrdId":"unique"}]}),path,&body));
        assert!(valid_ack(&json!({"code":"51000","data":[],"msg":"rejected"}),path,&body));
        assert!(!valid_ack(&json!({"code":"51000","msg":"incomplete"}),path,&body));
        assert!(!valid_ack(&json!({"code":"0","data":[{"clOrdId":"unique","sCode":0}]}),path,&body));
    }
    #[test]fn missing_remote_command_can_only_settle_after_a_new_epoch_fences_it(){
        let mut db=crate::local_store::Store::memory().unwrap();
        let request=json!({"epoch":4,"method":"POST","path":"/api/v5/trade/cancel-order","body":"{}"});
        db.begin_command("a","id","hash",&request).unwrap();let local=db.unresolved_intents("a").unwrap();
        assert!(settle_local(&mut db,"a",&local,&[],4).is_err());assert!(!db.unresolved_intents("a").unwrap().is_empty());
        settle_local(&mut db,"a",&local,&[],5).unwrap();assert!(db.unresolved_intents("a").unwrap().is_empty());
        assert!(matches!(db.begin_command("a","id","hash",&request).unwrap(),Intent::Unknown));
    }
    #[test]fn receipt_check_never_calls_an_unknown_order_successful(){
        let id="clientOrder1";
        let request=json!({"path":"/api/v5/trade/order","body":"{\"instId\":\"BTC-USDT-SWAP\",\"clOrdId\":\"clientOrder1\"}"});
        let mut record=json!({"id":id,"status":"unknown","request":request});
        assert!(receipt_result(id,&record).unwrap().is_none());
        record["status"]=json!("complete");record["raw"]=json!("{\"code\":\"0\",\"data\":[{\"clOrdId\":\"clientOrder1\",\"sCode\":\"0\"}]}");
        assert!(receipt_result(id,&record).unwrap().is_none());
        record["raw"]=json!("{\"code\":\"0\",\"data\":[{\"clOrdId\":\"clientOrder1\",\"ordId\":\"123\",\"sCode\":\"0\"}]}");
        assert_eq!(receipt_result(id,&record).unwrap().unwrap()["state"],"accepted");
        record["status"]=json!("reconciled");
        assert!(receipt_result(id,&record).unwrap().is_none());
        record["request"]["_settlement_proofs"]=json!({"0":{"clOrdId":id,"instId":"BTC-USDT-SWAP","ordId":"123"}});
        assert_eq!(receipt_result(id,&record).unwrap().unwrap()["state"],"reconciled");
        assert!(receipt_result("anotherClient",&record).is_err());
    }
}
