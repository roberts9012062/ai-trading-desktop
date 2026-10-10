//! Export writes are limited to a path explicitly selected in a native save dialog.
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

fn suggested_name(name: &str) -> Result<(String, String), String> {
    if name.is_empty()
        || name.len() > 640
        || name
            .chars()
            .any(|c| c.is_control() || "\\/<>:\"|?*".contains(c))
    {
        return Err("导出文件名无效".into());
    }
    let extension = std::path::Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("json")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "json" | "csv") {
        return Err("仅支持导出 JSON 或 CSV 文件".into());
    }
    let name = if std::path::Path::new(name).extension().is_none() {
        format!("{name}.json")
    } else {
        name.to_string()
    };
    Ok((name, extension))
}

fn write_selected_export(
    path: Option<PathBuf>,
    data: &[u8],
    extension: &str,
) -> Result<Option<String>, String> {
    let Some(mut path) = path else {
        return Ok(None);
    };
    if data.is_empty() || data.len() > MAX_EXPORT_BYTES {
        return Err("导出文件为空或超过 32 MB".into());
    }
    if path.extension().is_none() {
        path.set_extension(extension);
    }
    if path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        != Some(extension.to_string())
    {
        return Err(format!("请保存为 .{extension} 文件"));
    }
    use std::io::Write;
    let mut file = std::fs::File::create(&path).map_err(|e| format!("保存文件失败：{e}"))?;
    file.write_all(data)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("保存文件失败：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn desktop_save_export(
    window: tauri::WebviewWindow,
    file_name: String,
    data: Vec<u8>,
) -> Result<Option<String>, String> {
    if data.is_empty() || data.len() > MAX_EXPORT_BYTES {
        return Err("导出文件为空或超过 32 MB".into());
    }
    let (name, extension) = suggested_name(&file_name)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("导出文件 — 选择保存位置")
        .set_file_name(name)
        .add_filter(extension.to_uppercase(), &[&extension])
        .save_file(move |path| {
            let _ = send.send(path);
        });
    let path = receive
        .await
        .map_err(|_| "保存窗口已关闭，请重试".to_string())?
        .map(|p| {
            p.into_path()
                .map_err(|_| "无法使用所选保存位置".to_string())
        })
        .transpose()?;
    tauri::async_runtime::spawn_blocking(move || write_selected_export(path, &data, &extension))
        .await
        .map_err(|_| "保存文件失败，请重试".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_never_reports_success_or_writes() {
        assert_eq!(
            write_selected_export(None, b"configuration", "json").unwrap(),
            None
        );
    }
    #[test]
    fn prevents_paths_and_executable_file_names() {
        for name in ["../task.json", "C:\\task.json", "task.exe", "task.json\0"] {
            assert!(suggested_name(name).is_err());
        }
        assert_eq!(
            suggested_name("任务.json").unwrap(),
            ("任务.json".into(), "json".into())
        );
    }
    #[test]
    fn writes_exact_utf8_bytes_and_returns_the_selected_path() {
        let path = std::env::temp_dir().join(format!(
            "cyclepilot-export-test-{}.json",
            std::process::id()
        ));
        let data = "{\"任务\":\"雪崩-15分钟\",\"leverage\":7}".as_bytes();
        let result = write_selected_export(Some(path.clone()), data, "json").unwrap();
        assert_eq!(result, Some(path.to_string_lossy().into_owned()));
        assert_eq!(std::fs::read(&path).unwrap(), data);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn refuses_invalid_destination_or_empty_data_before_creating_a_file() {
        assert!(write_selected_export(Some(PathBuf::from("invalid.exe")), b"{}", "json").is_err());
        assert!(write_selected_export(Some(PathBuf::from("empty.json")), b"", "json").is_err());
    }
}
