//! Fixed official OKX endpoints. Financial writes enter only through the existing
//! native intent/authority path; the exposed forwarding command is GET-only.
use reqwest::{Client,Url};
use serde_json::Value;
use crate::market_data::MarketDataState;
use std::sync::atomic::Ordering;
const BASE:&str="https://www.okx.com";
fn target(path:&str)->Result<Url,String>{
    if !path.starts_with("/api/v5/")||path.contains(['#','\\','\r','\n'])||path.len()>8192{return Err("无效的 OKX 直连地址".into())}
    let url=Url::parse(&format!("{BASE}{path}")).map_err(|_|"无效的 OKX 直连地址")?;
    if url.origin().ascii_serialization()!=BASE||url.path()!=path.split('?').next().unwrap_or(""){return Err("无效的 OKX 直连路径".into())}Ok(url)
}
fn public_target(path:&str)->Result<Url,String>{
    let url=target(path)?;
    if !["/api/v5/public/instruments","/api/v5/public/time","/api/v5/market/candles","/api/v5/market/history-candles","/api/v5/market/ticker","/api/v5/market/tickers","/api/v5/market/trades","/api/v5/market/books"].contains(&url.path())||url.query_pairs().any(|(k,_)|["api_key","key","authorization","ticket"].contains(&k.to_ascii_lowercase().as_str())){return Err("不支持的 OKX 公共请求".into())}Ok(url)
}
async fn response(response:reqwest::Response)->Result<Value,String>{
    let status=response.status();
    if !status.is_success(){return Err(format!("OKX 直连 HTTP {}，请检查网络或本机代理",status.as_u16()))}
    let value:Value=response.json().await.map_err(|_|"OKX 返回格式异常")?;
    if !value["code"].is_string()||!value["data"].is_array(){return Err("OKX 返回数据结构异常".into())}Ok(value)
}
pub(crate) async fn public_request(client:&Client,path:&str)->Result<Value,String>{
    response(client.get(public_target(path)?).send().await.map_err(|_|"无法直连 OKX，请检查本机网络或代理设置")?).await
}
fn signed_parts(value:&Value)->Result<(&str,Url,&str),String>{
    let method=value["method"].as_str().filter(|m|matches!(*m,"GET"|"POST")).ok_or("不支持的 OKX 方法")?;
    let path=value["path"].as_str().ok_or("缺少 OKX 路径")?;
    let reads=["account/balance","account/positions","account/positions-history","account/config","account/leverage-info","account/trade-fee","account/bills","account/bills-archive","trade/orders-pending","trade/orders-history","trade/orders-history-archive","trade/order","trade/fills","trade/fills-history","trade/orders-algo-pending","trade/orders-algo-history","trade/order-algo","public/instruments","public/time","market/ticker"];
    let writes=["trade/order","trade/batch-orders","trade/cancel-order","trade/cancel-batch-orders","trade/amend-order","trade/amend-batch-orders","trade/close-position","account/set-leverage","account/set-position-mode","trade/order-algo","trade/cancel-algos","trade/amend-algos"];
    let route=path.strip_prefix("/api/v5/").ok_or("无效 OKX 路径")?;
    if !(if method=="GET"{reads.contains(&route)}else{writes.contains(&route)}){return Err("不支持的 OKX 账户接口".into())}
    let query=value["query"].as_str().unwrap_or("");if query.len()>4096{return Err("OKX 查询超出限制".into())}
    let url=target(&format!("{path}{}{}",if query.is_empty(){""}else{"?"},query))?;
    let body=value["body"].as_str().unwrap_or("");if body.len()>65536||method=="GET"&&!body.is_empty(){return Err("无效 OKX 请求内容".into())}
    if !path.starts_with("/api/v5/public/")&&!path.starts_with("/api/v5/market/"){
        for key in ["access_key","signature","timestamp","passphrase"]{let field=value[key].as_str().filter(|v|!v.is_empty()&&v.len()<=1000&&!v.contains(['\r','\n']));if field.is_none(){return Err("OKX 签名不完整".into())}}
    }
    Ok((method,url,body))
}
pub(crate) async fn signed_request(client:&Client,value:&Value)->Result<Value,String>{
    let(method,url,body)=signed_parts(value)?;
    let private=!url.path().starts_with("/api/v5/public/")&&!url.path().starts_with("/api/v5/market/");
    let mut request=if method=="POST"{client.post(url).header("Content-Type","application/json").body(body.to_owned())}else{client.get(url)};
    if private {for (header,key) in [("OK-ACCESS-KEY","access_key"),("OK-ACCESS-SIGN","signature"),("OK-ACCESS-TIMESTAMP","timestamp"),("OK-ACCESS-PASSPHRASE","passphrase")]{request=request.header(header,value[key].as_str().unwrap_or(""));}}
    if value["simulated"]==true{request=request.header("x-simulated-trading","1")}
    // No retry: a POST whose response is lost must remain unknown in its journal.
    response(request.send().await.map_err(|_|if method=="POST"{"OKX 直连中断，交易结果未知，请核对原委托；不会重发"}else{"OKX 直连查询失败，请检查本机网络或代理"})?).await
}
#[tauri::command]
pub fn okx_enable_direct(state:tauri::State<'_,MarketDataState>){state.direct.store(true,Ordering::SeqCst);}
#[tauri::command]
pub async fn okx_public_http(state:tauri::State<'_,MarketDataState>,path:String)->Result<Value,String>{public_request(&state.client,&path).await}
#[tauri::command]
pub async fn okx_signed_read(state:tauri::State<'_,MarketDataState>,request:Value)->Result<Value,String>{
    signed_read(&state.client,&request).await
}
pub(crate) fn validate_direct_read(request:&Value)->Result<(),String>{
    if request["method"]!="GET"{return Err("金融写入必须经过已授权的原生执行权通道".into())}
    if request.get("execution_owner").is_some()||request.get("execution").is_some(){return Err("执行权快照和原单核对必须经过协调通道".into())}
    Ok(())
}
async fn signed_read(client:&Client,request:&Value)->Result<Value,String>{
    validate_direct_read(request)?;
    signed_request(client,request).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn permits_only_fixed_public_get_routes() {
        assert!(public_target("/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1m").is_ok());
        for path in ["https://evil.example/api/v5/market/candles","//evil.example/x","/api/v5/market/../trade/order","/api/v5/account/balance","/api/v5/market/candles#fragment"] { assert!(public_target(path).is_err()); }
    }
    #[test]
    fn validates_signed_headers_body_and_path_without_exposing_secrets() {
        let mut frame=json!({"method":"GET","path":"/api/v5/account/balance","query":"ccy=USDT","body":"","access_key":"fixture","signature":"signed","timestamp":"2026-10-24T01:00:00Z","passphrase":"fixture","simulated":true});
        assert!(signed_parts(&frame).is_ok());
        frame["path"]=json!("/api/v5/asset/withdrawal");assert!(signed_parts(&frame).is_err());
        frame["path"]=json!("/api/v5/account/balance");frame["passphrase"]=json!("");assert!(signed_parts(&frame).is_err());
    }
    #[tokio::test]
    async fn read_ipc_refuses_financial_writes_before_any_network_request(){
        let client=Client::builder().no_proxy().build().unwrap();
        let reply=signed_read(&client,&json!({"method":"POST","path":"/api/v5/trade/order","body":"{}"})).await;
        assert!(reply.unwrap_err().contains("金融写入必须经过"));
    }
    #[test]
    fn execution_observations_cannot_be_substituted_with_an_uncoordinated_read(){
        let mut request=json!({"method":"GET","path":"/api/v5/account/positions"});
        assert!(validate_direct_read(&request).is_ok());
        request["execution_owner"]=json!("manual_fixture_owner");assert!(validate_direct_read(&request).is_err());
        request.as_object_mut().unwrap().remove("execution_owner");request["execution"]=json!({"owner":"manual_fixture_owner"});assert!(validate_direct_read(&request).is_err());
    }
    #[tokio::test]
    #[ignore="explicit read-only demo acceptance through a test-process VPN"]
    async fn native_vpn_readonly_acceptance() {
        use base64::Engine;
        let credentials:Value=serde_json::from_str(&std::env::var("ATD_OKX_ACCEPTANCE_CREDENTIALS").expect("test credentials supplied in process memory")).unwrap();
        assert_eq!(credentials["demo"],true);
        let proxy=std::env::var("ATD_OKX_ACCEPTANCE_PROXY").expect("test-only proxy required");
        assert_eq!(std::env::var("HTTPS_PROXY").unwrap(),proxy);
        // Use the exact production pool. Only this test process receives the VPN
        // environment; the application contains no test proxy address or port.
        let state=MarketDataState::default();
        let client=&state.client;
        for path in ["/api/v5/public/time","/api/v5/public/instruments?instType=SWAP","/api/v5/market/ticker?instId=BTC-USDT-SWAP","/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1m&limit=3","/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=1m&limit=3","/api/v5/market/trades?instId=BTC-USDT-SWAP&limit=5","/api/v5/market/books?instId=BTC-USDT-SWAP&sz=5"] {
            let reply=public_request(&client,path).await.expect("public read succeeds");assert_eq!(reply["code"],"0");assert!(!reply["data"].as_array().unwrap().is_empty());
            println!("{}",json!({"readonly":true,"native":true,"path":path,"code":"0","rows":reply["data"].as_array().unwrap().len()}));
        }
        for path in ["/api/v5/account/config","/api/v5/account/balance","/api/v5/account/positions","/api/v5/trade/orders-pending","/api/v5/trade/orders-history?instType=SWAP&limit=5","/api/v5/trade/fills?instType=SWAP&limit=5","/api/v5/account/positions-history?instType=SWAP&limit=5","/api/v5/account/bills?instType=SWAP&limit=5","/api/v5/account/trade-fee?instType=SWAP","/api/v5/trade/orders-algo-pending?ordType=conditional"] {
            let timestamp=time::OffsetDateTime::now_utc().format(&time::format_description::parse_borrowed::<2>("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z").unwrap()).unwrap();
            let signature=base64::engine::general_purpose::STANDARD.encode(ring::hmac::sign(&ring::hmac::Key::new(ring::hmac::HMAC_SHA256,credentials["secret"].as_str().unwrap().as_bytes()),format!("{timestamp}GET{path}").as_bytes()).as_ref());
            let (route,query)=path.split_once('?').unwrap_or((path,""));
            let request=json!({"method":"GET","path":route,"query":query,"body":"","access_key":credentials["api_key"],"signature":signature,"timestamp":timestamp,"passphrase":credentials["passphrase"],"simulated":true});
            let reply=signed_request(&client,&request).await.expect("private read succeeds");assert_eq!(reply["code"],"0");
            println!("{}",json!({"readonly":true,"native":true,"path":path,"code":"0","rows":reply["data"].as_array().unwrap().len()}));
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
}
