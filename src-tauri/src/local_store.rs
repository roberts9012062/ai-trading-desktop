//! Embedded desktop business records. No arbitrary SQL is exposed to the UI.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;
fn sql(error:rusqlite::Error)->String{format!("本地数据库操作失败：{error}")}
fn now()->i64{time::OffsetDateTime::now_utc().unix_timestamp()}
fn valid(scope:&str,collection:&str,id:&str)->Result<()>{
    if scope.is_empty()||scope.len()>1024||collection.is_empty()||collection.len()>100||id.is_empty()||id.len()>512||[scope,collection,id].iter().any(|s|s.chars().any(char::is_control)){return Err("无效的本地记录标识".into())}Ok(())
}

#[derive(Clone,Debug,Serialize,Deserialize)]
pub struct Record {
    pub collection:String,pub id:String,pub value:Value,pub revision:i64,
    pub base_version:String,pub dirty:bool,pub deleted:bool,pub updated_at:i64,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
pub struct RemoteRecord{pub collection:String,pub id:String,pub value:Value,pub version:String,#[serde(default)]pub deleted:bool}
#[derive(Deserialize)]
pub struct LocalMutation{pub id:String,pub value:Value,#[serde(default)]pub deleted:bool}

pub struct Store{connection:Connection}
pub enum Intent{Fresh,Known(Value),Unknown}
impl Store {
    pub fn open(path:&Path)->Result<Self>{let connection=Connection::open(path).map_err(sql)?;Self::init(connection)}
    #[cfg(test)]pub fn memory()->Result<Self>{Self::init(Connection::open_in_memory().map_err(sql)?)}
    fn init(connection:Connection)->Result<Self>{
        let version:i64=connection.pragma_query_value(None,"user_version",|row|row.get(0)).map_err(sql)?;
        if version>2{return Err("本地数据库版本较新，请升级客户端后重试".into())}
        connection.busy_timeout(std::time::Duration::from_secs(5)).map_err(sql)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
          BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,base_version TEXT NOT NULL DEFAULT '',dirty INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,collection,id));
          CREATE INDEX IF NOT EXISTS records_pending ON records(scope,dirty,updated_at);
          CREATE TABLE IF NOT EXISTS conflicts(scope TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,remote TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(scope,collection,id));
          CREATE TABLE IF NOT EXISTS secure_blobs(scope TEXT NOT NULL,id TEXT NOT NULL,sealed BLOB NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,id));
          CREATE TABLE IF NOT EXISTS sync_meta(scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,key));
          CREATE TABLE IF NOT EXISTS command_intents(scope TEXT NOT NULL,id TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,response TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(scope,id));
          CREATE TABLE IF NOT EXISTS command_payloads(scope TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,PRIMARY KEY(scope,id),FOREIGN KEY(scope,id) REFERENCES command_intents(scope,id));
          PRAGMA user_version=2; COMMIT;").map_err(sql)?;
        Ok(Self{connection})
    }
    fn row(row:&rusqlite::Row<'_>)->rusqlite::Result<Record>{
        let raw:String=row.get(2)?;
        let value=serde_json::from_str(&raw).map_err(|error|rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,Box::new(error)))?;
        Ok(Record{collection:row.get(0)?,id:row.get(1)?,value,revision:row.get(3)?,base_version:row.get(4)?,dirty:row.get(5)?,deleted:row.get(6)?,updated_at:row.get(7)?})
    }
    pub fn get(&self,scope:&str,collection:&str,id:&str)->Result<Option<Record>>{
        valid(scope,collection,id)?;
        self.connection.query_row("SELECT collection,id,value,revision,base_version,dirty,deleted,updated_at FROM records WHERE scope=?1 AND collection=?2 AND id=?3",params![scope,collection,id],Self::row).optional().map_err(sql)
    }
    pub fn list(&mut self,scope:&str,collection:&str)->Result<Vec<Record>>{
        valid(scope,collection,"list")?;
        let mut statement=self.connection.prepare("SELECT collection,id,value,revision,base_version,dirty,deleted,updated_at FROM records WHERE scope=?1 AND collection=?2 AND deleted=0 ORDER BY updated_at,id").map_err(sql)?;
        let rows=statement.query_map(params![scope,collection],Self::row).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;Ok(rows)
    }
    pub fn put(&mut self,scope:&str,collection:&str,id:&str,value:&Value)->Result<Record>{self.write(scope,collection,id,value,false,true)}
    pub fn cache(&mut self,scope:&str,collection:&str,id:&str,value:&Value)->Result<Record>{self.write(scope,collection,id,value,false,false)}
    fn write(&mut self,scope:&str,collection:&str,id:&str,value:&Value,deleted:bool,dirty:bool)->Result<Record>{
        valid(scope,collection,id)?;let encoded=serde_json::to_string(value).map_err(|_|"本地记录无法序列化")?;
        if encoded.len()>4*1024*1024{return Err("单条本地记录超出限制".into())}
        self.connection.execute("INSERT INTO records(scope,collection,id,value,revision,dirty,deleted,updated_at) VALUES(?1,?2,?3,?4,1,?5,?6,?7) ON CONFLICT(scope,collection,id) DO UPDATE SET value=excluded.value,revision=records.revision+1,dirty=excluded.dirty,deleted=excluded.deleted,updated_at=excluded.updated_at",params![scope,collection,id,encoded,dirty,deleted,now()]).map_err(sql)?;
        self.get(scope,collection,id)?.ok_or("本地记录写入失败".into())
    }
    pub fn delete(&mut self,scope:&str,collection:&str,id:&str)->Result<Record>{self.write(scope,collection,id,&json!({}),true,true)}
    pub fn batch(&mut self,scope:&str,collection:&str,records:&[LocalMutation])->Result<()> {
        self.batch_write(scope,collection,records,true)
    }
    pub fn cache_batch(&mut self,scope:&str,collection:&str,records:&[LocalMutation])->Result<()> {
        self.batch_write(scope,collection,records,false)
    }
    fn batch_write(&mut self,scope:&str,collection:&str,records:&[LocalMutation],dirty:bool)->Result<()> {
        if records.len()>1000{return Err("本地批量修改数量超出限制".into())}
        let tx=self.connection.transaction().map_err(sql)?;
        for row in records{
            valid(scope,collection,&row.id)?;
            let raw=serde_json::to_string(&row.value).map_err(|_|"无效的本地记录")?;
            if raw.len()>4*1024*1024{return Err("本地记录超出限制".into())}
            tx.execute("INSERT INTO records(scope,collection,id,value,revision,dirty,deleted,updated_at) VALUES(?1,?2,?3,?4,1,?7,?5,?6) ON CONFLICT(scope,collection,id) DO UPDATE SET value=excluded.value,revision=records.revision+1,dirty=excluded.dirty,deleted=excluded.deleted,updated_at=excluded.updated_at",params![scope,collection,row.id,raw,row.deleted,now(),dirty]).map_err(sql)?;
        }
        tx.commit().map_err(sql)?;Ok(())
    }
    pub fn pending(&mut self,scope:&str)->Result<Vec<Record>>{
        valid(scope,"pending","all")?;
        let mut statement=self.connection.prepare("SELECT collection,id,value,revision,base_version,dirty,deleted,updated_at FROM records WHERE scope=?1 AND dirty=1 ORDER BY updated_at,collection,id").map_err(sql)?;
        let rows=statement.query_map([scope],Self::row).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;Ok(rows)
    }
    pub fn merge(&mut self,scope:&str,records:&[RemoteRecord])->Result<usize>{
        if records.len()>20000{return Err("同步记录数量超出限制".into())}
        let transaction=self.connection.transaction().map_err(sql)?;let mut applied=0;
        for remote in records {
            valid(scope,&remote.collection,&remote.id)?;
            if remote.version.is_empty()||remote.version.len()>200{return Err("无效的服务器记录版本".into())}
            let raw=serde_json::to_string(&remote.value).map_err(|_|"同步记录无法序列化")?;
            if raw.len()>4*1024*1024{return Err("同步记录超出限制".into())}
            let current=transaction.query_row("SELECT collection,id,value,revision,base_version,dirty,deleted,updated_at FROM records WHERE scope=?1 AND collection=?2 AND id=?3",params![scope,remote.collection,remote.id],Self::row).optional().map_err(sql)?;
            if let Some(local)=current.as_ref().filter(|record|record.dirty){
                if local.deleted==remote.deleted&&local.value==remote.value{
                    transaction.execute("UPDATE records SET dirty=0,base_version=?4 WHERE scope=?1 AND collection=?2 AND id=?3",params![scope,remote.collection,remote.id,remote.version]).map_err(sql)?;
                    transaction.execute("DELETE FROM conflicts WHERE scope=?1 AND collection=?2 AND id=?3",params![scope,remote.collection,remote.id]).map_err(sql)?;
                }else if local.base_version!=remote.version{
                    transaction.execute("INSERT INTO conflicts(scope,collection,id,remote,created_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,collection,id) DO UPDATE SET remote=excluded.remote,created_at=excluded.created_at",params![scope,remote.collection,remote.id,serde_json::to_string(remote).map_err(|_|"无效同步记录")?,now()]).map_err(sql)?;
                }
                continue
            }
            transaction.execute("INSERT INTO records(scope,collection,id,value,revision,base_version,dirty,deleted,updated_at) VALUES(?1,?2,?3,?4,1,?5,0,?6,?7) ON CONFLICT(scope,collection,id) DO UPDATE SET value=excluded.value,revision=records.revision+1,base_version=excluded.base_version,dirty=0,deleted=excluded.deleted,updated_at=excluded.updated_at",params![scope,remote.collection,remote.id,raw,remote.version,remote.deleted,now()]).map_err(sql)?;applied+=1;
        }
        transaction.commit().map_err(sql)?;Ok(applied)
    }
    pub fn ack(&mut self,scope:&str,collection:&str,id:&str,revision:i64,version:&str)->Result<()>{
        valid(scope,collection,id)?;
        if version.is_empty(){return Err("同步确认缺少版本".into())}
        self.connection.execute("UPDATE records SET base_version=?5,dirty=CASE WHEN revision=?4 THEN 0 ELSE dirty END WHERE scope=?1 AND collection=?2 AND id=?3 AND revision>=?4",params![scope,collection,id,revision,version]).map_err(sql)?;Ok(())
    }
    pub fn conflicts(&mut self,scope:&str)->Result<Vec<Value>>{
        valid(scope,"conflicts","all")?;
        let mut statement=self.connection.prepare("SELECT collection,id,remote,created_at FROM conflicts WHERE scope=?1 ORDER BY created_at,id").map_err(sql)?;
        let rows=statement.query_map([scope],|row|Ok(json!({"collection":row.get::<_,String>(0)?,"id":row.get::<_,String>(1)?,"remote":serde_json::from_str::<Value>(&row.get::<_,String>(2)?).unwrap_or(Value::Null),"created_at":row.get::<_,i64>(3)?}))).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;Ok(rows)
    }
    pub fn resolve(&mut self,scope:&str,collection:&str,id:&str,choice:&str)->Result<()>{
        valid(scope,collection,id)?;
        let tx=self.connection.transaction().map_err(sql)?;
        let raw:String=tx.query_row("SELECT remote FROM conflicts WHERE scope=?1 AND collection=?2 AND id=?3",params![scope,collection,id],|r|r.get(0)).map_err(sql)?;
        let remote:RemoteRecord=serde_json::from_str(&raw).map_err(|_|"冲突记录损坏")?;
        if choice=="server"{tx.execute("UPDATE records SET value=?4,base_version=?5,dirty=0,deleted=?6,revision=revision+1,updated_at=?7 WHERE scope=?1 AND collection=?2 AND id=?3",params![scope,collection,id,serde_json::to_string(&remote.value).map_err(|_|"冲突记录损坏")?,remote.version,remote.deleted,now()]).map_err(sql)?;}
        else if choice=="local"{tx.execute("UPDATE records SET base_version=?4,dirty=1 WHERE scope=?1 AND collection=?2 AND id=?3",params![scope,collection,id,remote.version]).map_err(sql)?;}
        else{return Err("无效的冲突处理方式".into())}
        tx.execute("DELETE FROM conflicts WHERE scope=?1 AND collection=?2 AND id=?3",params![scope,collection,id]).map_err(sql)?;
        tx.commit().map_err(sql)?;Ok(())
    }
    pub fn secret(&self,scope:&str,id:&str)->Result<Option<Vec<u8>>>{valid(scope,"secure",id)?;self.connection.query_row("SELECT sealed FROM secure_blobs WHERE scope=?1 AND id=?2",params![scope,id],|r|r.get(0)).optional().map_err(sql)}
    pub fn save_secret(&mut self,scope:&str,id:&str,sealed:&[u8])->Result<()>{valid(scope,"secure",id)?;self.connection.execute("INSERT INTO secure_blobs(scope,id,sealed,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(scope,id) DO UPDATE SET sealed=excluded.sealed,updated_at=excluded.updated_at",params![scope,id,sealed,now()]).map_err(sql)?;Ok(())}
    pub fn remove_secret(&mut self,scope:&str,id:&str)->Result<()>{valid(scope,"secure",id)?;self.connection.execute("DELETE FROM secure_blobs WHERE scope=?1 AND id=?2",params![scope,id]).map_err(sql)?;Ok(())}
    pub fn save_secrets(&mut self,scope:&str,rows:&[(&str,&[u8])])->Result<()>{
        let tx=self.connection.transaction().map_err(sql)?;
        for (id,sealed) in rows{
            valid(scope,"secure",id)?;
            tx.execute("INSERT INTO secure_blobs(scope,id,sealed,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(scope,id) DO UPDATE SET sealed=excluded.sealed,updated_at=excluded.updated_at",params![scope,id,sealed,now()]).map_err(sql)?;
        }
        tx.commit().map_err(sql)?;Ok(())
    }
    pub fn meta(&self,scope:&str,key:&str)->Result<Option<Value>>{valid(scope,"meta",key)?;let raw:Option<String>=self.connection.query_row("SELECT value FROM sync_meta WHERE scope=?1 AND key=?2",params![scope,key],|r|r.get(0)).optional().map_err(sql)?;raw.map(|s|serde_json::from_str(&s).map_err(|_|"本地状态损坏".into())).transpose()}
    pub fn set_meta(&mut self,scope:&str,key:&str,value:&Value)->Result<()>{valid(scope,"meta",key)?;self.connection.execute("INSERT INTO sync_meta(scope,key,value) VALUES(?1,?2,?3) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value",params![scope,key,serde_json::to_string(value).map_err(|_|"状态序列化失败")?]).map_err(sql)?;Ok(())}
    pub fn begin_intent(&mut self,scope:&str,id:&str,payload_hash:&str)->Result<Intent>{
        self.prepare_intent(scope,id,payload_hash,None)
    }
    pub fn begin_command(&mut self,scope:&str,id:&str,payload_hash:&str,request:&Value)->Result<Intent>{
        let raw=serde_json::to_string(request).map_err(|_|"交易指令无法序列化")?;
        if raw.len()>128*1024{return Err("交易指令过大".into())}
        self.prepare_intent(scope,id,payload_hash,Some(&raw))
    }
    fn prepare_intent(&mut self,scope:&str,id:&str,payload_hash:&str,request:Option<&str>)->Result<Intent>{
        valid(scope,"intents",id)?;
        let tx=self.connection.transaction().map_err(sql)?;
        let inserted=tx.execute("INSERT OR IGNORE INTO command_intents(scope,id,payload_hash,status,created_at) VALUES(?1,?2,?3,'pending',?4)",params![scope,id,payload_hash,now()]).map_err(sql)?;
        if inserted==1{
            if let Some(raw)=request{tx.execute("INSERT INTO command_payloads(scope,id,request) VALUES(?1,?2,?3)",params![scope,id,raw]).map_err(sql)?;}
            tx.commit().map_err(sql)?;return Ok(Intent::Fresh)
        }
        let (hash,status,response):(String,String,Option<String>)=tx.query_row("SELECT payload_hash,status,response FROM command_intents WHERE scope=?1 AND id=?2",params![scope,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(sql)?;
        if hash!=payload_hash{return Err("同一交易指令不能修改内容后重发".into())}
        if status=="complete"{return Ok(Intent::Known(serde_json::from_str(&response.ok_or("交易结果记录损坏")?).map_err(|_|"交易结果记录损坏")?))}Ok(Intent::Unknown)
    }
    pub fn finish_intent(&mut self,scope:&str,id:&str,response:Option<&Value>)->Result<()>{
        valid(scope,"intents",id)?;
        self.connection.execute("UPDATE command_intents SET status=?3,response=?4 WHERE scope=?1 AND id=?2 AND status NOT IN ('complete','reconciled')",params![scope,id,if response.is_some(){"complete"}else{"unknown"},response.map(serde_json::to_string).transpose().map_err(|_|"交易结果编码失败")?]).map_err(sql)?;Ok(())
    }
    pub fn reconcile_intent(&mut self,scope:&str,id:&str)->Result<()>{
        valid(scope,"intents",id)?;
        self.connection.execute("UPDATE command_intents SET status='reconciled' WHERE scope=?1 AND id=?2 AND status NOT IN ('complete','reconciled')",params![scope,id]).map_err(sql)?;Ok(())
    }
    pub fn unresolved_intents(&self,scope:&str)->Result<Vec<Value>>{
        let mut stmt=self.connection.prepare("SELECT c.id,c.payload_hash,c.status,c.created_at,p.request FROM command_intents c LEFT JOIN command_payloads p USING(scope,id) WHERE c.scope=?1 AND c.status NOT IN ('complete','reconciled') ORDER BY c.created_at").map_err(sql)?;
        let rows=stmt.query_map([scope],|r|Ok(json!({"id":r.get::<_,String>(0)?,"payload_hash":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"created_at":r.get::<_,i64>(3)?,"request":r.get::<_,Option<String>>(4)?.and_then(|raw|serde_json::from_str::<Value>(&raw).ok())}))).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;Ok(rows)
    }
    pub fn order_command(&self,scope:&str,id:&str)->Result<Option<Value>>{
        valid(scope,"intents",id)?;let prefix=format!("{scope}:commands:");
        let mut stmt=self.connection.prepare("SELECT c.scope,c.status,c.response,p.request FROM command_intents c JOIN command_payloads p USING(scope,id) WHERE c.id=?1 AND substr(c.scope,1,length(?2))=?2 LIMIT 2").map_err(sql)?;
        let rows=stmt.query_map(params![id,prefix],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?))).map_err(sql)?.collect::<rusqlite::Result<Vec<_>>>().map_err(sql)?;
        if rows.len()>1{return Err("下单编号存在账户冲突，请核对账户".into())}
        rows.into_iter().next().map(|(namespace,status,response,request)|Ok(json!({"namespace":namespace,"status":status,"raw":response.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(|_|"交易结果损坏")?,"request":serde_json::from_str::<Value>(&request).map_err(|_|"交易指令损坏")?}))).transpose()
    }
}

