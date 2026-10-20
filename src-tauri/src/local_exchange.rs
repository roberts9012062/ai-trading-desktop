//! Native exchange queries and signing independent of the business server.

use base64::{engine::general_purpose::STANDARD,Engine};
use ring::{digest,hmac};
use rust_decimal::Decimal;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::str::FromStr;
use zeroize::{Zeroize,Zeroizing};
use crate::{local_store::{LocalStoreState,LocalMutation},market_data::MarketDataState};

type Result<T>=std::result::Result<T,String>;
#[path="local_commands.rs"]
mod commands;
fn num(value:&Value)->f64{value.as_f64().or_else(||value.as_str().and_then(|s|s.parse::<f64>().ok())).filter(|n|n.is_finite()).unwrap_or(0.0)}
fn strval(value:&Value)->String{value.as_str().map(str::to_owned).unwrap_or_else(||if value.is_number(){value.to_string()}else{String::new()})}
fn first_number(row:&Value,keys:&[&str])->f64{keys.iter().find_map(|k|{let value=&row[*k];if value.is_null()||value.as_str()==Some(""){None}else{Some(num(value))}}).unwrap_or(0.0)}
pub fn account_identity(key:&str,demo:bool)->String{digest::digest(&digest::SHA256,format!("okx:{demo}:{key}").as_bytes()).as_ref().iter().map(|b|format!("{b:02x}")).collect()}
fn desktop_symbol(inst:&str)->String{inst.strip_suffix("-USDT-SWAP").map(|s|format!("{}usdt",s.to_lowercase())).unwrap_or_else(||inst.to_lowercase())}
fn instrument(symbol:&str)->Result<String>{let symbol=symbol.to_ascii_uppercase();let base=symbol.strip_suffix("-USDT-SWAP").or_else(||symbol.strip_suffix("USDT")).ok_or("只支持 USDT 永续合约")?;if base.is_empty()||base.len()>20||!base.bytes().all(|b|b.is_ascii_alphanumeric()){return Err("无效的永续合约".into())}Ok(format!("{base}-USDT-SWAP"))}
fn iso(ms:&Value)->Value{let ms=num(ms) as i128;if ms<=0{return Value::Null}time::OffsetDateTime::from_unix_timestamp_nanos(ms*1_000_000).ok().and_then(|t|t.format(&time::format_description::well_known::Rfc3339).ok()).map(Value::String).unwrap_or(Value::Null)}
fn account(row:&Value,demo:bool)->Value{
    let usdt=row["details"].as_array().and_then(|rows|rows.iter().find(|r|r["ccy"]=="USDT")).cloned().unwrap_or(Value::Null);
    json!({"equity":num(&row["totalEq"]),"available":first_number(&usdt,&["availEq","availBal"]),"unrealized_pnl":num(&usdt["upl"]),"currency":"USDT","venue":"okx","venue_name":"OKX","demo":demo})
}
fn position(row:&Value,spec:&Value)->Value{
    let contracts=num(&row["pos"]);let ct=num(&spec["ctVal"]);let size=contracts.abs()*ct;
    let direction=match row["posSide"].as_str(){Some("long")=>"long",Some("short")=>"short",_=>if contracts<0.0{"short"}else{"long"}};
    let symbol=desktop_symbol(row["instId"].as_str().unwrap_or(""));
    let available=if row["availPos"].is_null()||row["availPos"]==""{size}else{(num(&row["availPos"]).abs()*ct).min(size)};
    json!({"symbol":symbol,"symbol_name":symbol.to_uppercase(),"direction":direction,"quantity":size,"available_quantity":available,"avg_price":num(&row["avgPx"]),"margin":first_number(row,&["imr","margin"]),"unrealized_pnl":num(&row["upl"]),"mark_price":num(&row["markPx"]),"liquidation_price":num(&row["liqPx"]),"leverage":num(&row["lever"]),"margin_mode":row["mgnMode"],"source":"exchange","raw":row})
}
fn order(row:&Value,spec:&Value)->Value{
    let symbol=desktop_symbol(row["instId"].as_str().unwrap_or(""));let side=row["side"].as_str().unwrap_or("");
    let closing=row["reduceOnly"].as_bool()==Some(true)||row["reduceOnly"]=="true"||matches!((side,row["posSide"].as_str()),("buy",Some("short"))|("sell",Some("long")))||num(&row["pnl"])!=0.0;
    let ct=num(&spec["ctVal"]);let id=strval(&row["ordId"]);
    let attached=row["attachAlgoOrds"].as_array().and_then(|r|r.first()).unwrap_or(&Value::Null);
    let trigger=|key:&str|{let price=if num(&row[key])>0.0{num(&row[key])}else{num(&attached[key])};if price>0.0{json!(price)}else{Value::Null}};
    json!({"id":id,"order_id":id,"exchange_order_id":id,"client_order_id":row["clOrdId"],"symbol":symbol,"symbol_name":symbol.to_uppercase(),"direction":side,"side":side,"offset":if closing{"close"}else{"open"},"order_type":row["ordType"],"price":num(&row["px"]),"avg_price":num(&row["avgPx"]),"quantity":num(&row["sz"])*ct,"filled_qty":num(&row["accFillSz"])*ct,"status":row["state"],"fee":-num(&row["fee"]),"fee_currency":row["feeCcy"],"realized_pnl":num(&row["pnl"]),"created_at":iso(&row["cTime"]),"updated_at":iso(&row["uTime"]),"filled_at":if row["state"]=="filled"{iso(&row["uTime"])}else{Value::Null},"leverage":num(&row["lever"]),"margin_mode":row["tdMode"],"tp_price":trigger("tpTriggerPx"),"sl_price":trigger("slTriggerPx"),"order_kind":"regular","source":"exchange","raw":row})
}
fn with_fills(mut order:Value,fills:&[Value],spec:&Value)->Value{
    let id=order["exchange_order_id"].as_str().unwrap_or("");let rows:Vec<_>=fills.iter().filter(|r|r["ordId"].as_str()==Some(id)).collect();
    order["fills_complete"]=json!(false);
    if rows.is_empty(){return order}
    let size:f64=rows.iter().map(|r|num(&r["fillSz"])).sum();let cost:f64=rows.iter().map(|r|num(&r["fillSz"])*num(&r["fillPx"])).sum();
    // A page containing only the newest fills cannot replace whole-order totals.
    let total=num(&order["raw"]["accFillSz"]);
    if size<=0.0||(size-total).abs()>1e-9*total.max(1.0){return order}
    order["fills_complete"]=json!(true);
    order["filled_qty"]=json!(size*num(&spec["ctVal"]));if size>0.0{order["avg_price"]=json!(cost/size)}
    order["fee"]=json!(-rows.iter().map(|r|num(&r["fee"])).sum::<f64>());order["realized_pnl"]=json!(rows.iter().map(|r|num(&r["fillPnl"])).sum::<f64>());order
}
fn bill(row:&Value)->Value{json!({"ts_ms":num(&row["ts"]) as i64,"symbol":desktop_symbol(row["instId"].as_str().unwrap_or("")),"type":strval(&row["type"]),"sub_type":strval(&row["subType"]),"amount":num(&row["balChg"]),"fee":num(&row["fee"]),"pnl":num(&row["pnl"]),"notes":strval(&row["notes"])})}
fn fee(row:&Value,symbol:&str)->Value{let inst=row["instId"].as_str().unwrap_or("");json!({"symbol":if inst.is_empty(){symbol.into()}else{desktop_symbol(inst)},"maker":num(&row["maker"])*100.0,"taker":num(&row["taker"])*100.0})}
fn fill_id(row:&Value)->Result<String>{let inst=row["instId"].as_str().ok_or("成交合约缺失")?;let trade=strval(&row["tradeId"]);if inst.is_empty()||trade.is_empty(){return Err("成交编号缺失".into())}Ok(format!("{inst}:{trade}"))}
fn contract_size(quantity:&str,spec:&Value)->Result<String>{
    let value=|text:&str|Decimal::from_str(text).map_err(|_|"无效的委托数量".to_owned());
    let qty=value(quantity)?;let ct=value(&strval(&spec["ctVal"]))?;let step=value(&strval(&spec["lotSz"]))?;let min=value(&strval(&spec["minSz"]))?;
    if qty<=Decimal::ZERO||ct<=Decimal::ZERO||step<=Decimal::ZERO||min<=Decimal::ZERO{return Err("数量或合约规格无效".into())}
    let contracts=qty.checked_div(ct).and_then(|v|v.checked_div(step)).map(|v|v.floor()).and_then(|v|v.checked_mul(step)).ok_or("委托数量超出范围")?;
    if contracts<min{return Err("委托数量低于交易所最小数量".into())}Ok(contracts.normalize().to_string())
}

