//! Native messaging host: length-prefixed JSON over stdio, one recording at a time.

use crate::classify::{spec, spec_for_key};
use crate::derive::json_shape;
use crate::flow::*;
use crate::keychain::{self, Vault};
use crate::provenance::{self, Spooled, net_id};
use crate::scrub::{Scrubber, SecretTable, secret_token};
use crate::store::{SPOOL, Store, mkdir_private, now_ms, write_private};
use crate::view;
use crate::wire::*;
use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use url::Url;

const MAX_FRAME: usize = 64 * 1024 * 1024;
const MIN_PARTIAL_LEN: usize = 4;

pub fn read_frame(input: &mut impl Read) -> Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_ne_bytes(len) as usize;
    if len > MAX_FRAME {
        bail!("frame of {len} bytes exceeds the limit");
    }
    let mut frame = vec![0u8; len];
    input.read_exact(&mut frame).context("truncated frame")?;
    Ok(Some(frame))
}

pub fn write_frame(output: &mut impl Write, frame: &[u8]) -> Result<()> {
    output.write_all(&(frame.len() as u32).to_ne_bytes())?;
    output.write_all(frame)?;
    Ok(output.flush()?)
}

struct Pending {
    kind: FieldKind,
    value: String,
    partials: Vec<String>,
}

struct Active {
    meta: Meta,
    dir: PathBuf,
    /// Holding this lock is what tells a later host that the spool is not abandoned.
    spool: File,
    seq: u64,
    secrets: HashMap<String, Pending>,
    field_keys: HashMap<(String, String), String>,
    suppressed_tabs: HashSet<i32>,
}

pub struct Host<'a> {
    store: &'a Store,
    vault: &'a dyn Vault,
    active: Option<Active>,
}

pub fn serve(
    store: &Store,
    vault: &dyn Vault,
    mut input: impl Read,
    mut output: impl Write,
) -> Result<()> {
    let mut host = Host {
        store,
        vault,
        active: None,
    };
    host.recover()?;
    while let Some(frame) = read_frame(&mut input)? {
        let reply = match serde_json::from_slice::<Envelope>(&frame) {
            Ok(envelope) => Reply {
                id: envelope.id,
                reply: host.handle(envelope.request),
            },
            Err(e) => Reply {
                id: 0,
                reply: ReplyBody::Error {
                    message: format!("bad message: {e}"),
                },
            },
        };
        write_frame(&mut output, &serde_json::to_vec(&reply)?)?;
    }
    // The extension going away must not leave plaintext behind or lose the recording.
    if host.active.is_some() {
        host.stop(None)?;
    }
    Ok(())
}

