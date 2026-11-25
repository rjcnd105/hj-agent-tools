use crate::config::home_dir;
use crate::model::Item;
use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

const STORE_TTL_SECS: u64 = 7 * 86_400;
const LOCK_STALE_SECS: u64 = 30;

pub fn store_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".cache/last30/store"))
}

pub fn dumps_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".cache/last30/dumps"))
}

pub fn ensure_private_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        if !path.exists() {
            let mut b = std::fs::DirBuilder::new();
            b.recursive(true).mode(0o700);
            b.create(path)
                .with_context(|| format!("failed to create {}", path.display()))?;
        }
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)?;
    }
    Ok(())
}

/// Cooperative lockfile guard to serialize store writes and TTL pruning across concurrent processes.
struct StoreLock {
    path: PathBuf,
}

impl StoreLock {
    async fn acquire(dir: &Path) -> Option<Self> {
        let lock_path = dir.join(".store.lock");
        for _ in 0..20 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(_) => return Some(Self { path: lock_path }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if let Ok(meta) = std::fs::metadata(&lock_path)
                        && let Ok(mod_t) = meta.modified()
                        && mod_t.elapsed().unwrap_or_default() > Duration::from_secs(LOCK_STALE_SECS)
                    {
                        let _ = std::fs::remove_file(&lock_path);
                        continue;
                    }
                    tokio::time::sleep(Duration::from_millis(15)).await;
                }
                Err(_) => return None,
            }
        }
        None
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Atomically persist items by their deterministic short hash ID so `last30 show <id>` works
/// across sessions. Returns Err if the run store is unavailable or writes failed.
pub async fn save_items(items: &[Item]) -> Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let dir = store_dir().context("HOME is not set; local run store disabled")?;
    ensure_private_dir(&dir)?;

    let _guard = StoreLock::acquire(&dir)
        .await
        .context("could not acquire run store lock")?;

    let pid = std::process::id();
    let ts = jiff::Timestamp::now().as_nanosecond();
    for (idx, item) in items.iter().enumerate() {
        if !is_valid_item_id(&item.item_id) {
            continue;
        }
        let bytes = serde_json::to_vec(item)?;
        let tmp = dir.join(format!(".tmp-{pid}-{ts:x}-{idx}"));
        let final_path = dir.join(format!("{}.json", item.item_id));
        tokio::fs::write(&tmp, &bytes).await?;
        #[cfg(unix)]
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        if let Err(e) = tokio::fs::rename(&tmp, &final_path).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e.into());
        }
    }

    prune_expired(&dir).await;
    Ok(())
}

pub async fn load_item(id: &str) -> Result<Item> {
    let clean = id.trim().trim_start_matches('#').to_ascii_lowercase();
    if !is_valid_item_id(&clean) {
        bail!("invalid item id `{id}` (expected 8 lowercase hex chars from `last30 search`)");
    }
    let dir = store_dir().context("HOME is not set; run store unavailable")?;
    let path = dir.join(format!("{clean}.json"));
    let raw = tokio::fs::read_to_string(&path).await.with_context(|| {
        format!(
            "item `{clean}` not found in {} (run `last30 search` first)",
            dir.display()
        )
    })?;
    let item: Item = serde_json::from_str(&raw)?;
    Ok(item)
}

pub fn is_valid_item_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

async fn prune_expired(dir: &Path) {
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(STORE_TTL_SECS))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if let Ok(modified) = meta.modified()
            && modified < cutoff
        {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}