#[derive(Clone,Serialize,Deserialize)]
pub struct NativeCredentials{pub api_key:String,pub secret:String,pub passphrase:String,pub demo:bool,#[serde(default)]pub label:String,#[serde(default)]pub updated_at:String,#[serde(default)]pub server_bound:bool}
fn preserves_server_binding(old:&NativeCredentials,next:&NativeCredentials)->bool{
    old.server_bound && old.api_key==next.api_key && old.secret==next.secret && old.passphrase==next.passphrase && old.demo==next.demo
}
impl Drop for NativeCredentials{fn drop(&mut self){self.api_key.zeroize();self.secret.zeroize();self.passphrase.zeroize()}}
pub fn credentials(app:&tauri::AppHandle,store:&LocalStoreState,scope:&str)->Result<Option<NativeCredentials>>{
    let blob=store.with(app,|db|db.secret(scope,"okx-credentials"))?;
    blob.map(|blob|{let plain=Zeroizing::new(crate::market_data::protect(&blob,format!("local-okx:{scope}").as_bytes(),false)?);serde_json::from_slice(&plain).map_err(|_|"本机 OKX 凭证已损坏，请重新保存".into())}).transpose()
}
fn validate_credentials(credential:&NativeCredentials)->Result<()>{
    if credential.api_key.is_empty()||credential.secret.is_empty()||credential.passphrase.is_empty()||credential.api_key.len()>200||credential.secret.len()>500||credential.passphrase.len()>200{return Err("请填写完整有效的 OKX API Key、Secret 和 Passphrase".into())}
    Ok(())
}
fn save_credentials(app:&tauri::AppHandle,store:&LocalStoreState,scope:&str,credential:&NativeCredentials)->Result<()>{
    validate_credentials(credential)?;
    let plain=Zeroizing::new(serde_json::to_vec(credential).map_err(|_|"凭证编码失败")?);let sealed=crate::market_data::protect(&plain,format!("local-okx:{scope}").as_bytes(),true)?;
    store.with(app,|db|db.save_secret(scope,"okx-credentials",&sealed))
}
fn signed(credential:&NativeCredentials,method:&str,path:&str,body:&str)->Result<Value>{
    let timestamp=time::OffsetDateTime::now_utc().format(&time::format_description::parse_borrowed::<2>("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z").map_err(|_|"时间格式错误")?).map_err(|_|"系统时间错误")?;
    let signature=STANDARD.encode(hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256,credential.secret.as_bytes()),format!("{timestamp}{method}{path}{body}").as_bytes()).as_ref());
    let (route,query)=path.split_once('?').unwrap_or((path,""));
    Ok(json!({"method":method,"path":route,"query":query,"body":body,"access_key":credential.api_key,"signature":signature,"timestamp":timestamp,"passphrase":credential.passphrase,"simulated":credential.demo}))
}
pub async fn private_read(app:&tauri::AppHandle,market:&MarketDataState,scope:&str,credential:&NativeCredentials,path:&str)->Result<Vec<Value>>{
    let result=crate::market_data::private_request(app,market,scope,||signed(credential,"GET",path,"")).await?;
    if result["code"]!="0"{return Err(format!("API VALUE COLLECTION 查询失败：{} (code={})",result["msg"].as_str().unwrap_or("交易所拒绝请求"),result["code"]))}
    result["data"].as_array().cloned().ok_or("交易所数据格式异常".into())
}
fn account_scope(scope:&str,credential:&NativeCredentials)->String{format!("{scope}:{}",account_identity(&credential.api_key,credential.demo))}
async fn spec(app:&tauri::AppHandle,market:&MarketDataState,store:&LocalStoreState,scope:&str,credential:&NativeCredentials,id:&str)->Result<Value>{
    let id=instrument(id)?;let namespace=account_scope(scope,credential);
    if let Some(record)=store.with(app,|db|db.get(&namespace,"instruments",&id))?{if time::OffsetDateTime::now_utc().unix_timestamp()-record.updated_at<86400{return Ok(record.value)}}
    // One cold read warms the USDT universe instead of querying a separately
    // paced instrument endpoint for every historical order/symbol.
    let rows=private_read(app,market,scope,credential,"/api/v5/public/instruments?instType=SWAP").await?;
    let records=instrument_records(rows)?;
    let row=records.iter().find(|row|row.id==id).map(|row|row.value.clone()).ok_or("交易所未返回有效合约规格")?;
    store.with(app,|db|db.cache_batch(&namespace,"instruments",&records))?;Ok(row)
}

