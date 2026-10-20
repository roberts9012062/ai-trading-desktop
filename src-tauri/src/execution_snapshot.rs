//! Read-only projection of a committed worker vault, never task authorization.
use rusqlite::{params,Connection,OpenFlags,OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{path::Path,time::Duration};
type Result<T>=std::result::Result<T,String>;

#[derive(Debug,Serialize)]
pub(crate) struct TaskRecord {
    id:String,name:String,symbol:String,timeframe:String,strategy_type:String,
    recorded_status:String,last_run_at:Option<String>,updated_at:Option<String>,
}
#[derive(Debug,Serialize)]
pub(crate) struct Snapshot {
    pub available:bool,pub tasks:Vec<TaskRecord>,pub checkpoint_seq:i64,
    pub pending_checkpoint:bool,pub truncated:bool,
}
impl Snapshot {pub fn absent()->Self{Self{available:false,tasks:vec![],checkpoint_seq:0,pending_checkpoint:false,truncated:false}}}

fn subject_hex(value:&str)->Result<String>{
    if value.len()!=32 && (value.len()!=36 || [8,13,18,23].iter().any(|i|value.as_bytes()[*i]!=b'-')){return Err("本机任务用户编号无效".into());}
    let raw=value.replace('-',"").to_ascii_lowercase();
    if raw.len()!=32 || !raw.bytes().all(|c|c.is_ascii_hexdigit()){return Err("本机任务用户编号无效".into());}
    Ok(raw)
}
fn canonical(value:&str)->Result<String>{let raw=subject_hex(value)?;Ok(format!("{}-{}-{}-{}-{}",&raw[..8],&raw[8..12],&raw[12..16],&raw[16..20],&raw[20..]))}

struct Vault {db:Connection,owner:String,checkpoint_seq:i64,pending_checkpoint:bool}
fn open_vault(path:&Path,subject:&str,account:&str)->Result<Option<Vault>>{
    let owner=subject_hex(subject)?;
    if account.len()!=64 || !account.bytes().all(|c|c.is_ascii_hexdigit() && !c.is_ascii_uppercase()){return Err("本机任务账户编号无效".into());}
    let meta=match std::fs::symlink_metadata(path){Ok(meta)=>meta,Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err("本机任务快照无法读取".into())};
    if !meta.is_file() || meta.file_type().is_symlink(){return Err("本机任务快照文件类型无效".into());}
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return Err("本机任务快照不能使用重解析点".into());}}
    let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|_|"本机任务数据库无法只读打开")?;
    db.busy_timeout(Duration::from_millis(250)).map_err(|_|"本机任务快照繁忙")?;
    db.execute_batch("PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;BEGIN;").map_err(|_|"本机任务快照初始化失败")?;
    let version:i64=db.pragma_query_value(None,"user_version",|row|row.get(0)).map_err(|_|"本机任务数据库版本不可读")?;
    if version!=1{return Err("本机任务数据库版本不兼容，请升级客户端".into());}
    let raw:String=db.query_row("SELECT value FROM executor_meta WHERE key='bootstrap' AND length(value)<=8192",[],|row|row.get(0)).map_err(|_|"本机任务尚未完成准备")?;
    let bootstrap:Value=serde_json::from_str(&raw).map_err(|_|"本机任务准备记录无效")?;
    if bootstrap["complete"]!=true || bootstrap["account_id"]!=account || bootstrap["subject"].as_str().and_then(|s|subject_hex(s).ok()).as_ref()!=Some(&owner){return Err("本机任务快照与当前账号不匹配".into());}
    let replica=db.query_row("SELECT json_extract(value,'$.subject'),json_extract(value,'$.account'),json_extract(value,'$.seq'),json_type(value,'$.pending') FROM executor_meta WHERE key='replication'",[],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,Option<String>>(3)?))).optional().map_err(|_|"本机任务检查点格式无效")?;
    let (checkpoint_seq,pending_checkpoint)=if let Some((replica_owner,replica_account,seq,pending))=replica{
        if subject_hex(&replica_owner)?!=owner || replica_account!=account || seq<0{return Err("本机检查点属于其他账户".into());}
        (seq,pending.is_some_and(|value|value!="null"))
    }else{(0,false)};
    Ok(Some(Vault{db,owner,checkpoint_seq,pending_checkpoint}))
}

