//! Server login keys are bound to a canonical origin and protected by this OS user.
use crate::local_store::{LocalStoreState, Store};
use zeroize::Zeroizing;

fn namespace(raw: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "服务器地址无效")?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if raw.len() > 512
        || url.origin().ascii_serialization() != raw
        || (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("请使用不含账号或参数的可信服务器地址".into());
    }
    Ok(format!("taskhost-login-v1:{raw}"))
}
fn valid_key(key: &str) -> bool {
    key.len() == 47
        && key.starts_with("thk_")
        && key.as_bytes()[4..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}
fn apply(
    store: &mut Store,
    origin: &str,
    action: &str,
    key: &str,
) -> Result<Option<String>, String> {
    let scope = namespace(origin)?;
    match action {
        "read" => store
            .secret(&scope, "key")?
            .map(|sealed| {
                let plain = Zeroizing::new(crate::market_data::protect(
                    &sealed,
                    scope.as_bytes(),
                    false,
                )?);
                let value =
                    String::from_utf8(plain.to_vec()).map_err(|_| "保存的登录密钥无法读取")?;
                if !valid_key(&value) {
                    return Err("保存的登录密钥格式无效".into());
                }
                Ok(value)
            })
            .transpose(),
        "save" => {
            if !valid_key(key) {
                return Err("请填写完整登录密钥".into());
            }
            let sealed = crate::market_data::protect(key.as_bytes(), scope.as_bytes(), true)?;
            store.save_secret(&scope, "key", &sealed)?;
            Ok(None)
        }
        "clear" => {
            store.remove_secret(&scope, "key")?;
            Ok(None)
        }
        _ => Err("不支持的登录密钥操作".into()),
    }
}
#[tauri::command]
pub fn desktop_saved_host_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalStoreState>,
    origin: String,
    action: String,
    key: Option<String>,
) -> Result<Option<String>, String> {
    let key = Zeroizing::new(key.unwrap_or_default());
    state
        .with(&app, |store| apply(store, &origin, &action, &key))
        .map_err(|_| "登录密钥安全存储操作未完成，请重新填写或检查本机数据目录".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_or_ambiguous_origins_without_reading_other_servers() {
        for raw in [
            "http://remote.example",
            "https://user:pass@host.example",
            "https://host.example/?key=secret",
            "https://host.example/#x",
            "https://host.example/path",
            "https://host.example/",
        ] {
            assert!(namespace(raw).is_err());
        }
        assert!(namespace("http://127.0.0.1:8788").is_ok());
        assert!(namespace("https://host.example").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn encrypts_reopens_replaces_and_clears_keys_without_plaintext_or_cross_origin_reads() {
        let mut db = Store::memory().unwrap();
        let old = format!("thk_{}", "a".repeat(43));
        let new = format!("thk_{}", "b".repeat(43));
        let origin = "https://fixture.example";
        apply(&mut db, origin, "save", &old).unwrap();
        let sealed = db
            .secret(&namespace(origin).unwrap(), "key")
            .unwrap()
            .unwrap();
        assert!(!sealed.windows(old.len()).any(|b| b == old.as_bytes()));
        assert_eq!(
            apply(&mut db, origin, "read", "").unwrap(),
            Some(old.clone())
        );
        assert_eq!(
            apply(&mut db, "https://another.example", "read", "").unwrap(),
            None
        );
        assert!(apply(&mut db, origin, "save", "invalid").is_err());
        assert_eq!(apply(&mut db, origin, "read", "").unwrap(), Some(old));
        apply(&mut db, origin, "save", &new).unwrap();
        assert_eq!(apply(&mut db, origin, "read", "").unwrap(), Some(new));
        apply(&mut db, origin, "clear", "").unwrap();
        assert_eq!(apply(&mut db, origin, "read", "").unwrap(), None);
    }
}