fn instrument_records(rows:Vec<Value>)->Result<Vec<LocalMutation>>{
    let records:Vec<_>=rows.into_iter().filter(|row|row["instId"].as_str().map(|id|id.ends_with("-USDT-SWAP")).unwrap_or(false))
        .map(|row|{
            let id=instrument(row["instId"].as_str().ok_or("合约规格缺少编号")?)?;
            if num(&row["ctVal"])<=0.0||num(&row["lotSz"])<=0.0{return Err("交易所合约规格不完整".into())}
            Ok(LocalMutation{id,value:row,deleted:false})
        }).collect::<Result<Vec<_>>>()?;
    if records.len()>1000{return Err("合约规格数量超出单次缓存范围".into())}Ok(records)
}

fn masked(key:&str)->String{let chars:Vec<char>=key.chars().collect();if chars.len()<9{"********".into()}else{format!("{}****{}",chars[..4].iter().collect::<String>(),chars[chars.len()-4..].iter().collect::<String>())}}
fn timestamp()->String{time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()}
fn metadata(credential:&NativeCredentials)->Value{json!({"venue":"okx","api_key_masked":masked(&credential.api_key),"demo":credential.demo,"label":credential.label,"status":"active","updated_at":if credential.updated_at.is_empty(){Value::Null}else{json!(credential.updated_at)},"last_checked_at":Value::Null,"last_check_ok":Value::Null,"last_error":"","storage":"local","account_binding":if credential.server_bound{json!(account_identity(&credential.api_key,credential.demo))}else{Value::Null}})}
fn params(path:&str)->Result<(String,std::collections::HashMap<String,String>)>{
    if !path.starts_with("/api/live/")||path.len()>4096||path.contains(['#','\\']){return Err("不支持的本机交易接口".into())}
    let url=reqwest::Url::parse(&format!("https://desktop.invalid{path}")).map_err(|_|"无效查询地址")?;
    Ok((url.path().into(),url.query_pairs().into_owned().collect()))
}
fn ws_proof(credential:&NativeCredentials)->Value{
    let timestamp=time::OffsetDateTime::now_utc().unix_timestamp().to_string();
    let sign=STANDARD.encode(hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256,credential.secret.as_bytes()),format!("{timestamp}GET/users/self/verify").as_bytes()).as_ref());
    json!({"demo":credential.demo,"expires_in":15,"args":[{"apiKey":credential.api_key,"passphrase":credential.passphrase,"timestamp":timestamp,"sign":sign}]})
}
fn permission(app:&tauri::AppHandle,store:&LocalStoreState,scope:&str)->Result<Value>{
    let sealed=store.with(app,|db|db.secret(scope,"server-permission"))?;
    if let Some(sealed)=sealed{let raw=Zeroizing::new(crate::market_data::protect(&sealed,format!("local-permission:{scope}").as_bytes(),false)?);return serde_json::from_slice(&raw).map_err(|_|"本地授权状态损坏".into())}
    Ok(json!({"enabled":false,"message":"尚未同步实盘授权，请连接服务器后同步；模拟账户可在本机配置"}))
}

