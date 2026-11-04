//! `ego-rec test` and `ego-rec run`: pipes a script to `ego-browser nodejs`, scrubs its output,
//! and keeps the ledger that stops a payment from repeating after an unknown outcome.

use crate::classify::spec_for_key;
use crate::compile::script_rec;
use crate::flow::FieldKind;
use crate::keychain::{self, Vault};
use crate::scrub::{Scrubber, SecretTable};
use crate::store::{Store, now_ms, write_private};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

const UNKNOWN_EXIT: i32 = 3;
const REFUSED_EXIT: i32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Started,
    Ok,
    Unknown,
    Failed,
}

#[derive(Serialize, Deserialize)]
struct LedgerLine {
    t: f64,
    status: RunStatus,
}

pub struct Ledger {
    path: PathBuf,
}

impl Ledger {
    pub fn for_script(store: &Store, script: &Path) -> Result<Self> {
        let name = script
            .file_stem()
            .and_then(|s| s.to_str())
            .context("script has no name")?;
        Ok(Self {
            path: store.root.join("runs").join(format!("{name}.jsonl")),
        })
    }

    pub fn last(&self) -> Option<RunStatus> {
        let text = fs::read_to_string(&self.path).ok()?;
        let line = text.lines().last()?;
        Some(serde_json::from_str::<LedgerLine>(line).ok()?.status)
    }

    pub fn append(&self, status: RunStatus) -> Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)?;
        let mut line = serde_json::to_vec(&LedgerLine {
            t: now_ms(),
            status,
        })?;
        line.push(b'\n');
        Ok(file.write_all(&line)?)
    }

    /// Only `started` and `unknown` can mean money moved without us knowing.
    pub fn refusal(&self, again: bool) -> Option<String> {
        let status = self
            .last()
            .filter(|s| matches!(s, RunStatus::Started | RunStatus::Unknown))?;
        if again {
            return None;
        }
        Some(format!(
            "Refusing to run: the last run ended {status:?}. Verify whether it paid, then rerun with --again."
        ))
    }
}

pub fn parse_params(params: &[String]) -> Result<BTreeMap<String, String>> {
    params
        .iter()
        .map(|param| {
            let (key, value) = param
                .split_once('=')
                .with_context(|| format!("--param {param} is not k=v"))?;
            Ok((key.to_string(), value.to_string()))
        })
        .collect()
}

fn output_scrubber(store: &Store, vault: &dyn Vault, rec: &str) -> Result<Scrubber> {
    let flow = store.flow(rec)?;
    let mut table = SecretTable::default();
    for (key, value) in keychain::scope_values(vault, &flow.scope)? {
        let kind = spec_for_key(&key).map_or(FieldKind::Plain, |s| s.kind);
        table.add_secret(&key, &value, kind);
    }
    Ok(table.scrubber())
}

fn forward(
    source: impl Read + Send + 'static,
    mut sink: impl Write + Send + 'static,
    scrubber: std::sync::Arc<Scrubber>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(source);
        let mut line = Vec::new();
        while reader.read_until(b'\n', &mut line).is_ok_and(|n| n > 0) {
            let _ = sink.write_all(&scrubber.bytes(&line));
            let _ = sink.flush();
            line.clear();
        }
    })
}

/// Runs the script and returns its exit code.
pub fn execute(
    store: &Store,
    vault: &dyn Vault,
    script_path: &Path,
    params: &[String],
    stop_before_at_most_once: bool,
) -> Result<i32> {
    let script = fs::read_to_string(script_path)
        .with_context(|| format!("reading {}", script_path.display()))?;
    let rec = script_rec(&script)
        .context("not a compiled ego-rec script: no REC header")?
        .to_string();
    let scrubber = std::sync::Arc::new(output_scrubber(store, vault, &rec)?);

    // `ego-browser nodejs` hides the shell environment, so the script receives what it needs here.
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    for name in ["HOME", "EGO_REC_HOME", "EGO_REC_KEYCHAIN_SERVICE"] {
        if let Ok(value) = std::env::var(name) {
            env.insert(name.to_string(), value);
        }
    }
    let injected = json!({
        "args": parse_params(params)?,
        "stopBeforeAtMostOnce": stop_before_at_most_once,
        "bin": std::env::current_exe()?,
        "env": env,
    });

    let mut child = Command::new("ego-browser")
        .arg("nodejs")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("starting ego-browser; is it installed?")?;
    let mut stdin = child.stdin.take().context("child stdin")?;
    let source = format!("globalThis.__egoRec = {injected};\n{script}");
    let writer = thread::spawn(move || stdin.write_all(source.as_bytes()));
    let out = forward(
        child.stdout.take().context("child stdout")?,
        std::io::stdout(),
        scrubber.clone(),
    );
    let err = forward(
        child.stderr.take().context("child stderr")?,
        std::io::stderr(),
        scrubber,
    );
    let status = child.wait()?;
    let _ = writer.join();
    let _ = out.join();
    let _ = err.join();
    Ok(status.code().unwrap_or(1))
}

pub fn run(
    store: &Store,
    vault: &dyn Vault,
    script: &Path,
    params: &[String],
    again: bool,
) -> Result<i32> {
    let ledger = Ledger::for_script(store, script)?;
    if let Some(message) = ledger.refusal(again) {
        eprintln!("{message}");
        return Ok(REFUSED_EXIT);
    }
    ledger.append(RunStatus::Started)?;
    let code = execute(store, vault, script, params, false)?;
    ledger.append(match code {
        0 => RunStatus::Ok,
        UNKNOWN_EXIT => RunStatus::Unknown,
        _ => RunStatus::Failed,
    })?;
    Ok(code)
}

pub fn compile_to(store: &Store, rec: &str, output: &Path) -> Result<()> {
    if store.is_recording(rec)? {
        bail!("recording {rec} is still running");
    }
    let script = crate::compile::compile(&store.meta(rec)?, &store.flow(rec)?)?;
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    write_private(output, script.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger() -> (tempfile::TempDir, Ledger) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join("home")).unwrap();
        let ledger = Ledger::for_script(&store, Path::new("automations/shop.mjs")).unwrap();
        (tmp, ledger)
    }

    #[test]
    fn past_success_and_plain_failure_do_not_block() {
        let (_tmp, ledger) = ledger();
        assert!(ledger.refusal(false).is_none());
        ledger.append(RunStatus::Ok).unwrap();
        assert!(ledger.refusal(false).is_none());
        ledger.append(RunStatus::Failed).unwrap();
        assert!(ledger.refusal(false).is_none());
    }

    #[test]
    fn unknown_or_interrupted_runs_block_until_again() {
        let (_tmp, ledger) = ledger();
        ledger.append(RunStatus::Unknown).unwrap();
        assert!(ledger.refusal(false).is_some());
        assert!(ledger.refusal(true).is_none());
        ledger.append(RunStatus::Started).unwrap();
        assert!(
            ledger.refusal(false).is_some(),
            "a run that never recorded its end may have paid"
        );
    }

    #[test]
    fn params_parse_as_key_value() {
        let parsed = parse_params(&["qty=2".to_string(), "a=b=c".to_string()]).unwrap();
        assert_eq!(parsed["qty"], "2");
        assert_eq!(parsed["a"], "b=c");
        assert!(parse_params(&["nope".to_string()]).is_err());
    }
}
