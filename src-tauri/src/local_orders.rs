//! Decimal order preparation shared by native submission and validation tests.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OrderInput{
    venue:String,symbol:String,direction:String,offset:String,order_type:String,
    #[serde(default)]price:Value,#[serde(default)]quantity:Value,#[serde(default)]margin_usdt:Value,
    #[serde(default)]leverage:Value,#[serde(default)]margin_mode:Option<String>,
    #[serde(default)]tp_price:Value,#[serde(default)]sl_price:Value,#[serde(default)]reduce_only:Option<bool>,
}
pub(super) struct Inputs{pub spec:Value,pub ticker:Option<Value>,pub leverages:Vec<Value>}
pub(super) struct Plan{pub command:Value,pub leverage:Option<Value>,pub spec:Value,pub quote_ts:Option<Value>}
fn dec(value:&Value,label:&str)->Result<Decimal>{
    let text=if value.is_number(){value.to_string()}else{value.as_str().ok_or_else(||format!("{label}无效"))?.to_owned()};
    Decimal::from_str(&text).map_err(|_|format!("{label}无效"))
}
fn positive(value:&Value,label:&str)->Result<Decimal>{let value=dec(value,label)?;if value<=Decimal::ZERO{return Err(format!("{label}必须大于零"))}Ok(value)}
fn input(body:&Value)->Result<OrderInput>{
    let mut value=body.clone();if let Some(object)=value.as_object_mut(){object.remove("client_request_id");}
    let input:OrderInput=serde_json::from_value(value).map_err(|_|"下单参数不完整或包含不支持的字段")?;
    if input.venue!="okx"||!matches!(input.direction.as_str(),"buy"|"sell")||!matches!(input.offset.as_str(),"open"|"close")||!matches!(input.order_type.as_str(),"market"|"limit"){return Err("不支持的本机下单类型".into())}
    if input.reduce_only==Some(true)&&input.offset!="close"||input.reduce_only==Some(false)&&input.offset=="close"{return Err("开平方向与只减仓设置不一致".into())}
    if input.offset=="close"&&(!input.tp_price.is_null()||!input.sl_price.is_null()||!input.margin_usdt.is_null()){return Err("平仓委托请指定数量，不能附带开仓止盈止损或保证金算量".into())}
    instrument(&input.symbol)?;
    Ok(input)
}
fn mode(config:&Value)->Result<&str>{config["posMode"].as_str().filter(|m|matches!(*m,"net_mode"|"long_short_mode")).ok_or("交易所持仓模式未知，已停止下单".into())}
fn side<'a>(input:&OrderInput,mode:&str)->&'a str{
    if mode=="net_mode"{"net"}else{match(input.offset.as_str(),input.direction.as_str()){("open","buy")|("close","sell")=>"long",_=>"short"}}
}
fn price(value:&Value,tick:Decimal,label:&str)->Result<Decimal>{
    let value=positive(value,label)?;
    if value.checked_rem(tick).ok_or("价格超出范围")?!=Decimal::ZERO{return Err(format!("{label}不符合交易所价格步进 {tick}"))}Ok(value)
}
pub(super) fn validate_quote_time(stamp:&Value)->Result<()>{
    let stamp=dec(stamp,"报价时间")?;
    let now=Decimal::from(time::OffsetDateTime::now_utc().unix_timestamp_nanos()/1_000_000);
    if stamp<now-Decimal::from(10_000)||stamp>now+Decimal::from(2_000){return Err("报价已过期，请刷新行情后下单".into())}
    Ok(())
}
fn quote(ticker:&Value)->Result<Decimal>{
    validate_quote_time(&ticker["ts"])?;
    positive(&ticker["last"],"最新价")
}
pub(super) async fn load(app:&tauri::AppHandle,market:&MarketDataState,store:&LocalStoreState,scope:&str,credential:&NativeCredentials,body:&Value,config:&Value,owner:&str)->Result<Inputs>{
    let value=input(body)?;mode(config)?;
    let inst=instrument(&value.symbol)?;
    let spec=spec(app,market,store,scope,credential,&inst).await?;
    let ticker=if value.order_type=="market"&&(!value.margin_usdt.is_null()||!value.tp_price.is_null()||!value.sl_price.is_null()){
        let rows=read(app,market,scope,credential,&format!("/api/v5/market/ticker?instId={inst}"),owner).await?;
        Some(rows.into_iter().find(|row|row["instId"]==inst).ok_or("未取得当前合约的有效报价")?)
    }else{None};
    let margin=value.margin_mode.as_deref().unwrap_or("cross");
    if !matches!(margin,"cross"|"isolated"){return Err("保证金模式无效".into())}
    if value.offset=="open"&&config["acctLv"]=="4"&&margin=="cross"{return Err("本机保证金算量暂不支持组合保证金账户全仓下单".into())}
    let leverages=if value.offset=="open"{read(app,market,scope,credential,&format!("/api/v5/account/leverage-info?instId={inst}&mgnMode={margin}"),owner).await?}else{vec![]};
    Ok(Inputs{spec,ticker,leverages})
}
pub(super) fn build(body:&Value,config:&Value,inputs:Inputs,positions:&[Value],id:&str)->Result<Plan>{
    if id.len()!=32||!id.bytes().all(|b|b.is_ascii_alphanumeric()){return Err("下单请求编号无效".into())}
    let input=input(body)?;let pos_mode=mode(config)?;let pos_side=side(&input,pos_mode);
    let inst=instrument(&input.symbol)?;
    if inputs.spec["instId"]!=inst||inputs.spec["ctType"]!="linear"||inputs.spec["settleCcy"]!="USDT"{return Err("本机下单只支持 USDT 线性永续合约".into())}
    if inputs.spec["ctValCcy"].as_str()!=inst.strip_suffix("-USDT-SWAP"){return Err("合约面值币种不匹配，不能按基础币数量下单".into())}
    let tick=positive(&inputs.spec["tickSz"],"价格步进")?;
    let ct=positive(&inputs.spec["ctVal"],"合约面值")?;
    let step=positive(&inputs.spec["lotSz"],"数量步进")?;
    let mut margin=input.margin_mode.as_deref().unwrap_or("cross").to_owned();
    if !matches!(margin.as_str(),"cross"|"isolated"){return Err("保证金模式无效".into())}
    let reference=if input.order_type=="limit"{Some(price(&input.price,tick,"委托价格")?)}else{inputs.ticker.as_ref().map(quote).transpose()?};
    let mut leverage=None;
    let mut actual_leverage=None;
    if input.offset=="open"{
        let rows:Vec<_>=inputs.leverages.iter().filter(|r|r["instId"]==inst&&r["mgnMode"]==margin&&r["posSide"]==pos_side).collect();
        if rows.len()!=1{return Err("未取得当前合约、方向和保证金模式的唯一杠杆配置".into())}
        let current=positive(&rows[0]["lever"],"当前杠杆")?;
        let desired=if input.leverage.is_null(){current}else{positive(&input.leverage,"杠杆")?};
        if desired.fract()!=Decimal::ZERO||desired>Decimal::from(125){return Err("杠杆必须是 1 至 125 的整数".into())}
        if !inputs.spec["lever"].is_null()&&desired>positive(&inputs.spec["lever"],"最大杠杆")?{return Err("所选杠杆超过当前合约上限".into())}
        if desired!=current{
            let mut change=json!({"instId":inst,"mgnMode":margin,"lever":desired.normalize().to_string()});
            // Only isolated hedge leverage is scoped to a single position side.
            if pos_mode=="long_short_mode"&&margin=="isolated"{change["posSide"]=json!(pos_side)}
            leverage=Some(change);
        }
        actual_leverage=Some(desired);
    }
    let qty=if !input.quantity.is_null(){
        if !input.margin_usdt.is_null(){return Err("数量与保证金算量不能同时填写".into())}positive(&input.quantity,"委托数量")?
    }else{
        let margin_qty=positive(&input.margin_usdt,"委托保证金")?;
        margin_qty.checked_mul(actual_leverage.ok_or("缺少有效杠杆")?).and_then(|v|v.checked_div(reference?)).ok_or("保证金算量失败，缺少有效价格或数量超出范围")?
    };
    let contracts=contract_size(&qty.to_string(),&inputs.spec)?;
    let size=Decimal::from_str(&contracts).map_err(|_|"合约数量无效")?;
    if input.offset=="close"{
        let aligned=size.checked_mul(ct).ok_or("平仓数量超出范围")?;
        let tolerance=step.checked_mul(ct).and_then(|v|v.checked_mul(Decimal::new(1,8))).ok_or("合约数量超出范围")?.max(Decimal::new(1,12));
        if (qty-aligned).abs()>tolerance{return Err("平仓数量不符合交易所步进，已停止提交，请重新核对持仓".into())}
        let rows:Vec<_>=positions.iter().filter(|r|r["instId"]==inst&&r["posSide"]==pos_side&&num(&r["pos"])!=0.0&& (pos_side!="net"||input.direction=="buy"&&num(&r["pos"])<0.0||input.direction=="sell"&&num(&r["pos"])>0.0)).collect();
        if rows.len()!=1{return Err("未找到对应方向的唯一可平持仓".into())}
        let row=rows[0];margin=row["mgnMode"].as_str().filter(|m|matches!(*m,"cross"|"isolated")).ok_or("持仓保证金模式无效")?.to_owned();
        let total=dec(&row["pos"],"当前持仓")?.abs();
        let available=if row["availPos"].is_null()||row["availPos"]==""{total}else{dec(&row["availPos"],"可平数量")?.abs().min(total)};
        if size>available{return Err("委托数量超过当前可平数量，请先核对挂单与持仓".into())}
    }
    let max_key=if input.order_type=="market"{"maxMktSz"}else{"maxLmtSz"};
    if !inputs.spec[max_key].is_null()&&inputs.spec[max_key]!=""&&size>positive(&inputs.spec[max_key],"最大下单量")?{return Err("委托数量超过交易所单笔上限".into())}
    let mut command=json!({"instId":inst,"tdMode":margin,"side":input.direction,"posSide":pos_side,"ordType":input.order_type,"sz":contracts,"clOrdId":id});
    if input.order_type=="limit"{command["px"]=json!(reference.ok_or("缺少限价")?.normalize().to_string())}
    if input.offset=="close"&&pos_mode=="net_mode"{command["reduceOnly"]=json!(true)}
    let mut leg=json!({});
    for (field,value,above) in [("tpTriggerPx",&input.tp_price,input.direction=="buy"),("slTriggerPx",&input.sl_price,input.direction=="sell")]{
        if value.is_null(){continue}
        let trigger=price(value,tick,"止盈止损价格")?;let reference=reference.ok_or("缺少止盈止损参考价")?;
        if (above&&trigger<=reference)||(!above&&trigger>=reference){return Err("止盈止损方向与开仓方向不一致".into())}
        leg[field]=json!(trigger.normalize().to_string());leg[if field=="tpTriggerPx"{"tpOrdPx"}else{"slOrdPx"}]=json!("-1");
    }
    if !leg.as_object().ok_or("止盈止损无效")?.is_empty(){leg["attachAlgoClOrdId"]=json!(format!("T{}",&id[..31]));command["attachAlgoOrds"]=json!([leg]);}
    Ok(Plan{command,leverage,spec:inputs.spec,quote_ts:inputs.ticker.map(|t|t["ts"].clone())})
}
pub(super) fn ack(command:&Value,spec:&Value,raw:&Value)->Result<Value>{
    let mut row=command.clone();row["ordId"]=raw["data"][0]["ordId"].clone();row["state"]=json!("live");row["accFillSz"]=json!("0");
    row["cTime"]=json!((time::OffsetDateTime::now_utc().unix_timestamp_nanos()/1_000_000).to_string());
    let mut value=order(&row,spec);value["receipt_only"]=json!(true);Ok(value)
}