fn validate_import_subject(scope:&str,subject:Option<&str>)->Result<()>{
    if subject.is_none()||subject==Some("")||scope.rsplit_once(':').map(|(_,user)|user)!=subject{return Err("服务器凭证所属账号不匹配，本机账户未更改".into())}Ok(())
}

#[tauri::command]
pub async fn desktop_credential_import(app:tauri::AppHandle,store:tauri::State<'_,LocalStoreState>,scope:String,base:String,token:String)->Result<Value>{
    use ring::{agreement,rand};
    let base=crate::okx_analytics::server_base(&base)?;
    if !scope.starts_with(&(base.clone()+":"))||token.is_empty(){return Err("账号或服务器已切换，请重新同步".into())}
    let client=reqwest::Client::builder().https_only(true).redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(12)).build().map_err(|_|"同步连接初始化失败")?;
    let private=agreement::EphemeralPrivateKey::generate(&agreement::X25519,&rand::SystemRandom::new()).map_err(|_|"本机同步密钥生成失败")?;
    let public=private.compute_public_key().map_err(|_|"本机同步密钥生成失败")?;
    let response=client.post(format!("{base}/api/live/desktop-read-credentials")).bearer_auth(&token).json(&json!({"public_key":STANDARD.encode(public.as_ref())})).send().await.map_err(|_|"服务器暂时无法连接，本机数据已保留")?;
    if response.status().as_u16()==401{return Err("服务器登录已过期，请重新登录后同步，本机账户未更改".into())}
    if !response.status().is_success()&&response.status().as_u16()!=404{return Err(format!("服务器凭证同步失败 ({})，本机账户未更改",response.status().as_u16()))}
    if response.headers().get("X-Desktop-Account-Binding").and_then(|value|value.to_str().ok())!=Some("v1"){return Err("服务器尚未支持本机账户校验，请升级服务器后再同步".into())}
    if response.status().as_u16()==404{crate::execution_runtime::invalidate_account(&app,&scope);store.with(&app,|db|db.remove_secret(&scope,"okx-credentials"))?;crate::execution_runtime::invalidate_account(&app,&scope);return Ok(json!({"imported":false,"reason":"服务器尚未配置 OKX 凭证，本机账户副本已清除"}))}
    if !response.status().is_success(){return Err(format!("服务器凭证同步失败 ({})",response.status().as_u16()))}
    let envelope:crate::okx_analytics::Envelope=response.json().await.map_err(|_|"同步凭证格式异常")?;
    let credential=crate::okx_analytics::decrypt_envelope(private,public.as_ref(),envelope)?;
    validate_import_subject(&scope,credential.subject.as_deref())?;
    let local=NativeCredentials{api_key:credential.api_key.clone(),secret:credential.secret.clone(),passphrase:credential.passphrase.clone(),demo:credential.demo,label:"服务器同步".into(),updated_at:timestamp(),server_bound:true};
    validate_credentials(&local)?;
    let response=client.get(format!("{base}/api/live/permission")).bearer_auth(&token).send().await.map_err(|_|"服务器授权状态尚未同步，本机账户未更改")?;
    if !response.status().is_success(){return Err("服务器未返回有效授权状态，本机账户未更改".into())}
    let grant:Value=response.json().await.map_err(|_|"服务器授权状态格式异常")?;
    if !grant["enabled"].is_boolean(){return Err("服务器授权状态不完整".into())}
    let raw=Zeroizing::new(serde_json::to_vec(&grant).map_err(|_|"授权编码失败")?);let sealed=crate::market_data::protect(&raw,format!("local-permission:{scope}").as_bytes(),true)?;
    let plain=Zeroizing::new(serde_json::to_vec(&local).map_err(|_|"凭证编码失败")?);
    let credential_sealed=crate::market_data::protect(&plain,format!("local-okx:{scope}").as_bytes(),true)?;
    // The credential snapshot and its permission commit atomically. A failed
    // handshake must not activate half an import or overwrite the old account.
    crate::execution_runtime::invalidate_account(&app,&scope);
    store.with(&app,|db|db.save_secrets(&scope,&[("okx-credentials",&credential_sealed),("server-permission",&sealed)]))?;
    // Fence again after commit: a concurrent context handshake may have read
    // the old credential while this write waited on the SQLite mutex.
    crate::execution_runtime::invalidate_account(&app,&scope);
    Ok(json!({"imported":true,"credential":metadata(&local),"permission":grant}))
}

