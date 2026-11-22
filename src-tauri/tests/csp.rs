//! The CSP must not depend on whether `index.html` holds an inline `<style>`.
//!
//! Tauri adds a nonce and hashes to `style-src` as soon as it finds one, and browsers then ignore
//! `'unsafe-inline'`, which blocks every component style Angular inserts at runtime.

use serde_json::Value;

fn config() -> Value {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
        .expect("tauri.conf.json is readable");
    serde_json::from_str(&raw).expect("tauri.conf.json is valid JSON")
}

#[test]
fn style_src_is_not_rewritten_by_tauri() {
    let config = config();
    let disabled = &config["app"]["security"]["dangerousDisableAssetCspModification"];
    assert_eq!(
        disabled,
        &serde_json::json!(["style-src"]),
        "only style-src is excluded from the automatic nonce and hashes"
    );
}

#[test]
fn script_src_keeps_the_automatic_hashes() {
    let config = config();
    let disabled = config["app"]["security"]["dangerousDisableAssetCspModification"]
        .as_array()
        .expect("an array of directives");
    assert!(!disabled.iter().any(|d| d == "script-src"));
}
