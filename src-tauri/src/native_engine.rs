use serde::Serialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

// Windows 内核级兜底:把引擎子进程挂入 kill-on-close 的 Job Object。
// 主进程无论正常退出、崩溃还是被更新器 taskkill 强杀,内核关闭其持有的
// 全部句柄时都会自动终结 job 内的引擎进程,根治"孤儿 python 进程锁住
// native-engine DLL 导致更新安装失败"的问题。
#[cfg(windows)]
mod win_job {
    use std::os::windows::io::RawHandle;

    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;

    /// IO_COUNTERS(x64 布局,全零即可)
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    /// JOBOBJECT_BASIC_LIMIT_INFORMATION(x64 布局)
    #[repr(C)]
    #[derive(Default)]
    struct JobBasicLimit {
        per_process_user_time: u64,
        per_job_user_time: u64,
        min_working_set: u32,
        max_working_set: u32,
        active_process_limit: u32,
        limit_flags: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION(x64 布局)
    #[repr(C)]
    #[derive(Default)]
    struct JobExtendedLimit {
        basic: JobBasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> RawHandle;
        fn SetInformationJobObject(
            job: RawHandle,
            class: u32,
            info: *mut core::ffi::c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: RawHandle, process: RawHandle) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
        fn CloseHandle(handle: RawHandle) -> i32;
    }

    /// 裸句柄的安全包装:RawHandle(*mut c_void)不含 Send/Sync,而句柄本质是
    /// 整数值且此处仅存储与关闭、绝不解引用,标记跨线程传递是安全的
    #[derive(Clone, Copy)]
    pub struct JobHandle(RawHandle);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    /// 把 pid 对应进程挂入 kill-on-close job;返回调用方需长期持有的 job 句柄
    /// (主进程存活期间不得关闭,否则内核会立刻终结引擎)。
    pub fn attach_kill_on_close(pid: u32) -> Option<JobHandle> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info = JobExtendedLimit::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let process = OpenProcess(PROCESS_SET_QUOTA, 0, pid);
            let ok = !process.is_null()
                && SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &mut info as *mut JobExtendedLimit as *mut core::ffi::c_void,
                    std::mem::size_of::<JobExtendedLimit>() as u32,
                ) != 0
                && AssignProcessToJobObject(job, process) != 0;
            if !process.is_null() {
                CloseHandle(process);
            }
            if ok {
                Some(JobHandle(job))
            } else {
                CloseHandle(job);
                None
            }
        }
    }

    /// 关闭 job 句柄:句柄全关后内核按 kill-on-close 终结 job 内进程
    pub fn close(handle: JobHandle) {
        unsafe {
            CloseHandle(handle.0);
        }
    }
}

#[derive(Clone, Serialize)]
pub struct NativeEndpoint {
    port: u16,
    token: String,
    pid: u32,
    hello: Value,
}

#[derive(Default)]
struct Managed {
    child: Option<CommandChild>,
    /// 引擎进程所在 kill-on-close job 的句柄;主进程死亡时由内核自动终结引擎
    #[cfg(windows)]
    job: Option<win_job::JobHandle>,
    endpoint: Option<NativeEndpoint>,
    starting: bool,
    epoch: u64,
    precision: Option<String>,
    reason: Option<String>,
}

/// 引擎退出时待释放的资源集合(child 显式终结;job 句柄在 kill 之后关闭,
/// 关闭即触发内核 kill-on-close 兜底)
struct RetiredEngine {
    child: Option<CommandChild>,
    #[cfg(windows)]
    job: Option<win_job::JobHandle>,
}

impl Managed {
    /// 退出当前引擎,取出待释放资源;epoch 不匹配时不动作(保护新启动)
    fn retire(
        &mut self,
        expected_epoch: Option<u64>,
        reason: Option<String>,
    ) -> RetiredEngine {
        let mut retired = RetiredEngine {
            child: None,
            #[cfg(windows)]
            job: None,
        };
        if expected_epoch.is_some_and(|epoch| epoch != self.epoch) {
            return retired;
        }
        self.epoch += 1;
        self.starting = false;
        self.endpoint = None;
        self.precision = None;
        self.reason = reason;
        retired.child = self.child.take();
        #[cfg(windows)]
        {
            retired.job = self.job.take();
        }
        retired
    }
}

#[derive(Default)]
pub struct NativeEngineState(Mutex<Managed>);

fn validate_precision(value: &str) -> Result<(), String> {
    if matches!(value, "mixed" | "f64") {
        Ok(())
    } else {
        Err("Invalid native precision".into())
    }
}