pub(crate) fn read(path:&Path,subject:&str,account:&str)->Result<Snapshot>{
    let Some(vault)=open_vault(path,subject,account)? else{return Ok(Snapshot::absent())};
    let Vault{db,owner,checkpoint_seq,pending_checkpoint}=vault;
    let mut statement=db.prepare("SELECT id,substr(name,1,120),substr(symbol,1,20),substr(timeframe,1,8),substr(strategy_type,1,32),substr(status,1,16),substr(last_run_at,1,64),substr(updated_at,1,64) FROM ai_trading_tasks WHERE (user_id=?1 OR user_id=?2) AND trading_mode='live' AND strategy_type<>'multi_cycle_hunter' ORDER BY updated_at DESC,id LIMIT 501").map_err(|_|"本机任务表不可读")?;
    let rows=statement.query_map(params![owner,canonical(subject)?],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?,row.get::<_,Option<String>>(6)?,row.get::<_,Option<String>>(7)?))).map_err(|_|"本机任务读取失败")?;
    let mut tasks=Vec::new();let mut truncated=false;
    for row in rows{
        let (id,name,symbol,timeframe,strategy_type,status,last_run_at,updated_at)=row.map_err(|_|"本机任务记录无效")?;
        if tasks.len()==500{truncated=true;break;}
        let recorded_status=if ["running","paused","stopped"].contains(&status.as_str()){status}else{"unknown".into()};
        tasks.push(TaskRecord{id:canonical(&id)?,name,symbol,timeframe,strategy_type,recorded_status,last_run_at,updated_at});
    }
    Ok(Snapshot{available:true,tasks,checkpoint_seq,pending_checkpoint,truncated})
}

#[derive(Debug,Serialize)]
pub(crate) struct History {pub task_id:String,pub kind:String,pub offset:u32,pub has_more:bool,pub records:Vec<Value>}

pub(crate) fn read_history(path:&Path,subject:&str,account:&str,task:&str,kind:&str,offset:u32)->Result<History>{
    if offset>10000{return Err("本机历史页码超出范围".into())}
    // Table/column names are fixed in code; no client-provided SQL is accepted.
    let (table,fields,time)=match kind {
        "decisions"=>("ai_trading_decisions",vec!["id","created_at","trigger_type","action","reason"],"created_at"),
        "logs"=>("ai_trading_run_logs",vec!["id","created_at","event","action","reason"],"created_at"),
        "equity"=>("ai_trading_equity_points",vec!["id","ts","equity","realized_pnl","unrealized_pnl"],"ts"),
        _=>return Err("不支持的本机历史类型".into()),
    };
    let task_id=canonical(task)?;let task_hex=subject_hex(task)?;
    let vault=open_vault(path,subject,account)?.ok_or("尚无本机任务历史，请先同步准备数据")?;
    let db=&vault.db;
    let owned:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM ai_trading_tasks WHERE (id=?1 OR id=?2) AND (user_id=?3 OR user_id=?4) AND trading_mode='live' AND strategy_type<>'multi_cycle_hunter')",params![task_hex,task_id,vault.owner,canonical(subject)?],|row|row.get(0)).map_err(|_|"本机历史任务不可读")?;
    if !owned{return Err("本机历史任务不存在或不属于当前账号".into())}
    let columns=fields.iter().map(|field|format!("substr(CAST({field} AS TEXT),1,{})",if *field=="reason"{2000}else{128})).collect::<Vec<_>>().join(",");
    let sql=format!("SELECT {columns} FROM {table} WHERE (task_id=?1 OR task_id=?2) AND (user_id=?3 OR user_id=?4) ORDER BY {time} DESC,id DESC LIMIT 51 OFFSET ?5");
    let mut statement=db.prepare(&sql).map_err(|_|"本机历史记录尚不可读，请完成首次同步")?;
    let rows=statement.query_map(params![task_hex,task_id,vault.owner,canonical(subject)?,offset],|row|{
        let mut record=serde_json::Map::new();
        for (index,name) in fields.iter().enumerate(){record.insert((*name).into(),serde_json::json!(row.get::<_,Option<String>>(index)?));}
        Ok(Value::Object(record))
    }).map_err(|_|"本机历史读取失败")?;
    let mut records=Vec::new();let mut has_more=false;
    for row in rows{
        let mut row=row.map_err(|_|"本机历史记录格式无效")?;
        if records.len()==50{has_more=true;break}
        row["id"]=serde_json::json!(canonical(row["id"].as_str().ok_or("本机历史编号无效")?)?);
        records.push(row);
    }
    Ok(History{task_id,kind:kind.into(),offset,has_more,records})
}

