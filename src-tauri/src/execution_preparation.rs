//! Server-signed preparation only. Local records cannot create an executable task.
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{aead,agreement,hkdf,signature};
use serde::Deserialize;
use serde_json::Value;
use zeroize::{Zeroize,Zeroizing};
use crate::local_exchange::NativeCredentials;
const CONTEXT:&[u8]=b"cyclepilot/executor-bootstrap/v1";
const MAX_RAW:usize=32*1024*1024;
const MAX_PACKED:usize=4*1024*1024;
type Result<T>=std::result::Result<T,String>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Envelope {version:u32,public_key:String,nonce:String,ciphertext:String}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {payload:String,signature:String}
impl Drop for Document {fn drop(&mut self){self.payload.zeroize();}}
struct SensitiveValue(Value);
impl std::ops::Deref for SensitiveValue {type Target=Value;fn deref(&self)->&Value{&self.0}}
impl Drop for SensitiveValue {
    fn drop(&mut self){
        fn wipe(value:&mut Value){match value {
            Value::String(text)=>text.zeroize(),
            Value::Array(rows)=>rows.iter_mut().for_each(wipe),
            Value::Object(rows)=>rows.values_mut().for_each(wipe),
            _=>{},
        }}
        wipe(&mut self.0);
    }
}

pub(crate) struct Preparation {pub document:Zeroizing<Vec<u8>>,pub account_id:String,pub demo:bool}

pub(crate) fn unseal(private:agreement::EphemeralPrivateKey,client_public:&[u8],envelope:Envelope)->Result<Zeroizing<Vec<u8>>>{
    let error=||"任务准备数据解密失败".to_string();
    if envelope.version!=1 || envelope.ciphertext.len()>(MAX_PACKED+16)*4/3+4{return Err(error());}
    let public=STANDARD.decode(envelope.public_key).map_err(|_|error())?;
    let nonce:[u8;12]=STANDARD.decode(envelope.nonce).map_err(|_|error())?.try_into().map_err(|_|error())?;
    let mut cipher=Zeroizing::new(STANDARD.decode(envelope.ciphertext).map_err(|_|error())?);
    if public.len()!=32 || cipher.len()>MAX_PACKED+16{return Err(error());}
    let aad=[CONTEXT,client_public,&public].concat();
    struct Length;impl hkdf::KeyType for Length {fn len(&self)->usize{32}}
    let mut key=Zeroizing::new([0u8;32]);
    agreement::agree_ephemeral(private,&agreement::UnparsedPublicKey::new(&agreement::X25519,&public),|shared|{
        hkdf::Salt::new(hkdf::HKDF_SHA256,&[]).extract(shared).expand(&[&aad],Length).and_then(|okm|okm.fill(key.as_mut()))
    }).map_err(|_|error())?.map_err(|_|error())?;
    let key=aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM,key.as_ref()).map_err(|_|error())?);
    let packed=key.open_in_place(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(aad),&mut cipher).map_err(|_|error())?;
    inflate(packed)
}

fn inflate(packed:&[u8])->Result<Zeroizing<Vec<u8>>>{
    let mut decoder=flate2::Decompress::new(true);
    let mut raw=Zeroizing::new(Vec::new());
    let mut chunk=Zeroizing::new([0u8;65536]);
    loop {
        let before_in=decoder.total_in();let before_out=decoder.total_out();
        let status=decoder.decompress(&packed[before_in as usize..],chunk.as_mut(),flate2::FlushDecompress::Finish).map_err(|_|"任务数据压缩流无效")?;
        let count=(decoder.total_out()-before_out) as usize;
        if raw.len()+count>MAX_RAW {return Err("任务数据解压后超出限制".into());}
        raw.extend_from_slice(&chunk[..count]);
        if status==flate2::Status::StreamEnd {
            if decoder.total_in()!=packed.len() as u64 {return Err("任务数据压缩流包含多余数据".into());}
            return Ok(raw);
        }
        if before_in==decoder.total_in() && count==0 {return Err("任务数据压缩流不完整".into());}
    }
}

