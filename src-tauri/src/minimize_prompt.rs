use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

#[derive(Default)]
struct PromptState(AtomicBool);

#[tauri::command]
pub fn desktop_set_minimize_prompt_ready(app: AppHandle, ready: bool) {
    if let Some(state) = app.try_state::<PromptState>() {
        state.0.store(ready, Ordering::Release);
    }
}

#[tauri::command]
pub fn desktop_minimize_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("主窗口不存在")?
        .minimize()
        .map_err(|e| e.to_string())
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.manage(PromptState::default());
    #[cfg(target_os = "windows")]
    windows_hook::install(app)?;
    Ok(())
}

#[cfg(target_os = "windows")]
mod windows_hook {
    use super::*;
    use tauri::Emitter;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{SC_MINIMIZE, WM_NCDESTROY, WM_SYSCOMMAND},
        },
    };

    const HOOK_ID: usize = 0x4359504c;

    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        let window = app
            .get_webview_window("main")
            .ok_or(tauri::Error::WindowNotFound)?;
        let hwnd = window.hwnd()?.0 as HWND;
        let data = Box::into_raw(Box::new(app.clone()));
        // setup runs on the window's owning thread, as required by comctl32.
        if unsafe { SetWindowSubclass(hwnd, Some(subclass), HOOK_ID, data as usize) } == 0 {
            unsafe {
                drop(Box::from_raw(data));
            }
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    unsafe extern "system" fn subclass(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        let app = &*(data as *const AppHandle);
        if message == WM_SYSCOMMAND && (wparam & 0xfff0) == SC_MINIMIZE as usize {
            // During startup / listener failure, retain normal Windows minimize.
            let ready = app
                .try_state::<PromptState>()
                .is_some_and(|s| s.0.load(Ordering::Acquire));
            if ready && app.emit("desktop-minimize-requested", ()).is_ok() {
                return 0;
            }
        }
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd, Some(subclass), id);
            drop(Box::from_raw(data as *mut AppHandle));
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }
}