#[cfg(test)]
mod tests {
    use super::*;
    const USER:&str="11111111-1111-1111-1111-111111111111";
    static FIXTURE_SEQUENCE:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
    fn fixture(run:impl FnOnce(&Path,&Connection)){
        // Windows wall-clock resolution can repeat across parallel tests.
        let sequence=FIXTURE_SEQUENCE.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
        let path=std::env::temp_dir().join(format!("executor-snapshot-{}-{}-{sequence}.db",std::process::id(),time::OffsetDateTime::now_utc().unix_timestamp_nanos()));
        let db=Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL;PRAGMA user_version=1;
          CREATE TABLE executor_meta(key TEXT PRIMARY KEY,value JSON NOT NULL);
          CREATE TABLE ai_trading_tasks(id TEXT PRIMARY KEY,user_id TEXT,trading_mode TEXT,name TEXT,symbol TEXT,timeframe TEXT,strategy_type TEXT,status TEXT,last_run_at TEXT,updated_at TEXT,custom_prompt TEXT);").unwrap();
        db.execute("INSERT INTO executor_meta VALUES('bootstrap',?1)",[serde_json::json!({"complete":true,"subject":USER,"account_id":"a".repeat(64)}).to_string()]).unwrap();
        db.execute("INSERT INTO executor_meta VALUES('replication',?1)",[serde_json::json!({"subject":USER,"account":"a".repeat(64),"seq":7,"pending":null,"hashes":{}}).to_string()]).unwrap();
        db.execute("INSERT INTO ai_trading_tasks VALUES(?1,?2,'live','My quant','btcusdt','1m','ma_cross','running',NULL,'2026-10-20T00:00:00','never-export-private-prompt')",params!["22222222222222222222222222222222",USER.replace('-',"")]).unwrap();
        run(&path,&db);drop(db);
        for suffix in ["","-wal","-shm"]{let file=std::path::PathBuf::from(format!("{}{suffix}",path.display()));if file.exists(){std::fs::remove_file(file).unwrap();}}
    }
    #[test]
    fn only_own_live_non_deferred_tasks_are_projected_without_secrets(){fixture(|path,db|{
        for (id,user,mode,strategy) in [("33333333333333333333333333333333",USER.replace('-',""),"live","multi_cycle_hunter"),("44444444444444444444444444444444",USER.replace('-',""),"virtual","ai"),("55555555555555555555555555555555","99999999999999999999999999999999".into(),"live","ai")]{
            db.execute("INSERT INTO ai_trading_tasks VALUES(?1,?2,?3,'hidden','ethusdt','1m',?4,'running',NULL,NULL,'private')",params![id,user,mode,strategy]).unwrap();
        }
        let snapshot=read(path,USER,&"a".repeat(64)).unwrap();
        assert!(snapshot.available);assert_eq!(snapshot.tasks.len(),1);assert_eq!(snapshot.checkpoint_seq,7);
        assert_eq!(snapshot.tasks[0].id,"22222222-2222-2222-2222-222222222222");
        let raw=serde_json::to_string(&snapshot).unwrap();
        assert!(raw.contains("recorded_status"));assert!(!raw.contains("private"));assert!(!raw.contains("custom_prompt"));
    });}
    #[test]
    fn uncommitted_rows_are_invisible_and_reader_does_not_write(){fixture(|path,db|{
        db.execute_batch("BEGIN IMMEDIATE;UPDATE ai_trading_tasks SET status='stopped';").unwrap();
        assert_eq!(read(path,USER,&"a".repeat(64)).unwrap().tasks[0].recorded_status,"running");
        db.execute_batch("ROLLBACK;").unwrap();
        db.execute_batch("BEGIN IMMEDIATE;UPDATE ai_trading_tasks SET status='paused';COMMIT;").unwrap();
        assert_eq!(read(path,USER,&"a".repeat(64)).unwrap().tasks[0].recorded_status,"paused");
        let reader=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(reader.execute("DELETE FROM ai_trading_tasks",[]).is_err());
    });}
    #[test]
    fn missing_unknown_or_wrong_owner_vault_cannot_supply_task_status(){
        let missing=std::env::temp_dir().join(format!("missing-executor-snapshot-{}.db",std::process::id()));
        assert!(!missing.exists());assert!(!read(&missing,USER,&"a".repeat(64)).unwrap().available);assert!(!missing.exists());
        fixture(|path,db|{
            assert!(read(path,"99999999-9999-9999-9999-999999999999",&"a".repeat(64)).is_err());
            assert!(read(path,USER,&"b".repeat(64)).is_err());
            db.execute("UPDATE executor_meta SET value=json_set(value,'$.complete',json('false')) WHERE key='bootstrap'",[]).unwrap();
            assert!(read(path,USER,&"a".repeat(64)).is_err());
            db.execute_batch("PRAGMA user_version=2").unwrap();assert!(read(path,USER,&"a".repeat(64)).is_err());
        });
    }
    #[test]
    fn snapshot_is_bounded_and_rejects_a_foreign_replication_owner(){fixture(|path,db|{
        db.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<502) INSERT INTO ai_trading_tasks SELECT printf('%032x',x),?1,'live','quant','btcusdt','1m','ma_cross','stopped',NULL,NULL,NULL FROM n",[USER.replace('-',"")]).unwrap();
        let snapshot=read(path,USER,&"a".repeat(64)).unwrap();
        assert!(snapshot.truncated);assert_eq!(snapshot.tasks.len(),500);
        db.execute("UPDATE executor_meta SET value=json_set(value,'$.subject',?1) WHERE key='replication'",["99999999-9999-9999-9999-999999999999"]).unwrap();
        assert!(read(path,USER,&"a".repeat(64)).is_err());
    });}

    #[test]
    fn history_is_task_scoped_bounded_and_never_exports_raw_model_context(){fixture(|path,db|{
        db.execute_batch("CREATE TABLE ai_trading_decisions(id TEXT,task_id TEXT,user_id TEXT,created_at TEXT,trigger_type TEXT,action TEXT,reason TEXT,model_output TEXT);
          WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<52) INSERT INTO ai_trading_decisions SELECT printf('%032x',x),'22222222222222222222222222222222','11111111111111111111111111111111','2026-10-20','bar','hold','recorded reason','private model context' FROM n;").unwrap();
        let page=read_history(path,USER,&"a".repeat(64),"22222222-2222-2222-2222-222222222222","decisions",0).unwrap();
        assert_eq!(page.records.len(),50);assert!(page.has_more);
        let raw=serde_json::to_string(&page).unwrap();assert!(!raw.contains("model_output"));assert!(!raw.contains("private model context"));
        let next=read_history(path,USER,&"a".repeat(64),"22222222-2222-2222-2222-222222222222","decisions",50).unwrap();
        assert_eq!(next.records.len(),2);assert!(!next.has_more);
        assert!(read_history(path,USER,&"a".repeat(64),"22222222-2222-2222-2222-222222222222","other_table",0).is_err());
        assert!(read_history(path,USER,&"a".repeat(64),"22222222-2222-2222-2222-222222222222","decisions",10001).is_err());
        db.execute("UPDATE ai_trading_tasks SET user_id='99999999999999999999999999999999'",[]).unwrap();
        assert!(read_history(path,USER,&"a".repeat(64),"22222222-2222-2222-2222-222222222222","decisions",0).is_err());
    });}

    #[test]
    fn history_rejects_foreign_rows_hidden_tasks_and_uncommitted_changes(){fixture(|path,db|{
        db.execute_batch("CREATE TABLE ai_trading_run_logs(id TEXT,task_id TEXT,user_id TEXT,created_at TEXT,event TEXT,action TEXT,reason TEXT);
          INSERT INTO ai_trading_run_logs VALUES('33333333333333333333333333333333','22222222222222222222222222222222','99999999999999999999999999999999','2026-10-20','error','','foreign');
          INSERT INTO ai_trading_run_logs VALUES('44444444444444444444444444444444','22222222222222222222222222222222','11111111111111111111111111111111','2026-10-20','signal','hold','committed');").unwrap();
        db.execute_batch("BEGIN IMMEDIATE;UPDATE ai_trading_run_logs SET reason='uncommitted';").unwrap();
        let page=read_history(path,USER,&"a".repeat(64),"22222222-2222-2222-2222-222222222222","logs",0).unwrap();
        assert_eq!(page.records.len(),1);assert_eq!(page.records[0]["reason"],"committed");
        db.execute_batch("ROLLBACK;UPDATE ai_trading_tasks SET strategy_type='multi_cycle_hunter';").unwrap();
        assert!(read_history(path,USER,&"a".repeat(64),"22222222-2222-2222-2222-222222222222","logs",0).is_err());
    });}
    #[test]
    fn local_equity_keeps_stored_numbers_and_a_bad_binding_cannot_read_history(){fixture(|path,db|{
        db.execute_batch("CREATE TABLE ai_trading_equity_points(id TEXT,task_id TEXT,user_id TEXT,ts TEXT,equity NUMERIC,realized_pnl NUMERIC,unrealized_pnl NUMERIC);
          INSERT INTO ai_trading_equity_points VALUES('33333333333333333333333333333333','22222222222222222222222222222222','11111111111111111111111111111111','2026-10-20',123.45,-2.5,3.75);").unwrap();
        let page=read_history(path,USER,&"a".repeat(64),"22222222-2222-2222-2222-222222222222","equity",0).unwrap();
        assert_eq!(page.records[0]["equity"],"123.45");assert_eq!(page.records[0]["realized_pnl"],"-2.5");
        assert!(read_history(path,USER,&"b".repeat(64),"22222222-2222-2222-2222-222222222222","equity",0).is_err());
        assert!(read_history(path,USER,&"a".repeat(64),"' OR 1=1 --","equity",0).is_err());
    });}
}
