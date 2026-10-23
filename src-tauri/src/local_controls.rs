//! Durable human requests sent to the current owner; never a second executor.
use super::*;
const COLLECTION:&str="manual-controls";
enum Saved{Financial,Queue(Value),Fresh}
enum Receipt{Rejected,Unregistered(u64),Query}
fn old_receipt(saved:&Value,remote:&[Value],id:&str)->Result<Receipt>{
    if remote.is_empty(){return Ok(Receipt::Unregistered(saved["request"]["epoch"].as_u64().ok_or("原指令缺少执行权记录")?))}
    if remote.len()!=1||remote[0]["id"]!=id{return Err("原指令中心记录不符".into())}
    let actual=&remote[0];let request=&saved["request"];
    if ["method","path","body"].iter().any(|k|actual["request"][k]!=request[k]){return Err("原指令内容与中心记录不符".into())}
    if actual["status"]=="complete"{
        let raw:Value=serde_json::from_str(actual["raw"].as_str().ok_or("原始回执丢失")?).map_err(|_|"原始回执损坏")?;
        let body:Value=serde_json::from_str(request["body"].as_str().ok_or("原始指令丢失")?).map_err(|_|"原始指令损坏")?;
        if valid_ack(&raw,request["path"].as_str().ok_or("原始指令丢失")?,&body)
            &&(raw["code"]!="0"||raw["data"][0]["sCode"].as_str().is_some_and(|c|c!="0")){return Ok(Receipt::Rejected)}
    }
    Ok(Receipt::Query)
}
fn fenced_absence(old:u64,new:u64,remote:&[Value])->bool{new>old&&remote.is_empty()}
fn saved(db:&crate::local_store::Store,scope:&str,account:&str,id:&str,input:&Value)->Result<Saved>{
    if let Some(prior)=db.order_command(scope,id)?{
        if prior["namespace"]!=format!("{scope}:commands:{account}"){return Err("原人工请求属于其他账户".into())}
        return Ok(Saved::Financial)
    }
    if let Some(prior)=db.get(scope,COLLECTION,id)?{
        if prior.value["account"]!=account||prior.value["input"]!=*input{return Err("同一人工请求不能修改参数或切换账户".into())}
        return Ok(Saved::Queue(prior.value["wire"].clone()))
    }
    Ok(Saved::Fresh)
}

fn result(value:&Value,id:&str,account:&str)->Result<Value>{
    if value["request_id"]!=id||value["account_id"]!=account{return Err("人工请求核对身份不符".into())}
    let state=value["state"].as_str().ok_or("人工请求状态缺失")?;
    let message=match state{
        "queued"|"prepared"=>"人工请求已保存，当前执行端正在处理；自动任务已暂停，完成后需登录服务器手动启动。",
        "unknown"|"accepted"=>"人工操作待交易所终态核对，保留原始请求编号，不会重复发送。",
        "confirmed"=>"人工操作已通过原始订单和账户状态确认；自动任务仍保持暂停。",
        "rejected"=>"交易所已明确拒绝本次操作，请刷新账户后核对；任务仍暂停。",
        "expired"|"canceled"=>"本次人工请求在发送前已过期或撤销，未执行新的金融操作；任务仍暂停。",
        "needs_review"=>"原平仓订单已终结，但该方向仍有持仓，请刷新核对后重新决定，原指令不会重发。",
        _=>return Err("人工请求状态无效，请保留原始记录".into()),
    };
    Ok(json!({"ok":state=="confirmed","manual_control":true,"state":state,"request_id":id,"message":message}))
}

