//! On-disk layout of recordings and run ledgers. Directories 0700, files 0600.

use crate::derive::derive;
use crate::flow::{Flow, Meta, Stored};
use anyhow::{Context, Result, bail};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SPOOL: &str = "spool.ndjson";

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

pub fn mkdir_private(path: &Path) -> Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .with_context(|| format!("creating {}", path.display()))
}

pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(file.write_all(bytes)?)
}

pub struct Store {
    pub root: PathBuf,
}

impl Store {
    pub fn open() -> Result<Self> {
        let root = match std::env::var_os("EGO_REC_HOME") {
            Some(path) => PathBuf::from(path),
            None => PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?)
                .join(".local/share/ego-recorder"),
        };
        Self::at(root)
    }

    pub fn at(root: PathBuf) -> Result<Self> {
        mkdir_private(&root.join("recordings"))?;
        mkdir_private(&root.join("runs"))?;
        Ok(Self { root })
    }

    pub fn rec_dir(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            bail!("invalid recording id: {id}");
        }
        Ok(self.root.join("recordings").join(id))
    }

    pub fn existing_dir(&self, id: &str) -> Result<PathBuf> {
        let dir = self.rec_dir(id)?;
        if !dir.is_dir() {
            bail!("no recording {id}; see `ego-rec list`");
        }
        Ok(dir)
    }

    /// Newest first: ids are fixed-width hex of the start time.
    pub fn ids(&self) -> Result<Vec<String>> {
        let mut ids: Vec<String> = fs::read_dir(self.root.join("recordings"))?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .collect();
        ids.sort_unstable_by(|a, b| b.cmp(a));
        Ok(ids)
    }

    pub fn meta(&self, id: &str) -> Result<Meta> {
        let bytes = fs::read(self.existing_dir(id)?.join("meta.json"))?;
        serde_json::from_slice(&bytes).with_context(|| format!("meta of {id}"))
    }

    pub fn is_recording(&self, id: &str) -> Result<bool> {
        Ok(self.rec_dir(id)?.join(SPOOL).exists())
    }

    /// `flow.json` is derived, so a missing one is rebuilt from the events.
    pub fn flow(&self, id: &str) -> Result<Flow> {
        let path = self.existing_dir(id)?.join("flow.json");
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("flow of {id}")),
            Err(_) => self.derive_flow(id),
        }
    }

    pub fn derive_flow(&self, id: &str) -> Result<Flow> {
        let dir = self.existing_dir(id)?;
        let meta = self.meta(id)?;
        let events = fs::read_to_string(dir.join("events.ndjson"))
            .with_context(|| format!("{id} has no events; was it stopped?"))?;
        let stored = events
            .lines()
            .map(serde_json::from_str::<Stored>)
            .collect::<Result<Vec<_>, _>>()?;
        let flow = derive(&meta, &stored, &self.shots(id)?);
        write_private(
            &dir.join("flow.json"),
            serde_json::to_string_pretty(&flow)?.as_bytes(),
        )?;
        Ok(flow)
    }

    pub fn shots(&self, id: &str) -> Result<Vec<u64>> {
        let Ok(entries) = fs::read_dir(self.rec_dir(id)?.join("shots")) else {
            return Ok(Vec::new());
        };
        let mut seqs: Vec<u64> = entries
            .filter_map(|entry| {
                entry
                    .ok()?
                    .file_name()
                    .to_str()?
                    .strip_suffix(".jpg")?
                    .parse()
                    .ok()
            })
            .collect();
        seqs.sort_unstable();
        Ok(seqs)
    }
}