impl Host<'_> {
    fn recover(&self) -> Result<()> {
        for id in self.store.ids()? {
            let dir = self.store.rec_dir(&id)?;
            let spool = dir.join(SPOOL);
            let Ok(file) = File::open(&spool) else {
                continue;
            };
            if file.try_lock().is_ok() {
                fs::remove_dir_all(&dir)?;
            }
        }
        keychain::sweep_stale_once(self.vault, (now_ms() / 1000.0) as u64)
    }

    fn handle(&mut self, request: Request) -> ReplyBody {
        let outcome = match request {
            Request::Start { tab_url, title } => self
                .start(&tab_url, &title)
                .map(|rec| ReplyBody::Started { rec }),
            Request::Events { events } => self.ingest(events).map(|()| ReplyBody::Ok),
            Request::Stop { goal } => self
                .stop(goal)
                .map(|(rec, steps)| ReplyBody::Stopped { rec, steps }),
            Request::List => {
                view::summaries(self.store, self.vault).map(|items| ReplyBody::Recordings { items })
            }
            Request::Prompt { rec } => self.store.meta(&rec).map(|meta| ReplyBody::Prompt {
                text: view::prompt(&meta),
            }),
            Request::Delete { rec } => self.delete(&rec).map(|()| ReplyBody::Ok),
            Request::InputStatus { rec } => self
                .input_status(&rec)
                .map(|fields| ReplyBody::Inputs { fields }),
            Request::SetInput {
                rec,
                key,
                value,
                persist,
            } => self
                .set_input(&rec, &key, &value, persist)
                .map(|()| ReplyBody::Ok),
        };
        outcome.unwrap_or_else(|e| ReplyBody::Error {
            message: format!("{e:#}"),
        })
    }

    fn start(&mut self, tab_url: &str, title: &str) -> Result<String> {
        if let Some(active) = &self.active {
            bail!("recording {} is already running", active.meta.id);
        }
        let mut secs = (now_ms() / 1000.0) as u64;
        while self.store.rec_dir(&format!("{secs:x}"))?.exists() {
            secs += 1;
        }
        let id = format!("{secs:x}");
        let dir = self.store.rec_dir(&id)?;
        mkdir_private(&dir)?;
        let web_url = Url::parse(tab_url)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https"));
        let meta = Meta {
            id: id.clone(),
            title: title.to_string(),
            goal: None,
            start_url: web_url.as_ref().map_or(String::new(), Url::to_string),
            scope: web_url
                .as_ref()
                .and_then(|u| u.host_str())
                .unwrap_or("")
                .to_string(),
            created_at: now_ms(),
            schema: SCHEMA,
        };
        write_private(&dir.join("meta.json"), &serde_json::to_vec_pretty(&meta)?)?;
        let spool = OpenOptions::new()
            .create_new(true)
            .append(true)
            .mode(0o600)
            .open(dir.join(SPOOL))?;
        spool.try_lock().context("locking the spool")?;
        self.active = Some(Active {
            meta,
            dir,
            spool,
            seq: 0,
            secrets: HashMap::new(),
            field_keys: HashMap::new(),
            suppressed_tabs: HashSet::new(),
        });
        Ok(id)
    }

    fn ingest(&mut self, events: Vec<CaptureEvent>) -> Result<()> {
        let active = self.active.as_mut().context("not recording")?;
        for event in events {
            active.seq += 1;
            let seq = active.seq;
            let event = match event {
                CaptureEvent::Action(action) => CaptureEvent::Action(active.seal_action(action)),
                CaptureEvent::Nav(nav) => {
                    active.observe_nav(&nav);
                    CaptureEvent::Nav(nav)
                }
                CaptureEvent::Shot {
                    tab, jpeg_base64, ..
                } => {
                    if !active.suppressed_tabs.contains(&tab) {
                        let shots = active.dir.join("shots");
                        mkdir_private(&shots)?;
                        let jpeg = STANDARD
                            .decode(jpeg_base64)
                            .context("screenshot encoding")?;
                        write_private(&shots.join(format!("{seq}.jpg")), &jpeg)?;
                    }
                    continue;
                }
                net @ CaptureEvent::Net(_) => net,
            };
            let mut line = serde_json::to_vec(&Spooled { seq, event })?;
            line.push(b'\n');
            active.spool.write_all(&line)?;
        }
        Ok(())
    }

    fn stop(&mut self, goal: Option<String>) -> Result<(String, u32)> {
        let active = self.active.take().context("not recording")?;
        let (id, steps) = active.finish(goal, self.store, self.vault)?;
        Ok((id, steps))
    }

    fn delete(&self, rec: &str) -> Result<()> {
        if self.active.as_ref().is_some_and(|a| a.meta.id == rec) {
            bail!("recording {rec} is still running");
        }
        view::delete(self.store, self.vault, rec)
    }

    fn input_status(&self, rec: &str) -> Result<Vec<InputField>> {
        let flow = self.store.flow(rec)?;
        view::input_fields(&flow, self.vault)
    }

    fn set_input(&self, rec: &str, key: &str, value: &str, persist: bool) -> Result<()> {
        let flow = self.store.flow(rec)?;
        let input = flow
            .inputs
            .iter()
            .find(|i| i.key == key)
            .with_context(|| format!("{rec} has no input {key}"))?;
        if persist && input.storage == Storage::Keychain {
            keychain::save(self.vault, &flow.scope, key, value)
        } else {
            keychain::save_once(
                self.vault,
                &flow.scope,
                key,
                value,
                (now_ms() / 1000.0) as u64,
            )
        }
    }
}