fn parse_ready(line: &str, pid: u32) -> Result<Option<NativeEndpoint>, String> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Ok(None);
    };
    if value["type"] != "native_engine_ready" {
        return Ok(None);
    }
    let port = value["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .ok_or("Invalid native handshake port")?;
    let token = value["token"]
        .as_str()
        .filter(|s| s.len() >= 32)
        .ok_or("Invalid native handshake token")?;
    let hello = &value["hello"];
    if hello["backend"] != "cuda"
        || hello["fp64_supported"] != true
        || hello["selfcheck"]["passed"] != true
        || hello["selfcheck"]["token_count"] != 20
        || hello["selfcheck"]["eval_precision"] != "f64"
        || hello["selfcheck"]["features_passed"] != true
        || hello["selfcheck"]["reports_passed"] != true
        || hello["selfcheck"]["selection_passed"] != true
        || hello["selfcheck"]["portfolio_passed"] != true
        || (hello["precision"] == "mixed" && hello["selfcheck"]["coarse_passed"] != true)
        || !hello["engine_version"]
            .as_str()
            .is_some_and(|s| s == include_str!("../../native-engine/VERSION").trim())
    {
        return Err("Native CUDA capabilities / G1 selfcheck failed".into());
    }
    Ok(Some(NativeEndpoint {
        port,
        token: token.into(),
        pid,
        hello: hello.clone(),
    }))
}

fn runtime_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("Invalid development root")?
            .to_path_buf();
        Ok((
            root.join(".local-data/native-engine-venv/Scripts/python.exe"),
            root.join("native-engine"),
        ))
    }
    #[cfg(not(debug_assertions))]
    {
        let root = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("native-engine");
        Ok((root.join("python/python.exe"), root))
    }
}

pub fn shutdown(app: &tauri::AppHandle) -> Result<(), String> {
    shutdown_epoch(app, None, None)
}

fn shutdown_epoch(
    app: &tauri::AppHandle,
    expected_epoch: Option<u64>,
    reason: Option<String>,
) -> Result<(), String> {
    let state = app.state::<NativeEngineState>();
    let retired = {
        let mut managed = state.0.lock().map_err(|_| "Native engine state poisoned")?;
        managed.retire(expected_epoch, reason)
    };
    if let Some(child) = retired.child {
        // 显式终结;即便失败(如进程已自行退出)也无妨,下方 job 关闭会触发
        // 内核 kill-on-close 兜底
        let _ = child.kill();
    }
    #[cfg(windows)]
    if let Some(job) = retired.job {
        win_job::close(job);
    }
    Ok(())
}

#[tauri::command]
pub async fn native_engine_spawn(
    app: tauri::AppHandle,
    precision: String,
) -> Result<NativeEndpoint, String> {
    validate_precision(&precision)?;
    let epoch = {
        let state = app.state::<NativeEngineState>();
        let mut managed = state.0.lock().map_err(|_| "Native engine state poisoned")?;
        if let Some(endpoint) = &managed.endpoint {
            if managed.precision.as_deref() == Some(&precision) {
                return Ok(endpoint.clone());
            }
            return Err("原生引擎正在使用另一精度模式，请先结束当前任务".into());
        }
        if managed.starting {
            return Err("原生引擎正在启动".into());
        }
        managed.epoch += 1;
        managed.starting = true;
        managed.reason = None;
        managed.precision = Some(precision.clone());
        managed.epoch
    };
    let result = spawn_process(app.clone(), precision, epoch).await;
    if let Err(reason) = &result {
        // A cancelled/failed old launch must never kill a newer launch.
        let _ = shutdown_epoch(&app, Some(epoch), Some(reason.clone()));
    }
    result
}