#[cfg(test)]
mod tests{
    use super::*;
    const ID:&str="0123456789abcdef0123456789abcdef";
    fn body()->Value{json!({"venue":"okx","symbol":"btcusdt","direction":"buy","offset":"open","order_type":"market","quantity":null,"margin_usdt":50,"leverage":10,"margin_mode":"cross","tp_price":25000,"sl_price":19000})}
    fn inputs(side:&str,margin:&str)->Inputs{Inputs{spec:json!({"instId":"BTC-USDT-SWAP","ctType":"linear","settleCcy":"USDT","ctVal":"0.01","ctValCcy":"BTC","tickSz":"0.1","lotSz":"0.1","minSz":"0.1","lever":"100"}),ticker:Some(json!({"last":"20000","ts":(time::OffsetDateTime::now_utc().unix_timestamp_nanos()/1_000_000).to_string()})),leverages:vec![json!({"instId":"BTC-USDT-SWAP","posSide":side,"mgnMode":margin,"lever":"5"})]}}
    #[test]fn margin_sizing_preserves_contract_units_and_attached_protection(){
        let plan=build(&body(),&json!({"posMode":"net_mode"}),inputs("net","cross"),&[],ID).unwrap();
        assert_eq!(plan.command["sz"],"2.5");assert_eq!(plan.command["clOrdId"],ID);
        assert_eq!(plan.leverage.unwrap()["lever"],"10");
        assert_eq!(plan.command["attachAlgoOrds"][0]["tpOrdPx"],"-1");
        assert_eq!(plan.command["attachAlgoOrds"][0]["slTriggerPx"],"19000");
        assert_eq!(plan.command["attachAlgoOrds"][0]["attachAlgoClOrdId"].as_str().unwrap().len(),32);
    }
    #[test]fn limit_price_and_inputs_are_validated_without_silent_changes(){
        let mut request=body();request["order_type"]=json!("limit");request["price"]=json!(20000.05);
        assert!(build(&request,&json!({"posMode":"net_mode"}),inputs("net","cross"),&[],ID).err().unwrap().contains("价格步进"));
        request["price"]=json!(20000);request["quantity"]=json!(0.1);
        assert!(build(&request,&json!({"posMode":"net_mode"}),inputs("net","cross"),&[],ID).is_err());
        request["quantity"]=Value::Null;request["task_id"]=json!("cannot-create-task");assert!(input(&request).is_err());
    }
    #[test]fn close_direction_is_safe_in_both_hedge_and_net_modes(){
        let request=json!({"venue":"okx","symbol":"btcusdt","direction":"buy","offset":"close","order_type":"market","quantity":0.02,"reduce_only":true});
        for (mode,pos_side,pos) in [("long_short_mode","short","2"),("net_mode","net","-2")]{
            let positions=vec![json!({"instId":"BTC-USDT-SWAP","pos":pos,"availPos":"2","posSide":pos_side,"mgnMode":"isolated"})];
            let result=build(&request,&json!({"posMode":mode}),inputs(pos_side,"isolated"),&positions,ID).unwrap();
            assert_eq!(result.command["posSide"],pos_side);assert_eq!(result.command["tdMode"],"isolated");
            assert_eq!(result.command["reduceOnly"],if mode=="net_mode"{json!(true)}else{Value::Null});
            assert!(result.leverage.is_none());
            let frozen=vec![json!({"instId":"BTC-USDT-SWAP","pos":pos,"availPos":"0","posSide":pos_side,"mgnMode":"isolated"})];
            assert!(build(&request,&json!({"posMode":mode}),inputs(pos_side,"isolated"),&frozen,ID).is_err());
        }
    }
    #[test]fn stale_quotes_wrong_protection_and_unknown_modes_fail_closed(){
        let mut stale=inputs("net","cross");stale.ticker.as_mut().unwrap()["ts"]=json!("1");
        assert!(build(&body(),&json!({"posMode":"net_mode"}),stale,&[],ID).is_err());
        let mut request=body();request["sl_price"]=json!(21000);
        assert!(build(&request,&json!({"posMode":"net_mode"}),inputs("net","cross"),&[],ID).is_err());
        assert!(build(&body(),&json!({"posMode":"unknown"}),inputs("net","cross"),&[],ID).is_err());
        let mut wrong=inputs("net","cross");wrong.spec["ctValCcy"]=json!("USDT");
        assert!(build(&body(),&json!({"posMode":"net_mode"}),wrong,&[],ID).is_err());
    }
    #[test]fn hedge_isolated_adjusts_only_the_selected_leg_and_ack_never_invents_fills(){
        let mut request=body();request["margin_mode"]=json!("isolated");
        let plan=build(&request,&json!({"posMode":"long_short_mode"}),inputs("long","isolated"),&[],ID).unwrap();
        assert_eq!(plan.leverage.as_ref().unwrap()["posSide"],"long");assert_eq!(plan.command["posSide"],"long");
        let receipt=ack(&plan.command,&plan.spec,&json!({"data":[{"ordId":"123","clOrdId":ID}]})).unwrap();
        assert_eq!(receipt["id"],"123");assert_eq!(receipt["quantity"],0.025);assert_eq!(receipt["filled_qty"],0.0);assert_eq!(receipt["status"],"live");
        assert_eq!(receipt["tp_price"],25000.0);assert_eq!(receipt["sl_price"],19000.0);
    }
}