/// Fresh imports enforce the ten-minute deadline. A cached DPAPI document is
/// reverified against current keys here and again against current permissions,
/// task registrations and its committed SQLite bootstrap by the child itself.
pub(crate) fn verify(document:Zeroizing<Vec<u8>>,keys:&Value,scope:&str,center_key:&str,credential:&NativeCredentials,now:i64,cached:bool)->Result<Preparation>{
    if document.len()>64*1024*1024 || !credential.server_bound{return Err("请先同步服务器交易所账户".into());}
    let signed:Document=serde_json::from_slice(&document).map_err(|_|"服务器任务授权格式无效")?;
    if signed.payload.len()>MAX_RAW || signed.signature.len()!=88{return Err("任务准备数据或签名长度无效".into());}
    let payload=SensitiveValue(serde_json::from_str(&signed.payload).map_err(|_|"服务器任务授权格式无效")?);
    let authority=payload["authority"].as_str().ok_or("缺少服务器签名机构")?;
    let public=STANDARD.decode(keys[authority].as_str().filter(|key|key.len()==44).ok_or("服务器签名机构未由接口中心授权")?).map_err(|_|"签名公钥无效")?;
    let sig=STANDARD.decode(&signed.signature).map_err(|_|"任务签名无效")?;
    signature::UnparsedPublicKey::new(&signature::ED25519,&public).verify(signed.payload.as_bytes(),&sig).map_err(|_|"服务器任务签名校验失败")?;
    if payload["kind"]!="executor-bootstrap-v1" || payload["collection_key"].as_str()!=Some(center_key){return Err("准备数据与当前数据 Key 不匹配，请重新同步服务器".into());}
    let subject=payload["subject"].as_str().ok_or("缺少服务器用户")?;
    if scope.rsplit_once(':').map(|(_,user)|user)!=Some(subject){return Err("准备数据属于其他服务器账号".into());}
    let account=payload["account_id"].as_str().filter(|s|s.len()==64 && s.bytes().all(|c|c.is_ascii_hexdigit() && !c.is_ascii_uppercase())).ok_or("执行账户编号无效")?;
    let issued=payload["issued_at"].as_i64().ok_or("服务器授权时间无效")?;
    let expires=payload["expires_at"].as_i64().ok_or("服务器授权时间无效")?;
    if issued<0 || expires.checked_sub(issued).filter(|ttl|*ttl>0 && *ttl<=600).is_none()
        || !cached && (now<issued.saturating_sub(30) || now>=expires){return Err("服务器同步授权已过期，请重新同步".into());}
    let models=payload["models"].as_array().filter(|r|r.len()<=10000).ok_or("任务准备数据记录无效")?;
    let credentials:Vec<_>=models.iter().filter(|r|r["table"]=="exchange_credentials").collect();
    if credentials.len()!=1{return Err("任务必须属于单一交易所账户".into());}
    let binding=&credentials[0]["value"];
    if binding["venue"]!="okx" || binding["user_id"]!=subject || binding["api_key"]!=credential.api_key || binding["demo"].as_bool()!=Some(credential.demo){return Err("服务器任务与本机交易账户不匹配，请重新同步账户".into());}
    let result=Preparation{document,account_id:account.into(),demo:credential.demo};
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{rand,signature::KeyPair};
    use serde_json::json;
    fn credential()->NativeCredentials{NativeCredentials{api_key:"exchange-key".into(),secret:"secret".into(),passphrase:"passphrase".into(),demo:true,label:String::new(),updated_at:String::new(),server_bound:true}}
    fn fixture()->(Zeroizing<Vec<u8>>,Value){
        let key=signature::Ed25519KeyPair::from_pkcs8(signature::Ed25519KeyPair::generate_pkcs8(&rand::SystemRandom::new()).unwrap().as_ref()).unwrap();
        let payload=json!({"kind":"executor-bootstrap-v1","authority":"business","subject":"user","account_id":"a".repeat(64),"collection_key":"ac_test",
            "issued_at":1000,"expires_at":1600,"models":[{"table":"exchange_credentials","value":{"venue":"okx","user_id":"user","api_key":"exchange-key","demo":true}}]}).to_string();
        let sig=STANDARD.encode(key.sign(payload.as_bytes()).as_ref());
        (Zeroizing::new(json!({"payload":payload,"signature":sig}).to_string().into_bytes()),json!({"business":STANDARD.encode(key.public_key().as_ref())}))
    }
    #[test]
    fn exact_signed_bytes_account_key_and_import_deadline_are_required(){
        let (raw,keys)=fixture();let cred=credential();
        assert!(verify(raw.clone(),&keys,"https://server:user","ac_test",&cred,1010,false).is_ok());
        assert!(verify(raw.clone(),&keys,"https://server:other","ac_test",&cred,1010,false).is_err());
        assert!(verify(raw.clone(),&keys,"https://server:user","ac_other",&cred,1010,false).is_err());
        assert!(verify(raw.clone(),&keys,"https://server:user","ac_test",&cred,1600,false).is_err());
        assert!(verify(raw.clone(),&keys,"https://server:user","ac_test",&cred,1600,true).is_ok());
        let mut changed:Value=serde_json::from_slice(&raw).unwrap();changed["payload"]=json!(changed["payload"].as_str().unwrap().replace("exchange-key","different"));
        assert!(verify(Zeroizing::new(changed.to_string().into_bytes()),&keys,"https://server:user","ac_test",&cred,1010,false).is_err());
        let mut other=credential();other.demo=false;
        assert!(verify(raw,&keys,"https://server:user","ac_test",&other,1010,false).is_err());
    }
    #[test]
    fn compression_rejects_trailing_garbage_and_truncation(){
        use std::io::Write;
        let mut encoder=flate2::write::ZlibEncoder::new(Vec::new(),flate2::Compression::default());encoder.write_all(b"{}").unwrap();
        let mut bytes=encoder.finish().unwrap();assert_eq!(&*inflate(&bytes).unwrap(),b"{}");
        bytes.push(0);assert!(inflate(&bytes).is_err());bytes.truncate(3);assert!(inflate(&bytes).is_err());
    }
    #[test]
    fn recipient_envelope_authenticates_exact_context_and_rejects_cipher_tampering(){
        use std::io::Write;
        for tamper in 0..3 {
            let rng=rand::SystemRandom::new();
            let client=agreement::EphemeralPrivateKey::generate(&agreement::X25519,&rng).unwrap();
            let mut client_public=client.compute_public_key().unwrap().as_ref().to_vec();
            let server=agreement::EphemeralPrivateKey::generate(&agreement::X25519,&rng).unwrap();
            let server_public=server.compute_public_key().unwrap();
            let aad=[CONTEXT,client_public.as_slice(),server_public.as_ref()].concat();
            struct Length;impl hkdf::KeyType for Length {fn len(&self)->usize{32}}
            let mut key=[0u8;32];
            agreement::agree_ephemeral(server,&agreement::UnparsedPublicKey::new(&agreement::X25519,&client_public),|shared|{
                hkdf::Salt::new(hkdf::HKDF_SHA256,&[]).extract(shared).expand(&[&aad],Length).unwrap().fill(&mut key).unwrap();
            }).unwrap();
            let mut packed=flate2::write::ZlibEncoder::new(Vec::new(),flate2::Compression::default());
            packed.write_all(b"{\"synthetic\":true}").unwrap();
            let mut cipher=packed.finish().unwrap();
            let key=aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM,&key).unwrap());
            let nonce=[7u8;12];
            key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce),aead::Aad::from(aad),&mut cipher).unwrap();
            if tamper==1 {cipher[0]^=1;}if tamper==2 {client_public[0]^=1;}
            let envelope=Envelope{version:1,public_key:STANDARD.encode(server_public.as_ref()),nonce:STANDARD.encode(nonce),ciphertext:STANDARD.encode(cipher)};
            let result=unseal(client,&client_public,envelope);
            if tamper==0 {assert_eq!(&*result.unwrap(),b"{\"synthetic\":true}");}else{assert!(result.is_err());}
        }
    }
}
