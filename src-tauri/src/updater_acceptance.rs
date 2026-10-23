//! Release gate only. Uses the same Minisign verifier as the updater dependency.
use base64::{engine::general_purpose::STANDARD,Engine};
use minisign_verify::{PublicKey,Signature};

#[test]
#[ignore = "requires an explicitly selected, signed candidate installer"]
fn signed_installer_matches_updater_key_and_manifest_and_rejects_tampering(){
    let path=std::path::PathBuf::from(std::env::var_os("ATD_ACCEPTANCE_INSTALLER").expect("select candidate installer"));
    assert!(path.is_file() && path.file_name().unwrap().to_string_lossy().ends_with("_x64-setup.exe"));
    let config:serde_json::Value=serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let key=String::from_utf8(STANDARD.decode(config["plugins"]["updater"]["pubkey"].as_str().unwrap()).unwrap()).unwrap();
    let public=PublicKey::decode(&key).unwrap();
    let encoded=std::fs::read_to_string(path.with_extension("exe.sig")).unwrap();
    let signature=Signature::decode(&String::from_utf8(STANDARD.decode(encoded.trim()).unwrap()).unwrap()).unwrap();
    let mut bytes=std::fs::read(&path).unwrap();
    public.verify(&bytes,&signature,true).expect("candidate must verify against the shipped updater key");
    let manifest=std::path::PathBuf::from(std::env::var_os("ATD_ACCEPTANCE_MANIFEST").expect("select candidate manifest"));
    let manifest:serde_json::Value=serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
    assert_eq!(manifest["version"],config["version"]);
    assert_eq!(manifest["platforms"]["windows"]["signature"].as_str().unwrap(),encoded.trim());
    assert!(manifest["platforms"]["windows"]["url"].as_str().unwrap().ends_with(path.file_name().unwrap().to_str().unwrap()));
    let last=bytes.len()-1;bytes[last]^=1;
    assert!(public.verify(&bytes,&signature,true).is_err(),"modified installer bytes must fail authentication");
}
