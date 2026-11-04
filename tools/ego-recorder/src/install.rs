//! Registers the native host for the extension's fixed id.

use anyhow::{Context, Result};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// Derived from the `key` in extension/manifest.json. A test holds the two together.
pub const EXT_ID: &str = "hacjfebiagkihcmmobkiniihcclmlhpd";
const HOST_NAME: &str = "com.hj.ego_recorder";

pub fn manifest_path(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
        .join(format!("{HOST_NAME}.json"))
}

pub fn manifest_json(exe: &Path) -> String {
    let manifest = json!({
        "name": HOST_NAME,
        "description": "ego-recorder native host",
        "path": exe,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXT_ID}/")],
    });
    serde_json::to_string_pretty(&manifest).expect("manifest serializes")
}

pub fn dist_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("extension/dist")
}

pub fn install(home: &Path, exe: &Path, dry_run: bool) -> Result<String> {
    let path = manifest_path(home);
    let manifest = manifest_json(exe);
    if !dry_run {
        let parent = path.parent().context("manifest path has a parent")?;
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
        fs::write(&path, &manifest).with_context(|| format!("writing {}", path.display()))?;
    }
    let verb = if dry_run { "Would write" } else { "Wrote" };
    Ok(format!(
        "{verb} {}\nLoad the extension unpacked from {}\nExtension id {EXT_ID}\n",
        path.display(),
        dist_path().display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use sha2::{Digest, Sha256};

    #[test]
    fn ext_id_matches_the_manifest_key() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../extension/manifest.json")).unwrap();
        let der = STANDARD.decode(manifest["key"].as_str().unwrap()).unwrap();
        let id: String = Sha256::digest(der)[..16]
            .iter()
            .flat_map(|byte| [byte >> 4, byte & 0xf])
            .map(|nibble| (b'a' + nibble) as char)
            .collect();
        assert_eq!(id, EXT_ID);
    }

    #[test]
    fn install_writes_only_into_the_given_home() {
        let home = tempfile::tempdir().unwrap();
        let dry = install(home.path(), Path::new("/x/ego-rec"), true).unwrap();
        assert!(dry.contains("Would write"));
        assert!(
            !manifest_path(home.path()).exists(),
            "dry run writes nothing"
        );

        install(home.path(), Path::new("/x/ego-rec"), false).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(manifest_path(home.path())).unwrap()).unwrap();
        assert_eq!(written["path"], "/x/ego-rec");
        assert_eq!(written["type"], "stdio");
        assert_eq!(
            written["allowed_origins"][0],
            format!("chrome-extension://{EXT_ID}/")
        );
    }
}