#[tauri::command]
pub async fn desktop_local_exchange(app:tauri::AppHandle,store:tauri::State<'_,LocalStoreState>,market:tauri::State<'_,MarketDataState>,scope:String,path:String,method:String,body:Option<Value>,expected_binding:Option<String>)->Result<Value>{
    let (route,query)=params(&path)?;let body=body.unwrap_or_else(||json!({}));
    if query.get("venue").map(|v|v!="okx").unwrap_or(false)||body["venue"].as_str().map(|v|v!="okx").unwrap_or(false){return Err("API VALUE COLLECTION 本机账户仅支持 OKX".into())}
    if route=="/api/live/permission"&&method=="GET"{return permission(&app,&store,&scope)}
    if route=="/api/live/credentials"{
        if method=="GET"{return Ok(json!({"credentials":credentials(&app,&store,&scope)?.as_ref().map(|c|vec![metadata(c)]).unwrap_or_default()}))}
        if method=="PUT"{
            let old=credentials(&app,&store,&scope)?;let key=body["api_key"].as_str().unwrap_or("").trim();
            if key.is_empty(){return Err("请填写 OKX API Key".into())}
            let old=old.as_ref().filter(|c|c.api_key==key&&c.demo==body["demo"].as_bool().unwrap_or(false));
            let field=|name:&str,previous:Option<&String>|{let value=body[name].as_str().unwrap_or("").trim();if value.is_empty(){previous.cloned().unwrap_or_default()}else{value.into()}};
            let mut local=NativeCredentials{api_key:key.into(),secret:field("secret",old.map(|c|&c.secret)),passphrase:field("passphrase",old.map(|c|&c.passphrase)),demo:body["demo"].as_bool().unwrap_or(false),label:body["label"].as_str().unwrap_or("").into(),updated_at:timestamp(),server_bound:false};
            local.server_bound=old.is_some_and(|previous|preserves_server_binding(previous,&local));
            if !local.demo&&permission(&app,&store,&scope)?["enabled"]!=true{return Err("实盘账户需先同步服务器授权".into())}
            crate::execution_runtime::invalidate_account(&app,&scope);
            save_credentials(&app,&store,&scope,&local)?;crate::execution_runtime::invalidate_account(&app,&scope);return Ok(json!({"ok":true,"storage":"local"}))
        }
    }
    if route=="/api/live/credentials/okx"&&method=="DELETE"{crate::execution_runtime::invalidate_account(&app,&scope);store.with(&app,|db|db.remove_secret(&scope,"okx-credentials"))?;crate::execution_runtime::invalidate_account(&app,&scope);return Ok(json!({"ok":true}))}
    let credential=credentials(&app,&store,&scope)?.ok_or("请先在本机保存 OKX 凭证，或点击同步服务器导入")?;
    if let Some(expected)=expected_binding.as_ref(){if !credential.server_bound||*expected!=account_identity(&credential.api_key,credential.demo){return Err("本机交易账户已变化，请重新读取账户后操作".into())}}
    let namespace=account_scope(&scope,&credential);
    if route=="/api/live/desktop-ws-login"&&method=="POST"{return Ok(ws_proof(&credential))}
    if method=="GET"&&route=="/api/live/local-order"||method=="POST"&&matches!(route.as_str(),"/api/live/orders"|"/api/live/positions/close"|"/api/live/local-execution/confirm-flat")||method=="DELETE"&&route.starts_with("/api/live/orders/"){
        if expected_binding.is_none(){return Err("本机交易操作缺少账户绑定校验".into())}
        return commands::execute(&app,&market,&store,&scope,&credential,&route,&query,&body).await
    }
    if method!="GET"{return Err("本机交易执行通道尚未就绪".into())}
    match route.as_str(){
        "/api/live/account"=>{
            let rows=private_read(&app,&market,&scope,&credential,"/api/v5/account/balance?ccy=USDT").await?;
            let value=account(rows.first().ok_or("交易所未返回账户余额")?,credential.demo);
            store.with(&app,|db|db.cache(&namespace,"exchange_account","current",&value))?;Ok(value)
        },
        "/api/live/positions"=>{
            let rows=private_read(&app,&market,&scope,&credential,"/api/v5/account/positions?instType=SWAP").await?;let mut positions=Vec::new();
            for row in rows{if num(&row["pos"])==0.0{continue}let spec=spec(&app,&market,&store,&scope,&credential,row["instId"].as_str().ok_or("持仓合约缺失")?).await?;positions.push(position(&row,&spec));}
            let value=json!({"positions":positions});store.with(&app,|db|db.cache(&namespace,"exchange_positions","current",&value))?;Ok(value)
        },
        "/api/live/orders"=>{
            let history=query.get("history").map(|s|s=="true").unwrap_or(false);
            let cursor=query.get("cursor").map(String::as_str).unwrap_or("");
            let page=order_page(history,cursor)?;
            let endpoint=if history{"orders-history-archive"}else if page.algo.is_some(){"orders-algo-pending"}else{"orders-pending"};
            let after=if page.after.is_empty(){String::new()}else{format!("&after={}",page.after)};
            let kind=page.algo.map(|index|format!("&ordType={}",ALGO_TYPES[index])).unwrap_or_default();
            let rows=private_read(&app,&market,&scope,&credential,&format!("/api/v5/trade/{endpoint}?instType=SWAP&limit=100{after}{kind}")).await?;
            let next=next_order_page(&page,history,&rows)?;
            let fills=if history&&cursor.is_empty(){private_read(&app,&market,&scope,&credential,"/api/v5/trade/fills-history?instType=SWAP&limit=100").await?}else{Vec::new()};
            let mut orders=Vec::new();
            for row in &rows{
                let spec=spec(&app,&market,&store,&scope,&credential,row["instId"].as_str().ok_or("订单合约缺失")?).await?;
                let value=if page.algo.is_some(){algo_order(row,&spec)?}else{with_fills(order(row,&spec),&fills,&spec)};
                if value["id"].as_str().unwrap_or("").is_empty(){return Err("委托编号缺失".into())}orders.push(value);
            }
            let order_records:Vec<_>=orders.iter().map(|row|LocalMutation{id:strval(&row["id"]),value:row.clone(),deleted:false}).collect();
            store.with(&app,|db|db.cache_batch(&namespace,"exchange_orders",&order_records))?;
            let fill_records:Vec<_>=fills.into_iter().map(|row|Ok(LocalMutation{id:fill_id(&row)?,value:row,deleted:false})).collect::<Result<Vec<_>>>()?;
            store.with(&app,|db|db.cache_batch(&namespace,"exchange_fills",&fill_records))?;
            Ok(json!({"orders":orders,"has_more":next.is_some(),"cursor":next,"source":"api-collection-local"}))
        },
        "/api/live/bills"=>{let limit=query.get("limit").and_then(|value|value.parse::<usize>().ok()).unwrap_or(50).clamp(1,100);let rows=private_read(&app,&market,&scope,&credential,&format!("/api/v5/account/bills?instType=SWAP&limit={limit}")).await?;for row in &rows{let id=strval(&row["billId"]);if !id.is_empty(){store.with(&app,|db|db.cache(&namespace,"exchange_bills",&id,row))?;}}Ok(json!({"bills":rows.iter().map(bill).collect::<Vec<_>>()}))},
        "/api/live/account-mode"=>{let rows=private_read(&app,&market,&scope,&credential,"/api/v5/account/config").await?;let level=rows.first().map(|r|r["acctLv"].clone()).unwrap_or(Value::Null);Ok(json!({"supported":true,"acct_lv":level,"label":format!("账户档位 {}",level.as_str().unwrap_or("未知")),"can_trade_contract":level!="1"}))},
        "/api/live/fee-rates"=>{let symbol=query.get("symbol").map(String::as_str).unwrap_or("");if !symbol.is_empty(){instrument(symbol)?;}let rows=private_read(&app,&market,&scope,&credential,"/api/v5/account/trade-fee?instType=SWAP").await?;let rates:Vec<_>=rows.iter().map(|row|fee(row,symbol)).filter(|row|symbol.is_empty()||row["symbol"]==symbol).collect();Ok(json!({"rates":rates}))},
        _=>Err("不支持的本机交易查询".into())
    }
}