impl Active {
    fn seal_action(&mut self, mut action: ActionEvent) -> ActionEvent {
        let Some(value) = action.value.clone() else {
            return action;
        };
        if !matches!(action.kind, ActionKind::Input | ActionKind::Change) {
            return action;
        }
        let kind = crate::classify::classify(&action.target);
        let Some(field) = spec(kind) else {
            return action;
        };
        let key = self.field_key(&action.target, field.key);
        if matches!(
            kind,
            FieldKind::CardNumber
                | FieldKind::CardExp
                | FieldKind::CardName
                | FieldKind::CardCvc
                | FieldKind::CardPin
        ) {
            // Card fields render their digits in plaintext, so screenshots stop until the page changes.
            self.suppressed_tabs.insert(action.tab);
        }
        let pending = self.secrets.entry(key.clone()).or_insert_with(|| Pending {
            kind,
            value: String::new(),
            partials: Vec::new(),
        });
        pending
            .partials
            .push(std::mem::replace(&mut pending.value, value));
        action.value = Some(secret_token(&key));
        action
    }

    /// Separate fields of one kind (split card number, confirm password) keep separate values.
    fn field_key(&mut self, target: &Target, base: &str) -> String {
        let origin = Url::parse(&target.frame_url)
            .map_or(String::new(), |u| u.origin().ascii_serialization());
        let identity = (origin, target.css.clone());
        if let Some(key) = self.field_keys.get(&identity) {
            return key.clone();
        }
        let same_kind = self
            .field_keys
            .values()
            .filter(|k| spec_for_key(k).is_some_and(|s| s.key == base))
            .count();
        let key = if same_kind == 0 {
            base.to_string()
        } else {
            format!("{base}.{}", same_kind + 1)
        };
        self.field_keys.insert(identity, key.clone());
        key
    }

    fn observe_nav(&mut self, nav: &NavEvent) {
        if nav.transition != "history" {
            self.suppressed_tabs.remove(&nav.tab);
        }
        if self.meta.start_url.is_empty()
            && let Ok(url) = Url::parse(&nav.url)
            && matches!(url.scheme(), "http" | "https")
        {
            self.meta.start_url = nav.url.clone();
            self.meta.scope = url.host_str().unwrap_or("").to_string();
        }
    }

    fn secret_table(&self) -> SecretTable {
        let mut table = SecretTable::default();
        for (key, pending) in &self.secrets {
            table.add_secret(key, &pending.value, pending.kind);
            for partial in pending
                .partials
                .iter()
                .filter(|p| p.len() >= MIN_PARTIAL_LEN)
            {
                table.add_secret(key, partial, pending.kind);
            }
        }
        table
    }