pub(super) async fn route(app:&tauri::AppHandle,market:&MarketDataState,store:&LocalStoreState,scope:&str,credential:&NativeCredentials,account:&str,owner:&str,route:&str,query:&HashMap<String,String>,body:&Value,id:&str,generation:u64)->Result<Option<Value>>{
    if route!="/api/live/positions/close"&&!route.starts_with("/api/live/orders/"){return Ok(None)}
    // A request that ever formed an independent financial instruction cannot
    // migrate to a different intent namespace merely because an owner appeared.
    let input=json!({"route":route,"query":query,"body":body});
    let previous=store.with(app,|db|saved(db,scope,account,id,&input))?;
    let wire=match previous{
        Saved::Financial=>return Ok(Some(check(app,market,store,scope,credential,id).await?)),
        Saved::Queue(wire)=>wire,
        Saved::Fresh=>{
        let accounts=rows(execution_request(app,market,scope,"/v1/execution/accounts",None).await?)?;
        let Some(status)=accounts.iter().find(|r|r["account_id"]==account) else{return Ok(None)};
        if !matches!(status["role"].as_str(),Some("server"|"desktop"|"standby"))||status["expires_in_ms"].as_i64().unwrap_or(0)<=0{return Ok(None)}
        let Some(task_generation)=status["manual_generation"].as_str() else{return Err("当前自动执行端暂不支持人工队列，请先停止账户任务并核对后操作".into())};
        let symbol=body["symbol"].as_str().or_else(||query.get("symbol").map(String::as_str)).ok_or("人工操作必须选择合约")?;
        let mut wire=json!({"request_id":id,"key_fingerprint":account_identity(&credential.api_key,credential.demo),
            "expected_epoch":status["epoch"],"generation":task_generation,"expires_ms":status["server_time_ms"].as_i64().ok_or("中心时钟缺失")?+45000,"symbol":symbol});
        if route=="/api/live/positions/close"{
            let positions=read(app,market,scope,credential,"/api/v5/account/positions",owner).await?;
            let target=close_body(body,&positions,id)?;
            wire["action"]=json!("close_position");wire["pos_side"]=target["posSide"].clone();wire["margin_mode"]=target["mgnMode"].clone();
            let direction=body["pos_side"].as_str().filter(|s|matches!(*s,"long"|"short")).map(String::from).or_else(||{
                positions.iter().find(|p|p["instId"]==target["instId"]&&p["posSide"]==target["posSide"]).map(|p|{
                    if p["posSide"]=="short"||p["posSide"]=="net"&&num(&p["pos"])<0.0{"short".to_owned()}else{"long".to_owned()}
                })}).ok_or("原始平仓方向未确认")?;
            wire["expected_direction"]=json!(direction);
        }else{
            let (path,target)=cancel_body(route,query)?;
            if path!="/api/v5/trade/cancel-order"{return Err("任务保护单请通过所属任务的结束控制处理，不能排入普通撤单队列".into())}
            wire["action"]=json!("cancel_order");wire["order_id"]=target["ordId"].clone();
        }
        app.state::<crate::execution_runtime::ExecutionRuntime>().check_action(scope,generation)?;
        store.with(app,|db|db.cache(scope,COLLECTION,id,&json!({"account":account,"input":input,"wire":wire})))?;
        wire
        }
    };
    app.state::<crate::execution_runtime::ExecutionRuntime>().check_action(scope,generation)?;
    match execution_request(app,market,scope,"/v1/execution/manual/submit",Some(wire)).await{
        Ok(value)=>Ok(Some(result(&value,id,account)?)),
        Err(error) if error.contains("manual_context_changed")||error.contains("manual_request_expired")=>Ok(Some(json!({"ok":false,"manual_control":true,"request_id":id,"state":"not_sent","message":"账户执行状态或请求期限已变化，本次未受理；请刷新后重新选择。"}))),
        Err(error)=>Err(error),
    }
}