fn algo_order(row:&Value,spec:&Value)->Result<Value>{
    let id=strval(&row["algoId"]);if id.is_empty(){return Err("策略委托编号缺失".into())}
    let mut value=order(row,spec);
    value["id"]=json!(format!("algo:{id}"));value["order_id"]=json!(id);value["algo_id"]=row["algoId"].clone();value["order_kind"]=json!("algo");
    value["price"]=json!(num(&row["orderPx"]));value["trigger_price"]=json!(first_number(row,&["triggerPx","slTriggerPx","tpTriggerPx"]));
    value["close_fraction"]=json!(num(&row["closeFraction"]));if num(&row["closeFraction"])>0.0{value["offset"]=json!("close")}
    value["can_cancel"]=json!(true);value["can_amend"]=json!(false);
    if value["status"].as_str().unwrap_or("").is_empty(){value["status"]=json!("live")}Ok(value)
}

const ALGO_TYPES:[&str;8]=["trigger","conditional","oco","move_order_stop","iceberg","twap","chase","smart_iceberg"];
struct OrderPage{algo:Option<usize>,after:String}
fn numeric_cursor(value:&str)->bool{!value.is_empty()&&value.len()<=100&&value.bytes().all(|b|b.is_ascii_digit())}
fn order_page(history:bool,cursor:&str)->Result<OrderPage>{
    if cursor.is_empty()||numeric_cursor(cursor){return Ok(OrderPage{algo:None,after:cursor.into()})}
    if !history{
        if let Some(after)=cursor.strip_prefix("r:"){if numeric_cursor(after){return Ok(OrderPage{algo:None,after:after.into()})}}
        let parts:Vec<_>=cursor.split(':').collect();
        if parts.len()==3&&parts[0]=="a"&&parts[1].len()==1&&(parts[2].is_empty()||numeric_cursor(parts[2])){
            if let Ok(index)=parts[1].parse::<usize>(){if index<ALGO_TYPES.len(){return Ok(OrderPage{algo:Some(index),after:parts[2].into()})}}
        }
    }
    Err("无效的委托分页游标".into())
}
fn next_order_page(page:&OrderPage,history:bool,rows:&[Value])->Result<Option<String>>{
    if rows.len()>100{return Err("交易所委托分页数量无效".into())}
    if rows.len()==100{
        let id=strval(&rows[99][if page.algo.is_some(){"algoId"}else{"ordId"}]);
        if !numeric_cursor(&id)||id==page.after{return Err("交易所委托分页未前进".into())}
        return Ok(Some(if history{id}else if let Some(index)=page.algo{format!("a:{index}:{id}")}else{format!("r:{id}")}))
    }
    if history{return Ok(None)}
    let index=page.algo.map(|index|index+1).unwrap_or(0);
    Ok(if index<ALGO_TYPES.len(){Some(format!("a:{index}:"))}else{None})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_secret_edits_cannot_inherit_the_servers_credential_binding(){
        let make=||NativeCredentials{api_key:"test-key".into(),secret:"test-secret".into(),passphrase:"test-passphrase".into(),demo:true,label:String::new(),updated_at:String::new(),server_bound:true};
        let old=make();let mut next=make();next.label="new label".into();
        assert!(preserves_server_binding(&old,&next));
        next.secret="local-only-secret".into();assert!(!preserves_server_binding(&old,&next));
        next=make();next.passphrase="local-only-passphrase".into();assert!(!preserves_server_binding(&old,&next));
        next=make();next.demo=false;assert!(!preserves_server_binding(&old,&next));
        next=make();next.api_key="another-key".into();assert!(!preserves_server_binding(&old,&next));
        let mut unbound=make();unbound.server_bound=false;assert!(!preserves_server_binding(&unbound,&make()));
    }
    use serde_json::json;

    #[test]
    fn converts_contracts_to_base_quantity_and_does_not_drop_zero_balances(){
        let spec=json!({"instId":"BTC-USDT-SWAP","ctVal":"0.01","lotSz":"0.1","minSz":"0.1","tickSz":"0.1"});
        let row=json!({"instId":"BTC-USDT-SWAP","pos":"-12.5","posSide":"net","avgPx":"100","markPx":"102","upl":"-0.25","imr":"2","lever":"10","mgnMode":"cross"});
        let position=position(&row,&spec);
        assert_eq!(position["quantity"],0.125);assert_eq!(position["direction"],"short");
        assert_eq!(position["source"],"exchange");
        let balance=account(&json!({"totalEq":"12","details":[{"ccy":"USDT","availEq":"0","availBal":"50","upl":"-2"}]}),true);
        assert_eq!(balance["available"],0.0);assert_eq!(balance["demo"],true);
    }
    #[test]
    fn normalizes_history_and_aggregates_partial_fills_with_fee_rebates(){
        let spec=json!({"ctVal":"0.01"});
        let raw=json!({"ordId":"123","instId":"BTC-USDT-SWAP","side":"buy","posSide":"short","sz":"20","accFillSz":"20","avgPx":"100","state":"filled","fee":"0.1","pnl":"2","cTime":"1792300000000","uTime":"1792300001000"});
        let order=order(&raw,&spec);
        assert_eq!(order["offset"],"close");assert_eq!(order["quantity"],0.2);assert_eq!(order["fee"],-0.1);
        let fills=vec![json!({"ordId":"123","fillSz":"5","fillPx":"90","fee":"-0.01","fillPnl":"1","ts":"1792300000000"}),json!({"ordId":"123","fillSz":"15","fillPx":"110","fee":"0.02","fillPnl":"2","ts":"1792300001000"})];
        let filled=with_fills(order,&fills,&spec);
        assert_eq!(filled["filled_qty"],0.2);assert_eq!(filled["avg_price"],105.0);assert_eq!(filled["fee"],-0.01);assert_eq!(filled["realized_pnl"],3.0);
    }
    #[test]
    fn quantizes_contract_sizes_with_decimal_math_and_rejects_under_minimum(){
        let spec=json!({"ctVal":"0.01","lotSz":"0.1","minSz":"0.2"});
        assert_eq!(contract_size("0.125",&spec).unwrap(),"12.5");
        assert!(contract_size("0.001",&spec).is_err());
        assert!(contract_size("NaN",&spec).is_err());
        assert!(contract_size("-1",&spec).is_err());
    }
    #[test]
    fn account_cache_identity_includes_both_access_key_and_environment(){
        assert_eq!(account_identity("example",true),"0462976e044eea2d15e62d468f096becac3b6fc3011ec86ec75b226a319d4995");
        assert_ne!(account_identity("key-one",false),account_identity("key-one",true));
        assert_ne!(account_identity("key-one",false),account_identity("key-two",false));
        assert!(!account_identity("key-one",false).contains("key-one"));
    }

    #[test]
    fn encrypted_import_must_match_the_authenticated_vault_owner(){
        assert!(validate_import_subject("https://server:8443:user-a",Some("user-a")).is_ok());
        assert!(validate_import_subject("https://server:user-a",Some("user-b")).is_err());
        assert!(validate_import_subject("https://server:user-a",None).is_err());
        assert!(validate_import_subject("https://server:",Some("")).is_err());
    }

    #[test]
    fn pending_order_pagination_includes_every_algo_stage_and_rejects_loops(){
        let first=order_page(false,"").unwrap();
        assert_eq!(next_order_page(&first,false,&[]).unwrap().unwrap(),"a:0:");
        for index in 0..ALGO_TYPES.len(){
            let page=order_page(false,&format!("a:{index}:")).unwrap();
            assert_eq!(page.algo,Some(index));
            let next=next_order_page(&page,false,&[]).unwrap();
            assert_eq!(next,if index==7{None}else{Some(format!("a:{}:",index+1))});
        }
        let full=vec![json!({"algoId":"100"});100];
        let page=order_page(false,"a:2:").unwrap();
        assert_eq!(next_order_page(&page,false,&full).unwrap().unwrap(),"a:2:100");
        assert!(next_order_page(&order_page(false,"a:2:100").unwrap(),false,&full).is_err());
        assert!(order_page(true,"a:0:").is_err());
        assert!(order_page(false,"a:8:").is_err());
        assert!(order_page(false,"r:abc").is_err());
        assert!(next_order_page(&first,true,&[]).unwrap().is_none());
    }

    #[test]
    fn native_algo_orders_distinguish_new_entries_from_full_position_exits(){
        let spec=json!({"ctVal":"0.01"});
        let row=json!({"algoId":"900","instId":"BTC-USDT-SWAP","side":"buy","posSide":"long","ordType":"twap","sz":"10"});
        let open=algo_order(&row,&spec).unwrap();
        assert_eq!(open["offset"],"open");assert_eq!(open["quantity"],0.1);
        let mut exit=row.clone();exit["closeFraction"]=json!("1");
        let close=algo_order(&exit,&spec).unwrap();
        assert_eq!(close["offset"],"close");assert_eq!(close["close_fraction"],1.0);
    }

    #[test]
    fn instrument_warmup_retains_only_valid_usdt_contracts(){
        let spec=|id:&str|json!({"instId":id,"ctVal":"0.01","lotSz":"1"});
        let rows=instrument_records(vec![spec("BTC-USDT-SWAP"),spec("ETH-USDT-SWAP"),spec("BTC-USD-SWAP")]).unwrap();
        assert_eq!(rows.len(),2);
        assert_eq!(rows[1].id,"ETH-USDT-SWAP");
        assert!(instrument_records(vec![json!({"instId":"ETH-USDT-SWAP","ctVal":"0","lotSz":"1"})]).is_err());
    }

    #[test]
    fn incomplete_fill_pages_do_not_replace_order_totals(){
        let spec=json!({"ctVal":"0.01"});
        let raw=json!({"ordId":"123","instId":"BTC-USDT-SWAP","sz":"20","accFillSz":"20","avgPx":"100","fee":"-0.05","pnl":"2"});
        let fills=vec![json!({"ordId":"123","fillSz":"5","fillPx":"90","fee":"-0.01","fillPnl":"1"})];
        let result=with_fills(order(&raw,&spec),&fills,&spec);
        assert_eq!(result["filled_qty"],0.2);assert_eq!(result["avg_price"],100.0);
        assert_eq!(result["fee"],0.05);assert_eq!(result["realized_pnl"],2.0);
        assert_eq!(result["fills_complete"],false);
    }

    #[test]
    fn available_position_uses_contract_availability_not_frozen_currency(){
        let spec=json!({"ctVal":"0.01"});
        let row=json!({"instId":"BTC-USDT-SWAP","pos":"-20","posSide":"net","availPos":"0","frozenBal":"999"});
        assert_eq!(position(&row,&spec)["available_quantity"],0.0);
        let row=json!({"instId":"BTC-USDT-SWAP","pos":"-20","posSide":"net","availPos":"-5","frozenBal":"999"});
        assert_eq!(position(&row,&spec)["available_quantity"],0.05);
        let row=json!({"instId":"BTC-USDT-SWAP","pos":"20","frozenBal":"999"});
        assert_eq!(position(&row,&spec)["available_quantity"],0.2);
    }

    #[test]
    fn masking_does_not_panic_on_non_ascii_input(){
        assert_eq!(masked("测试密钥测试密钥ABCD"),"测试密钥****ABCD");
    }

    #[test]
    fn fill_cache_never_overwrites_another_instrument_with_the_same_trade_id(){
        assert_ne!(fill_id(&json!({"instId":"BTC-USDT-SWAP","tradeId":"42"})).unwrap(),fill_id(&json!({"instId":"ETH-USDT-SWAP","tradeId":"42"})).unwrap());
        assert!(fill_id(&json!({"tradeId":"42"})).is_err());
    }

    #[test]
    fn bills_and_fee_rates_use_the_existing_desktop_field_and_percentage_contract(){
        let normalized=bill(&json!({"ts":"1792300001000","instId":"ETH-USDT-SWAP","type":"8","subType":"173","balChg":"-1.2","fee":"0.01","pnl":"-1.21"}));
        assert_eq!(normalized["ts_ms"],1792300001000_i64);assert_eq!(normalized["symbol"],"ethusdt");
        assert_eq!(normalized["sub_type"],"173");assert_eq!(normalized["amount"],-1.2);assert_eq!(normalized["fee"],0.01);
        let rate=fee(&json!({"maker":"-0.0002","taker":"-0.0005"}),"ethusdt");
        assert_eq!(rate["symbol"],"ethusdt");assert_eq!(rate["maker"],-0.02);assert_eq!(rate["taker"],-0.05);
    }

    #[test]
    fn rereading_credentials_does_not_invent_a_new_sync_version(){
        let credential=NativeCredentials{api_key:"key-123456789".into(),secret:"sample".into(),passphrase:"sample".into(),demo:true,label:"test".into(),updated_at:"2026-10-19T00:00:00Z".into(),server_bound:false};
        assert_eq!(metadata(&credential)["updated_at"],"2026-10-19T00:00:00Z");
        assert_eq!(metadata(&credential),metadata(&credential));
    }
}