    fn finish(
        self,
        goal: Option<String>,
        store: &Store,
        vault: &dyn Vault,
    ) -> Result<(String, u32)> {
        let spool_path = self.dir.join(SPOOL);
        let raw = fs::read_to_string(&spool_path)?;
        let mut lines = raw
            .lines()
            .map(serde_json::from_str::<Spooled>)
            .collect::<Result<Vec<_>, _>>()?;
        lines.sort_by(|a, b| event_time(&a.event).total_cmp(&event_time(&b.event)));

        let mut deps = provenance::compute(&lines);
        let mut table = self.secret_table();
        for line in &mut lines {
            if let CaptureEvent::Net(net) = &mut line.event {
                seal_session_headers(net, &mut table);
            }
        }
        let scrubber = table.scrubber();

        let mut meta = self.meta.clone();
        meta.title = scrubber.text(&meta.title);
        meta.start_url = scrubber.text(&meta.start_url);
        meta.goal = goal
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .map(|g| scrubber.text(&g));

        let mut out = Vec::new();
        for line in lines {
            let stored = match line.event {
                CaptureEvent::Action(mut event) => {
                    event.hidden.clear();
                    Stored::Action {
                        seq: line.seq,
                        event: scrub_as_json(&scrubber, &event)?,
                    }
                }
                CaptureEvent::Nav(event) => Stored::Nav {
                    seq: line.seq,
                    event: scrub_as_json(&scrubber, &event)?,
                },
                CaptureEvent::Net(net) => {
                    let deps = deps.remove(&line.seq).unwrap_or_default();
                    Stored::Net(store_net(line.seq, net, deps, &scrubber, &self.dir)?)
                }
                CaptureEvent::Shot { .. } => continue,
            };
            serde_json::to_writer(&mut out, &stored)?;
            out.push(b'\n');
        }
        write_private(&self.dir.join("events.ndjson"), &out)?;
        write_private(
            &self.dir.join("meta.json"),
            &serde_json::to_vec_pretty(&meta)?,
        )?;
        drop(self.spool);
        fs::remove_file(&spool_path)?;

        for (key, pending) in &self.secrets {
            let storage = spec(pending.kind).map(|s| s.storage);
            if storage == Some(Storage::Keychain) && !pending.value.is_empty() {
                keychain::save(vault, &meta.scope, key, &pending.value)?;
            }
        }
        let flow = store.derive_flow(&meta.id)?;
        Ok((meta.id, flow.steps.len() as u32))
    }
}

fn event_time(event: &CaptureEvent) -> f64 {
    match event {
        CaptureEvent::Action(e) => e.t,
        CaptureEvent::Nav(e) => e.t,
        CaptureEvent::Net(e) => e.t,
        CaptureEvent::Shot { t, .. } => *t,
    }
}

/// Header values become tokens even when too short to be safe global scrub terms.
fn seal_session_headers(net: &mut NetEvent, table: &mut SecretTable) {
    for (name, value) in net.req_headers.iter_mut().chain(net.res_headers.iter_mut()) {
        match name.to_ascii_lowercase().as_str() {
            "cookie" => {
                let pairs: Vec<String> = value
                    .split("; ")
                    .map(|pair| match pair.split_once('=') {
                        Some((cookie, secret)) => {
                            table.add_session(cookie, secret);
                            format!("{cookie}={}", crate::scrub::session_token(cookie))
                        }
                        None => pair.to_string(),
                    })
                    .collect();
                *value = pairs.join("; ");
            }
            "set-cookie" => {
                let lines: Vec<String> = value
                    .lines()
                    .map(|line| {
                        let (pair, attributes) = line.split_once(';').unwrap_or((line, ""));
                        let Some((cookie, secret)) = pair.split_once('=') else {
                            return line.to_string();
                        };
                        table.add_session(cookie.trim(), secret);
                        let suffix = if attributes.is_empty() {
                            String::new()
                        } else {
                            format!(";{attributes}")
                        };
                        format!(
                            "{cookie}={}{suffix}",
                            crate::scrub::session_token(cookie.trim())
                        )
                    })
                    .collect();
                *value = lines.join("\n");
            }
            "authorization" | "proxy-authorization" => {
                let (scheme, credential) = value
                    .split_once(' ')
                    .map_or(("", value.as_str()), |(s, c)| (s, c));
                table.add_session("authorization", credential);
                let token = crate::scrub::session_token("authorization");
                *value = if scheme.is_empty() {
                    token
                } else {
                    format!("{scheme} {token}")
                };
            }
            _ => {}
        }
    }
}

fn scrub_as_json<T: serde::Serialize + serde::de::DeserializeOwned>(
    scrubber: &Scrubber,
    value: &T,
) -> Result<T> {
    let mut json = serde_json::to_value(value)?;
    scrubber.json(&mut json);
    Ok(serde_json::from_value(json)?)
}

fn body_shape(text: &str, form: bool) -> Option<String> {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
        return Some(json_shape(&json).to_string());
    }
    if !form {
        return None;
    }
    let fields: serde_json::Map<String, serde_json::Value> =
        url::form_urlencoded::parse(text.as_bytes())
            .map(|(k, _)| (k.into_owned(), "string".into()))
            .collect();
    Some(serde_json::Value::Object(fields).to_string())
}