pub(super) async fn check(app:&tauri::AppHandle,market:&MarketDataState,store:&LocalStoreState,scope:&str,credential:&NativeCredentials,id:&str)->Result<Value>{
    if id.len()!=32||!id.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase()){return Err("人工请求编号无效".into())}
    let owner=format!("manual_{}",unique()?);
    let config=read(app,market,scope,credential,"/api/v5/account/config",&owner).await?;
    let account=center_account(config.first().and_then(|r|r["uid"].as_str()).ok_or("交易所账户身份缺失")?,credential.demo)?;
    if let Some(saved)=store.with(app,|db|db.get(scope,COLLECTION,id))?{
        if saved.value["account"]!=account{return Err("原人工请求属于其他账户".into())}
        return result(&execution_request(app,market,scope,"/v1/execution/manual/state",Some(json!({"account_id":account,"request_id":id}))).await?,id,&account)
    }
    let Some(saved)=store.with(app,|db|db.order_command(scope,id))? else{
        return Ok(json!({"manual_control":true,"state":"not_sent","message":"本机未形成该请求的金融指令；本次核对未发送操作。"}))
    };
    if saved["namespace"]!=format!("{scope}:commands:{account}"){return Err("原人工指令属于其他账户".into())}
    let path=format!("/v1/execution/intents?account_id={account}&ids={id}");
    let remote=rows(execution_request(app,market,scope,&path,None).await?)?;
    match old_receipt(&saved,&remote,id)?{
        Receipt::Rejected=>return Ok(json!({"manual_control":true,"state":"rejected","message":"原金融指令已被交易所明确拒绝，本次核对未重新发送。"})),
        Receipt::Unregistered(old)=>{
            let binding=account_identity(&credential.api_key,credential.demo);
            let status=execution_request(app,market,scope,"/v1/execution/account-for-key",Some(json!({"key_fingerprint":binding}))).await?;
            let mut epoch=status["epoch"].as_u64().ok_or("当前执行权记录缺失")?;
            let mut acquired=false;
            if epoch<=old{
                read(app,market,scope,credential,"/api/v5/account/positions",&owner).await?;
                read(app,market,scope,credential,"/api/v5/trade/orders-pending",&owner).await?;
                let lease=execution_request(app,market,scope,"/v1/execution/acquire",Some(claim(&account,&owner,0))).await?;
                epoch=lease["epoch"].as_u64().ok_or("新执行权记录缺失")?;acquired=true;
            }
            let checked=rows(execution_request(app,market,scope,&path,None).await?)?;
            if acquired{let _=execution_request(app,market,scope,"/v1/execution/release",Some(claim(&account,&owner,epoch))).await;}
            if fenced_absence(old,epoch,&checked){
                store.with(app,|db|db.reconcile_intent(&format!("{scope}:commands:{account}"),id))?;
                return Ok(json!({"manual_control":true,"state":"not_sent","message":"中心未登记原指令，且旧执行权已隔离；本次核对没有发送金融操作。"}))
            }
            return Err("原指令仍可能在途，请保留请求并继续核对".into())
        },
        Receipt::Query=>{},
    }
    reconcile_remote(app,market,scope,credential,&account,&owner).await?;
    let request=&saved["request"];let path=request["path"].as_str().ok_or("原指令缺失")?;
    let body:Value=serde_json::from_str(request["body"].as_str().ok_or("原指令缺失")?).map_err(|_|"原指令损坏")?;
    let key=if path=="/api/v5/trade/cancel-order"{"ordId"}else if path=="/api/v5/trade/close-position"{"clOrdId"}else{return Err("原操作需要在所属入口核对".into())};
    let mut params=json!({"instId":body["instId"]});params[key]=body[key].clone();
    let lookup=lookup_path(&json!({"path":"/api/v5/trade/order","params":params}))?;
    let proof=read(app,market,scope,credential,&lookup,&owner).await?;
    if proof.len()!=1||proof[0][key]!=body[key]||proof[0]["instId"]!=body["instId"]||!matches!(proof[0]["state"].as_str(),Some("filled"|"canceled"|"mmp_canceled")){
        return Ok(json!({"manual_control":true,"state":"unknown","message":"原始订单尚无确切终态，继续保留请求，不会重复发送。"}))
    }
    if key=="clOrdId"{
        if proof[0]["posSide"]!=body["posSide"]||proof[0]["tdMode"]!=body["mgnMode"]||proof[0]["ordType"]!="market"{return Err("原平仓订单与请求模式不符，请继续核对".into())}
        let positions=read(app,market,scope,credential,"/api/v5/account/positions",&owner).await?;
        let mut remaining=false;
        for row in positions{
            let quantity=Decimal::from_str(row["pos"].as_str().ok_or("持仓返回不完整")?).map_err(|_|"持仓数量无效")?;
            if row["instId"].as_str().is_none()||!matches!(row["posSide"].as_str(),Some("net"|"long"|"short")){return Err("持仓身份不完整".into())}
            if row["instId"]==body["instId"]&&row["posSide"]==body["posSide"]&&quantity!=Decimal::ZERO{remaining=true;}
        }
        if remaining{return Ok(json!({"manual_control":true,"state":"needs_review","message":"原平仓订单已终结但仍有仓位，请刷新并人工核对。"}))}
    }
    Ok(json!({"manual_control":true,"state":"confirmed","message":"原始撤单或平仓已核对确认，本次没有发送新指令。"}))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn receipt_keeps_pending_separate_from_done_and_checks_binding(){
        let value=json!({"request_id":"id","account_id":"account","state":"accepted"});
        assert_eq!(result(&value,"id","account").unwrap()["ok"],false);
        assert!(result(&value,"id","other").is_err());
        assert!(result(&json!({"request_id":"id","account_id":"account","state":"invented"}),"id","account").is_err());
    }
    #[test]fn an_uncertain_independent_financial_request_wins_over_any_new_queue_route(){
        let mut db=crate::local_store::Store::memory().unwrap();
        let id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";let input=json!({"action":"close_position"});
        db.begin_command("scope:commands:account",id,"hash",&json!({"method":"POST","path":"/api/v5/trade/close-position","body":"{}","epoch":1})).unwrap();
        assert!(matches!(saved(&db,"scope","account",id,&input).unwrap(),Saved::Financial));
        db.cache("scope",COLLECTION,id,&json!({"account":"account","input":input,"wire":{"new":"queue"}})).unwrap();
        assert!(matches!(saved(&db,"scope","account",id,&input).unwrap(),Saved::Financial));
        assert!(saved(&db,"scope","other-account",id,&input).is_err());
    }
    #[test]fn old_receipts_require_explicit_rejection_or_a_newer_epoch_for_absence(){
        let request=json!({"method":"POST","path":"/api/v5/trade/cancel-order","body":"{\"instId\":\"BTC-USDT-SWAP\",\"ordId\":\"123\"}","epoch":4});
        let local=json!({"request":request});
        assert!(matches!(old_receipt(&local,&[],"id").unwrap(),Receipt::Unregistered(4)));
        assert!(!fenced_absence(4,4,&[]));assert!(!fenced_absence(4,5,&[json!({})]));assert!(fenced_absence(4,5,&[]));
        let remote=json!({"id":"id","request":request,"status":"complete","raw":"{\"code\":\"0\",\"data\":[{\"ordId\":\"123\",\"sCode\":\"51400\"}]}"});
        assert!(matches!(old_receipt(&local,&[remote],"id").unwrap(),Receipt::Rejected));
    }
}