#[derive(Default)]
pub struct LocalStoreState(Mutex<Option<Store>>);
impl LocalStoreState{
    pub fn with<T>(&self,app:&tauri::AppHandle,work:impl FnOnce(&mut Store)->Result<T>)->Result<T>{
        let mut guard=self.0.lock().map_err(|_|"本地数据库正在恢复，请重启客户端")?;
        if guard.is_none(){let folder=app.path().app_data_dir().map_err(|_|"本地数据目录不可用")?;std::fs::create_dir_all(&folder).map_err(|_|"本地数据目录创建失败")?;*guard=Some(Store::open(&folder.join("desktop-state.sqlite3"))?)}
        work(guard.as_mut().ok_or("本地数据库不可用")?)
    }
}

#[tauri::command]
pub async fn desktop_db(app:tauri::AppHandle,state:tauri::State<'_,LocalStoreState>,scope:String,action:String,collection:Option<String>,id:Option<String>,value:Option<Value>)->Result<Value>{
    let collection=collection.unwrap_or_default();let id=id.unwrap_or_default();
    state.with(&app,|store|match action.as_str(){
        "list"=>Ok(json!(store.list(&scope,&collection)?)),
        "get"=>Ok(json!(store.get(&scope,&collection,&id)?)),
        "put"=>Ok(json!(store.put(&scope,&collection,&id,&value.ok_or("缺少记录内容")?)?)),
        "delete"=>Ok(json!(store.delete(&scope,&collection,&id)?)),
        "batch"=>{let rows:Vec<LocalMutation>=serde_json::from_value(value.ok_or("缺少批量记录")?).map_err(|_|"无效的批量记录")?;store.batch(&scope,&collection,&rows)?;Ok(json!({"ok":true}))},
        "pending"=>Ok(json!(store.pending(&scope)?)),
        "merge"=>{let records:Vec<RemoteRecord>=serde_json::from_value(value.ok_or("缺少同步记录")?).map_err(|_|"无效的同步记录")?;Ok(json!({"applied":store.merge(&scope,&records)?}))},
        "ack"=>{let value=value.ok_or("缺少同步确认")?;store.ack(&scope,&collection,&id,value["revision"].as_i64().ok_or("缺少本地版本")?,value["version"].as_str().ok_or("缺少服务器版本")?)?;Ok(json!({"ok":true}))},
        "conflicts"=>Ok(json!(store.conflicts(&scope)?)),
        "resolve"=>{store.resolve(&scope,&collection,&id,value.as_ref().and_then(|v|v.as_str()).ok_or("缺少冲突处理方式")?)?;Ok(json!({"ok":true}))},
        "status"=>Ok(json!({"pending":store.pending(&scope)?.len(),"conflicts":store.conflicts(&scope)?.len(),"sync":store.meta(&scope,"sync")?})),
        "sync-complete"=>{let value=value.ok_or("缺少同步状态")?;if value.to_string().len()>4096{return Err("同步状态过大".into())}store.set_meta(&scope,"sync",&value)?;Ok(json!({"ok":true}))},
        _=>Err("不支持的本地数据库操作".into())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persists_records_and_isolates_accounts_with_parameter_binding() {
        let path=std::env::temp_dir().join(format!("atd-local-{}-{}.sqlite3",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        {
            let mut store=Store::open(&path).unwrap();
            store.put("server:user-a","watchlist","x';DROP TABLE records;--",&json!({"symbol":"btcusdt"})).unwrap();
            store.put("server:user-b","watchlist","x",&json!({"symbol":"ethusdt"})).unwrap();
        }
        let mut store=Store::open(&path).unwrap();
        assert_eq!(store.list("server:user-a","watchlist").unwrap()[0].value["symbol"],"btcusdt");
        assert_eq!(store.list("server:user-b","watchlist").unwrap()[0].value["symbol"],"ethusdt");
        assert!(store.list("server:user-c","watchlist").unwrap().is_empty());
        drop(store);let _=std::fs::remove_file(path);
    }

    #[test]
    fn remote_changes_do_not_overwrite_dirty_records_and_ack_does_not_erase_new_edits() {
        let mut store=Store::memory().unwrap();
        store.merge("s:u",&[RemoteRecord{collection:"watchlist".into(),id:"1".into(),value:json!({"name":"base"}),version:"v1".into(),deleted:false}]).unwrap();
        let first=store.put("s:u","watchlist","1",&json!({"name":"mine"})).unwrap();
        store.merge("s:u",&[RemoteRecord{collection:"watchlist".into(),id:"1".into(),value:json!({"name":"theirs"}),version:"v2".into(),deleted:false}]).unwrap();
        assert_eq!(store.list("s:u","watchlist").unwrap()[0].value["name"],"mine");
        assert_eq!(store.conflicts("s:u").unwrap().len(),1);
        store.put("s:u","watchlist","1",&json!({"name":"new edit"})).unwrap();
        store.ack("s:u","watchlist","1",first.revision,"v3").unwrap();
        assert_eq!(store.pending("s:u").unwrap().len(),1);
    }

    #[test]
    fn batch_sort_rolls_back_all_rows_when_one_record_is_invalid(){
        let mut store=Store::memory().unwrap();
        store.put("s:u:live","watchlist","first",&json!({"sort_order":0})).unwrap();
        let changes=vec![LocalMutation{id:"first".into(),value:json!({"sort_order":2}),deleted:false},LocalMutation{id:"".into(),value:json!({"sort_order":3}),deleted:false}];
        assert!(store.batch("s:u:live","watchlist",&changes).is_err());
        assert_eq!(store.get("s:u:live","watchlist","first").unwrap().unwrap().value["sort_order"],0);
        assert!(store.list("s:u:virtual","watchlist").unwrap().is_empty());
    }

    #[test]
    fn credential_and_permission_import_rolls_back_together(){
        let mut store=Store::memory().unwrap();
        store.save_secret("s:u","okx-credentials",b"old").unwrap();
        store.connection.execute_batch("CREATE TRIGGER fail_permission BEFORE INSERT ON secure_blobs WHEN NEW.id='server-permission' BEGIN SELECT RAISE(ABORT,'interrupted import'); END;").unwrap();
        assert!(store.save_secrets("s:u",&[("okx-credentials",b"new"),("server-permission",b"grant")]).is_err());
        assert_eq!(store.secret("s:u","okx-credentials").unwrap().unwrap(),b"old");
        assert!(store.secret("s:u","server-permission").unwrap().is_none());
    }

    #[test]
    fn market_cache_batches_never_become_user_sync_mutations(){
        let mut store=Store::memory().unwrap();
        let row=LocalMutation{id:"BTC-USDT-SWAP".into(),value:json!({"ctVal":"0.01"}),deleted:false};
        store.cache_batch("s:u:account","instruments",&[row]).unwrap();
        assert!(store.pending("s:u:account").unwrap().is_empty());
        assert_eq!(store.list("s:u:account","instruments").unwrap().len(),1);
    }

    #[test]
    fn tombstones_are_synced_without_resurrecting_deleted_local_records() {
        let mut store=Store::memory().unwrap();
        store.merge("s:u",&[RemoteRecord{collection:"watchlist".into(),id:"1".into(),value:json!({"name":"base"}),version:"v1".into(),deleted:false}]).unwrap();
        store.delete("s:u","watchlist","1").unwrap();
        store.merge("s:u",&[RemoteRecord{collection:"watchlist".into(),id:"1".into(),value:json!({"name":"base"}),version:"v1".into(),deleted:false}]).unwrap();
        assert!(store.list("s:u","watchlist").unwrap().is_empty());
        let pending=store.pending("s:u").unwrap();
        assert!(pending[0].deleted);
        store.ack("s:u","watchlist","1",pending[0].revision,"v2").unwrap();
        assert!(store.pending("s:u").unwrap().is_empty());
    }

    #[test]
    fn a_bad_remote_batch_rolls_back_instead_of_partially_applying() {
        let mut store=Store::memory().unwrap();
        let good=RemoteRecord{collection:"watchlist".into(),id:"1".into(),value:json!({"name":"valid"}),version:"v1".into(),deleted:false};
        let bad=RemoteRecord{collection:"".into(),id:"2".into(),value:json!({}),version:"v1".into(),deleted:false};
        assert!(store.merge("s:u",&[good,bad]).is_err());
        assert!(store.list("s:u","watchlist").unwrap().is_empty());
    }

    #[test]
    fn persists_an_intent_before_submission_and_never_replays_unknown_or_changed_commands(){
        let mut store=Store::memory().unwrap();
        assert!(matches!(store.begin_intent("account:a","command1","hash-a").unwrap(),Intent::Fresh));
        assert!(matches!(store.begin_intent("account:a","command1","hash-a").unwrap(),Intent::Unknown));
        assert!(store.begin_intent("account:a","command1","different-hash").is_err());
        store.finish_intent("account:a","command1",Some(&json!({"order_id":"okx1"}))).unwrap();
        assert!(matches!(store.begin_intent("account:a","command1","hash-a").unwrap(),Intent::Known(_)));
        assert!(matches!(store.begin_intent("account:b","command1","hash-a").unwrap(),Intent::Fresh));
    }

    #[test]
    fn newer_database_versions_are_never_silently_downgraded(){
        let connection=Connection::open_in_memory().unwrap();
        connection.pragma_update(None,"user_version",99).unwrap();
        assert!(Store::init(connection).is_err());
    }

    #[test]
    fn command_payload_is_atomic_and_late_timeout_cannot_reopen_settlement(){
        let mut store=Store::memory().unwrap();
        store.connection.execute_batch("CREATE TRIGGER interrupt_payload BEFORE INSERT ON command_payloads BEGIN SELECT RAISE(ABORT,'interrupted'); END;").unwrap();
        assert!(store.begin_command("account:a","cmd","hash",&json!({"epoch":1})).is_err());
        assert!(store.unresolved_intents("account:a").unwrap().is_empty());
        store.connection.execute_batch("DROP TRIGGER interrupt_payload;").unwrap();
        assert!(matches!(store.begin_command("account:a","cmd","hash",&json!({"epoch":1})).unwrap(),Intent::Fresh));
        assert_eq!(store.unresolved_intents("account:a").unwrap()[0]["request"]["epoch"],1);
        store.reconcile_intent("account:a","cmd").unwrap();
        store.finish_intent("account:a","cmd",None).unwrap();
        assert!(store.unresolved_intents("account:a").unwrap().is_empty());
        assert!(matches!(store.begin_command("account:a","cmd","hash",&json!({"epoch":2})).unwrap(),Intent::Unknown));
        assert!(matches!(store.begin_intent("account:a","complete","hash").unwrap(),Intent::Fresh));
        store.finish_intent("account:a","complete",Some(&json!({"code":"0"}))).unwrap();
        store.finish_intent("account:a","complete",None).unwrap();
        assert!(matches!(store.begin_intent("account:a","complete","hash").unwrap(),Intent::Known(_)));
    }

    #[test]
    fn v1_upgrade_preserves_unresolved_commands_instead_of_assuming_they_were_not_sent(){
        let connection=Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE command_intents(scope TEXT NOT NULL,id TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,response TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(scope,id)); INSERT INTO command_intents VALUES('a','legacy','hash','unknown',NULL,1); PRAGMA user_version=1;").unwrap();
        let mut store=Store::init(connection).unwrap();
        let rows=store.unresolved_intents("a").unwrap();
        assert_eq!(rows.len(),1);assert_eq!(rows[0]["status"],"unknown");assert!(rows[0]["request"].is_null());
        assert!(matches!(store.begin_intent("a","legacy","hash").unwrap(),Intent::Unknown));
        let version:i64=store.connection.pragma_query_value(None,"user_version",|r|r.get(0)).unwrap();assert_eq!(version,2);
    }
    #[test]
    fn order_receipts_are_scoped_and_preserve_the_original_preparation(){
        let mut store=Store::memory().unwrap();
        let request=json!({"path":"/api/v5/trade/order","metadata":{"input":{"quantity":1},"spec":{"ctVal":"0.01"}}});
        store.begin_command("server:user-a:commands:account1","id","hash",&request).unwrap();
        store.finish_intent("server:user-a:commands:account1","id",Some(&json!({"data":[{"ordId":"123"}]}))).unwrap();
        assert!(store.order_command("server:user-b","id").unwrap().is_none());
        assert!(store.order_command("server:user","id").unwrap().is_none());
        let saved=store.order_command("server:user-a","id").unwrap().unwrap();
        assert_eq!(saved["status"],"complete");assert_eq!(saved["request"]["metadata"]["spec"]["ctVal"],"0.01");
        store.begin_command("server:user-a:commands:account2","id","hash",&request).unwrap();
        assert!(store.order_command("server:user-a","id").is_err());
    }

    #[test]
    fn interrupted_conflict_resolution_keeps_the_original_dirty_record(){
        let mut store=Store::memory().unwrap();
        store.put("s:u","settings","1",&json!({"name":"mine"})).unwrap();
        store.merge("s:u",&[RemoteRecord{collection:"settings".into(),id:"1".into(),value:json!({"name":"server"}),version:"v2".into(),deleted:false}]).unwrap();
        store.connection.execute_batch("CREATE TRIGGER fail_resolve BEFORE DELETE ON conflicts BEGIN SELECT RAISE(ABORT,'simulated interruption'); END;").unwrap();
        assert!(store.resolve("s:u","settings","1","server").is_err());
        let current=store.get("s:u","settings","1").unwrap().unwrap();
        assert_eq!(current.value["name"],"mine");assert!(current.dirty);
        assert_eq!(store.conflicts("s:u").unwrap().len(),1);
    }
}