fn store_net(
    seq: u64,
    net: NetEvent,
    deps: Vec<Dep>,
    scrubber: &Scrubber,
    dir: &std::path::Path,
) -> Result<StoredNet> {
    let is_form = net.req_headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("content-type") && value.contains("x-www-form-urlencoded")
    });
    let req_shape = net
        .post_data
        .as_deref()
        .and_then(|body| body_shape(body, is_form));
    let body = match (&net.body, net.body_base64) {
        (Some(body), true) => Some(STANDARD.decode(body).context("response body encoding")?),
        (Some(body), false) => Some(body.clone().into_bytes()),
        (None, _) => None,
    };
    let res_shape = body
        .as_deref()
        .and_then(|b| std::str::from_utf8(b).ok())
        .and_then(|text| body_shape(text, false));
    let blob = body
        .filter(|b| !b.is_empty())
        .map(|bytes| write_blob(dir, &scrubber.bytes(&bytes)))
        .transpose()?;
    let deps = deps
        .into_iter()
        .map(|dep| Dep {
            field: scrubber.text(&dep.field),
            from: DepSource {
                id: dep.from.id,
                path: scrubber.text(&dep.from.path),
            },
        })
        .collect();
    let clean: NetEvent = scrub_as_json(scrubber, &NetEvent { body: None, ..net })?;
    Ok(StoredNet {
        // Ids and hashes are assigned after scrubbing: a short numeric secret must not rewrite them.
        id: net_id(seq),
        seq,
        t: clean.t,
        tab: clean.tab,
        top: clean.top,
        method: clean.method,
        url: clean.url,
        resource_type: clean.resource_type,
        req_headers: clean.req_headers,
        post_data: clean.post_data,
        status: clean.status,
        mime: clean.mime,
        res_headers: clean.res_headers,
        blob,
        truncated: clean.truncated,
        failed: clean.failed,
        req_shape: req_shape.map(|s| scrubber.text(&s)),
        res_shape: res_shape.map(|s| scrubber.text(&s)),
        deps,
    })
}