async fn spawn_process(
    app: tauri::AppHandle,
    precision: String,
    epoch: u64,
) -> Result<NativeEndpoint, String> {
    let (python, root) = runtime_paths(&app)?;
    if !python.is_file() || !root.join("engine/__main__.py").is_file() {
        return Err("原生引擎运行时未安装；开发环境请按 M1 文档安装 CPython 3.11 依赖".into());
    }
    let paths = std::env::join_paths([root.clone(), root.join("site-packages")])
        .map_err(|e| e.to_string())?;
    let (mut events, child) = app
        .shell()
        .command(python)
        .args(["-u", "-m", "engine", "--precision", &precision])
        .env("PYTHONPATH", paths)
        .env("PYTHONNOUSERSITE", "1")
        .current_dir(&root)
        .spawn()
        .map_err(|e| e.to_string())?;
    let pid = child.pid();
    // 引擎一旦 spawn 就立即挂入 kill-on-close job:此后无论主进程因何退出,
    // 内核都会回收该进程(窗口 Destroyed 清理路径只是第一道防线)
    #[cfg(windows)]
    let job = win_job::attach_kill_on_close(pid);
    {
        let state = app.state::<NativeEngineState>();
        let mut managed = state.0.lock().map_err(|_| "Native engine state poisoned")?;
        if managed.epoch != epoch {
            let _ = child.kill();
            #[cfg(windows)]
            if let Some(job) = job {
                win_job::close(job);
            }
            return Err("原生引擎启动已取消".into());
        }
        managed.child = Some(child);
        #[cfg(windows)]
        {
            managed.job = job;
        }
    }
    let (tx, rx) = mpsc::channel();
    tauri::async_runtime::spawn(async move {
        let mut tx = Some(tx);
        let mut last_error = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    match parse_ready(&line, pid) {
                        Ok(Some(endpoint)) => {
                            let state = app.state::<NativeEngineState>();
                            if let Ok(mut managed) = state.0.lock() {
                                if managed.epoch == epoch {
                                    managed.starting = false;
                                    managed.endpoint = Some(endpoint.clone());
                                    if let Some(tx) = tx.take() {
                                        let _ = tx.send(Ok(endpoint));
                                    }
                                }
                            };
                        }
                        Err(error) => {
                            if let Some(tx) = tx.take() {
                                let _ = tx.send(Err(error));
                            }
                        }
                        Ok(None) => {} // Taichi logs are never interpreted as a ready handshake.
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                        if value["type"] == "native_engine_error" {
                            last_error =
                                value["message"].as_str().unwrap_or("Startup failed").into();
                        }
                    }
                }
                CommandEvent::Error(reason) => {
                    last_error = reason;
                }
                CommandEvent::Terminated(payload) => {
                    let reason = if last_error.is_empty() {
                        format!("原生引擎进程退出（{:?}）", payload.code)
                    } else {
                        last_error.clone()
                    };
                    let state = app.state::<NativeEngineState>();
                    if let Ok(mut managed) = state.0.lock() {
                        if managed.epoch == epoch {
                            managed.child = None;
                            managed.endpoint = None;
                            managed.starting = false;
                            managed.reason = Some(reason.clone());
                            // 引擎已自行退出:关闭其 job 句柄(job 内已无进程,无副作用)
                            #[cfg(windows)]
                            if let Some(job) = managed.job.take() {
                                win_job::close(job);
                            }
                        }
                    }
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(Err(reason.clone()));
                    }
                    let _ = app.emit(
                        "native-engine-exited",
                        serde_json::json!({"pid":pid,"reason":reason}),
                    );
                    break;
                }
                _ => {}
            }
        }
    });
    // Full deterministic CUDA startup includes cold JIT: measured at 213s (mixed)
    // and ~270-300s (f64 strict mode, 2026-09-29 real install), so the deadline
    // must leave headroom for f64 on busy machines before any kill/re-JIT retry.
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(480)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "原生引擎启动握手超时".to_string())?
}

#[tauri::command]
pub fn native_engine_status(app: tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<NativeEngineState>();
    let managed = state.0.lock().map_err(|_| "Native engine state poisoned")?;
    Ok(
        serde_json::json!({"running":managed.child.is_some(),"ready":managed.endpoint.is_some(),
        "starting":managed.starting,"pid":managed.child.as_ref().map(CommandChild::pid),"reason":managed.reason}),
    )
}

#[tauri::command]
pub fn native_engine_kill(app: tauri::AppHandle) -> Result<(), String> {
    shutdown(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> serde_json::Value {
        serde_json::json!({"type":"native_engine_ready", "port":12345, "token":"a".repeat(32),
          "hello":{"engine_version":include_str!("../../native-engine/VERSION").trim(), "backend":"cuda", "fp64_supported":true,
                   "precision":"f64", "selfcheck":{"passed":true,"token_count":20,"eval_precision":"f64",
                     "features_passed":true,"reports_passed":true,"selection_passed":true,"portfolio_passed":true}}})
    }

    #[test]
    fn only_selfchecked_cuda_may_be_ready() {
        assert!(parse_ready(&ready().to_string(), 99).unwrap().is_some());
        for field in ["backend", "fp64_supported", "selfcheck"] {
            let mut value = ready();
            value["hello"][field] = serde_json::Value::Null;
            assert!(parse_ready(&value.to_string(), 99).is_err());
        }
        let mut value = ready();
        value["port"] = serde_json::json!(0);
        assert!(parse_ready(&value.to_string(), 99).is_err());
        assert!(parse_ready("[Taichi] startup log", 99).unwrap().is_none());
        let mut value = ready();
        value["hello"]["precision"] = serde_json::json!("mixed");
        assert!(parse_ready(&value.to_string(), 99).is_err());
        value["hello"]["selfcheck"]["coarse_passed"] = serde_json::json!(true);
        assert!(parse_ready(&value.to_string(), 99).unwrap().is_some());
    }

    #[test]
    fn precision_is_an_enum_not_command_text() {
        assert!(validate_precision("mixed").is_ok());
        assert!(validate_precision("f64").is_ok());
        assert!(validate_precision("f64 --inject-selfcheck-failure").is_err());
    }

    #[test]
    fn stale_shutdown_cannot_retire_a_newer_launch() {
        let mut managed = Managed {
            epoch: 2,
            starting: true,
            precision: Some("mixed".into()),
            ..Managed::default()
        };
        managed.retire(Some(1), Some("old launch failed".into()));
        assert_eq!(managed.epoch, 2);
        assert!(managed.starting);
        assert_eq!(managed.precision.as_deref(), Some("mixed"));
        assert!(managed.reason.is_none());
        managed.retire(Some(2), Some("current launch failed".into()));
        assert_eq!(managed.epoch, 3);
        assert!(!managed.starting);
        assert_eq!(managed.reason.as_deref(), Some("current launch failed"));
    }
}