fn write_blob(dir: &std::path::Path, bytes: &[u8]) -> Result<String> {
    let hash: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let blobs = dir.join("blobs");
    mkdir_private(&blobs)?;
    write_private(&blobs.join(&hash), bytes)?;
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::memory::MemoryVault;
    use std::io::Cursor;
    use std::path::Path;

    const PASSWORD: &str = "C@nary!Pass 77";
    const CVC: &str = "CVC7Q3";
    const SESSION: &str = "sessioncanary123";
    const CSRF: &str = "csrf-canary-token";

    fn input(t: f64, target: Target, value: &str) -> CaptureEvent {
        CaptureEvent::Action(ActionEvent {
            t,
            tab: 1,
            kind: ActionKind::Input,
            target,
            value: Some(value.into()),
            key: None,
            hidden: vec![],
        })
    }

    fn field(css: &str, f: impl FnOnce(&mut Target)) -> Target {
        let mut t = Target {
            tag: "input".into(),
            css: css.into(),
            frame_url: "https://shop.test/".into(),
            ..Default::default()
        };
        f(&mut t);
        t
    }

    fn recorded_session(host: &mut Host) -> String {
        let rec = host
            .start("https://shop.test:8443/login?next=1", "Shop")
            .unwrap();
        let password = field("#p", |t| t.input_type = Some("password".into()));
        let cvc = field("#cvc", |t| t.autocomplete = Some("cc-csc".into()));
        let events = vec![
            input(1.0, password.clone(), "C@na"),
            input(2.0, password, PASSWORD),
            input(3.0, cvc, CVC),
            CaptureEvent::Shot {
                t: 3.5,
                tab: 1,
                jpeg_base64: STANDARD.encode(b"plaintext card digits"),
            },
            CaptureEvent::Net(NetEvent {
                t: 4.0,
                tab: 1,
                top: true,
                method: "GET".into(),
                url: "https://shop.test/api/csrf".into(),
                resource_type: "Fetch".into(),
                res_headers: vec![(
                    "Set-Cookie".into(),
                    format!("sid={SESSION}; HttpOnly; Path=/"),
                )],
                body: Some(format!("{{\"csrf\":\"{CSRF}\"}}")),
                ..Default::default()
            }),
            CaptureEvent::Net(NetEvent {
                t: 5.0,
                tab: 1,
                top: true,
                method: "POST".into(),
                url: format!(
                    "https://shop.test/api/charge?p={}",
                    STANDARD.encode(PASSWORD)
                ),
                resource_type: "Fetch".into(),
                req_headers: vec![("Cookie".into(), format!("sid={SESSION}"))],
                post_data: Some(format!(
                    "{{\"csrf\":\"{CSRF}\",\"cvc\":\"{CVC}\",\"note\":\"C@na\"}}"
                )),
                body: Some(format!("{{\"echo\":\"{PASSWORD}\"}}")),
                ..Default::default()
            }),
        ];
        host.ingest(events).unwrap();
        rec
    }

    fn bytes_in_tree(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        for entry in fs::read_dir(root).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(bytes_in_tree(&path));
            } else {
                let bytes = fs::read(&path).unwrap();
                out.push((path, bytes));
            }
        }
        out
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn frames_round_trip_and_eof_ends_the_stream() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, b"{\"a\":1}").unwrap();
        let mut cursor = Cursor::new(buffer);
        assert_eq!(
            read_frame(&mut cursor).unwrap().as_deref(),
            Some(&b"{\"a\":1}"[..])
        );
        assert_eq!(read_frame(&mut cursor).unwrap(), None);
    }

    #[test]
    fn oversized_and_truncated_frames_are_errors() {
        let mut huge = Cursor::new(((MAX_FRAME + 1) as u32).to_ne_bytes().to_vec());
        assert!(read_frame(&mut huge).is_err());
        let mut short = 10u32.to_ne_bytes().to_vec();
        short.extend_from_slice(b"abc");
        assert!(read_frame(&mut Cursor::new(short)).is_err());
    }

    #[test]
    fn stop_pass_leaves_no_secret_on_disk_and_saves_only_keychain_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join("home")).unwrap();
        let vault = MemoryVault::default();
        let mut host = Host {
            store: &store,
            vault: &vault,
            active: None,
        };
        let rec = recorded_session(&mut host);
        host.stop(Some(format!("pay with {CVC}"))).unwrap();

        let dir = store.rec_dir(&rec).unwrap();
        assert!(!dir.join(SPOOL).exists(), "spool must be deleted at stop");
        let needles: Vec<Vec<u8>> = vec![
            PASSWORD.into(),
            CVC.into(),
            SESSION.into(),
            b"C@na".to_vec(),
            STANDARD.encode(PASSWORD).into_bytes(),
        ];
        for (path, bytes) in bytes_in_tree(&store.root) {
            for needle in &needles {
                assert!(
                    !contains(&bytes, needle),
                    "{} leaked {}",
                    path.display(),
                    String::from_utf8_lossy(needle)
                );
            }
        }
        assert_eq!(
            keychain::take(&vault, "shop.test", "login.password")
                .unwrap()
                .as_deref(),
            Some(PASSWORD)
        );
        assert_eq!(
            keychain::take(&vault, "shop.test", "card.cvc").unwrap(),
            None,
            "CVC is never persisted"
        );
        assert!(
            store.shots(&rec).unwrap().is_empty(),
            "screenshot after a card fill must be dropped"
        );
    }

    #[test]
    fn provenance_survives_scrubbing_and_ids_are_not_rewritten() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join("home")).unwrap();
        let vault = MemoryVault::default();
        let mut host = Host {
            store: &store,
            vault: &vault,
            active: None,
        };
        let rec = recorded_session(&mut host);
        host.stop(None).unwrap();

        let flow = store.flow(&rec).unwrap();
        let charge = flow
            .api
            .iter()
            .find(|a| a.method == "POST")
            .expect("charge call in flow");
        let dep = charge
            .deps
            .iter()
            .find(|d| d.field == "body.csrf")
            .expect("csrf dependency");
        assert_eq!(dep.from.path, "csrf");
        assert!(
            flow.api.iter().any(|a| a.id == dep.from.id),
            "dependency id must name a recorded call"
        );
        assert!(
            charge
                .req_shape
                .as_deref()
                .unwrap()
                .contains("\"csrf\":\"string\"")
        );
        assert_eq!(flow.scope, "shop.test");
    }

    #[test]
    fn eof_while_recording_still_runs_the_stop_pass() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join("home")).unwrap();
        let vault = MemoryVault::default();
        let mut frames = Vec::new();
        let envelope = Envelope {
            id: 1,
            request: Request::Start {
                tab_url: "https://a.test/".into(),
                title: "A".into(),
            },
        };
        write_frame(&mut frames, &serde_json::to_vec(&envelope).unwrap()).unwrap();
        let mut replies = Vec::new();
        serve(&store, &vault, Cursor::new(frames), &mut replies).unwrap();
        let ids = store.ids().unwrap();
        assert_eq!(ids.len(), 1);
        assert!(!store.is_recording(&ids[0]).unwrap());
        assert!(store.rec_dir(&ids[0]).unwrap().join("flow.json").exists());
        let reply: Reply =
            serde_json::from_slice(&read_frame(&mut Cursor::new(replies)).unwrap().unwrap())
                .unwrap();
        assert!(matches!(reply.reply, ReplyBody::Started { .. }));
    }

    #[test]
    fn abandoned_spool_is_deleted_at_next_start() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join("home")).unwrap();
        let dir = store.rec_dir("abc").unwrap();
        mkdir_private(&dir).unwrap();
        write_private(&dir.join(SPOOL), b"plaintext").unwrap();
        let vault = MemoryVault::default();
        serve(&store, &vault, Cursor::new(Vec::new()), Vec::new()).unwrap();
        assert!(
            !dir.exists(),
            "a spool nobody holds cannot be scrubbed, so it goes"
        );
    }

    #[test]
    fn spool_held_by_another_host_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join("home")).unwrap();
        let vault = MemoryVault::default();
        let mut first = Host {
            store: &store,
            vault: &vault,
            active: None,
        };
        let rec = first.start("https://a.test/", "A").unwrap();
        serve(&store, &vault, Cursor::new(Vec::new()), Vec::new()).unwrap();
        assert!(store.rec_dir(&rec).unwrap().exists());
    }

    #[test]
    fn delete_keeps_keys_another_recording_of_the_scope_uses() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join("home")).unwrap();
        let vault = MemoryVault::default();
        let mut host = Host {
            store: &store,
            vault: &vault,
            active: None,
        };
        let first = recorded_session(&mut host);
        host.stop(None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let second = recorded_session(&mut host);
        host.stop(None).unwrap();

        host.delete(&first).unwrap();
        assert!(!store.rec_dir(&first).unwrap().exists());
        assert!(
            keychain::has_saved(&vault, "shop.test", "login.password").unwrap(),
            "second recording still references it"
        );
        host.delete(&second).unwrap();
        assert!(
            !keychain::has_saved(&vault, "shop.test", "login.password").unwrap(),
            "no recording references it anymore"
        );
    }

    #[test]
    fn form_values_follow_input_storage() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join("home")).unwrap();
        let vault = MemoryVault::default();
        let mut host = Host {
            store: &store,
            vault: &vault,
            active: None,
        };
        let rec = recorded_session(&mut host);
        host.stop(None).unwrap();

        host.set_input(&rec, "card.cvc", "999", true).unwrap();
        assert!(
            !keychain::has_saved(&vault, "shop.test", "card.cvc").unwrap(),
            "persist flag cannot override an ask kind"
        );
        assert!(keychain::has_once(&vault, "shop.test", "card.cvc").unwrap());
        assert!(host.set_input(&rec, "unknown.key", "x", true).is_err());
    }
}
