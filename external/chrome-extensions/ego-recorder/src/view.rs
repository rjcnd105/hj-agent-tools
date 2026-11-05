//! What people and agents read about a recording: list, prompt, and compact `show` text.

use crate::flow::*;
use crate::keychain::{self, Vault};
use crate::store::Store;
use crate::wire::{InputField, RecordingSummary};
use anyhow::{Context, Result, bail};
use std::collections::HashSet;
use std::fmt::Write;
use std::fs;
use std::path::PathBuf;

const PROMPT_BUDGET: usize = 1200;

pub fn slug(meta: &Meta) -> String {
    let scope: String = meta
        .scope
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let start = meta.id.len().saturating_sub(4);
    format!("{scope}-{}", &meta.id[start..])
}

pub fn prompt(meta: &Meta) -> String {
    let render = |goal: &str| {
        let (id, slug) = (&meta.id, slug(meta));
        format!(
            "Build the automation from ego-rec recording {id}. Goal: {goal}.\n\
             1. ego-rec compile {id} -o automations/{slug}.mjs\n\
             2. Change only TODOs. For detail: ego-rec show {id} --step N [--net]\n\
             3. Verify: ego-rec test automations/{slug}.mjs (stops before payment)\n\
             Never read recording files directly. Never run `ego-rec run` unless the user asks: it makes the real payment. Secrets resolve at runtime; you don't need them.\n"
        )
    };
    let goal = meta
        .goal
        .as_deref()
        .unwrap_or("replay the recording")
        .replace('\n', " ");
    let room = PROMPT_BUDGET.saturating_sub(render("").len());
    let cut = (0..=room.min(goal.len()))
        .rev()
        .find(|i| goal.is_char_boundary(*i))
        .unwrap_or(0);
    render(&goal[..cut])
}

pub fn input_fields(flow: &Flow, vault: &dyn Vault) -> Result<Vec<InputField>> {
    flow.inputs
        .iter()
        .map(|input| {
            let once = keychain::has_once(vault, &flow.scope, &input.key)?;
            let saved = input.storage == Storage::Keychain
                && keychain::has_saved(vault, &flow.scope, &input.key)?;
            Ok(InputField {
                key: input.key.clone(),
                kind: input.kind,
                label: input.label.clone(),
                storage: input.storage,
                present: once || saved,
            })
        })
        .collect()
}

pub fn summaries(store: &Store, vault: &dyn Vault) -> Result<Vec<RecordingSummary>> {
    let mut items = Vec::new();
    for id in store.ids()? {
        let meta = store.meta(&id)?;
        let recording = store.is_recording(&id)?;
        let flow = if recording {
            None
        } else {
            Some(store.flow(&id)?)
        };
        let inputs = flow
            .as_ref()
            .map_or(Ok(Vec::new()), |f| input_fields(f, vault))?;
        items.push(RecordingSummary {
            id,
            title: meta.title,
            created_at: meta.created_at,
            steps: flow.map_or(0, |f| f.steps.len() as u32),
            recording,
            inputs,
        });
    }
    Ok(items)
}

pub fn delete(store: &Store, vault: &dyn Vault, rec: &str) -> Result<()> {
    let dir = store.existing_dir(rec)?;
    if store.is_recording(rec)? {
        bail!("recording {rec} is still running");
    }
    let flow = store.flow(rec)?;
    let mut in_use: HashSet<String> = HashSet::new();
    for other in store.ids()?.iter().filter(|id| *id != rec) {
        if store.is_recording(other)? {
            continue;
        }
        if let Ok(other_flow) = store.flow(other)
            && other_flow.scope == flow.scope
        {
            in_use.extend(other_flow.inputs.into_iter().map(|i| i.key));
        }
    }
    for input in flow.inputs.iter().filter(|i| !in_use.contains(&i.key)) {
        keychain::forget(vault, &flow.scope, &input.key)?;
    }
    Ok(fs::remove_dir_all(dir)?)
}

pub fn list_text(store: &Store, vault: &dyn Vault) -> Result<String> {
    let mut out = String::new();
    for item in summaries(store, vault)? {
        let missing = item.inputs.iter().filter(|i| !i.present).count();
        let state = if item.recording {
            "recording".to_string()
        } else {
            format!("{} steps, {missing} inputs missing", item.steps)
        };
        writeln!(
            out,
            "{}  {}  {}",
            item.id,
            state,
            item.title.replace('\n', " ")
        )?;
    }
    Ok(out)
}

fn value_text(value: &StepValue) -> String {
    match value {
        StepValue::Secret(key) => format!("secret({key})"),
        StepValue::Param(name) => format!("param({name})"),
        StepValue::Literal(text) => text.clone(),
    }
}

fn expect_text(expect: &Expect) -> String {
    match expect {
        Expect::Url(url) => format!("url {url}"),
        Expect::Response { id, method, url } => format!("response {id} {method} {url}"),
    }
}

fn kind_text(kind: StepKind) -> &'static str {
    match kind {
        StepKind::Goto => "goto",
        StepKind::Click => "click",
        StepKind::Fill => "fill",
        StepKind::Select => "select",
        StepKind::Press => "press",
    }
}

fn step_line(step: &Step) -> String {
    let mut line = format!("{:>3} {}", step.n, kind_text(step.kind));
    if step.tab > 0 {
        write!(line, " tab{}", step.tab).unwrap();
    }
    if let Some(locator) = step.locators.first() {
        write!(line, " {locator}").unwrap();
    }
    if let Some(value) = &step.value {
        write!(line, " = {}", value_text(value)).unwrap();
    }
    if let Some(expect) = &step.expect {
        write!(line, " -> {}", expect_text(expect)).unwrap();
    }
    if !step.api.is_empty() {
        write!(line, " [{}]", step.api.join(",")).unwrap();
    }
    if step.at_most_once {
        line.push_str(" AT_MOST_ONCE");
    }
    line
}

fn api_text(call: &ApiCall) -> String {
    let mut out = format!(
        "{} step{} {} {} {}{}\n",
        call.id,
        call.step,
        call.method,
        call.url_template,
        call.status.map_or("-".to_string(), |s| s.to_string()),
        if call.top { "" } else { " iframe" },
    );
    if let Some(shape) = &call.req_shape {
        writeln!(out, "  req {shape}").unwrap();
    }
    if let Some(shape) = &call.res_shape {
        writeln!(out, "  res {shape}").unwrap();
    }
    for dep in &call.deps {
        writeln!(
            out,
            "  dep {} <- {}.{}",
            dep.field, dep.from.id, dep.from.path
        )
        .unwrap();
    }
    out
}

pub fn show_flow(flow: &Flow) -> String {
    let mut out = format!(
        "{} {}\nscope {}\n",
        flow.rec,
        flow.title.replace('\n', " "),
        flow.scope
    );
    if let Some(goal) = &flow.goal {
        writeln!(out, "goal {goal}").unwrap();
    }
    if !flow.inputs.is_empty() {
        let inputs: Vec<&str> = flow.inputs.iter().map(|i| i.key.as_str()).collect();
        writeln!(out, "inputs {}", inputs.join(" ")).unwrap();
    }
    for param in &flow.params {
        writeln!(out, "param {}={:?}", param.name, param.recorded_value).unwrap();
    }
    if let Some(login) = &flow.login {
        writeln!(out, "login steps {}-{}", login.from, login.to).unwrap();
    }
    for step in &flow.steps {
        writeln!(out, "{}", step_line(step)).unwrap();
    }
    out
}

pub fn show_step(flow: &Flow, n: u32) -> Result<String> {
    let step = flow
        .steps
        .iter()
        .find(|s| s.n == n)
        .with_context(|| format!("no step {n}"))?;
    let mut out = format!("{}\n", step_line(step));
    for locator in &step.locators {
        writeln!(out, "  loc {locator}")?;
    }
    if step.shot.is_some() {
        writeln!(out, "  shot: ego-rec show {} --shot {n}", flow.rec)?;
    }
    Ok(out)
}

pub fn show_net(flow: &Flow, step: Option<u32>) -> String {
    flow.api
        .iter()
        .filter(|call| step.is_none_or(|n| call.step == n))
        .map(api_text)
        .collect()
}

pub fn shot_path(store: &Store, flow: &Flow, n: u32) -> Result<PathBuf> {
    let step = flow
        .steps
        .iter()
        .find(|s| s.n == n)
        .with_context(|| format!("no step {n}"))?;
    let seq = step
        .shot
        .with_context(|| format!("step {n} has no screenshot"))?;
    Ok(store
        .existing_dir(&flow.rec)?
        .join("shots")
        .join(format!("{seq}.jpg")))
}

pub fn start_keys(flow: &Flow) -> Vec<&str> {
    flow.inputs
        .iter()
        .filter(|i| i.when == When::Start)
        .map(|i| i.key.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(goal: Option<String>) -> Meta {
        Meta {
            id: "6a1b2c3d".into(),
            title: "t".into(),
            goal,
            start_url: "https://a.test".into(),
            scope: "a.test".into(),
            created_at: 0.0,
            schema: SCHEMA,
        }
    }

    #[test]
    fn prompt_names_the_commands_and_stays_in_budget() {
        let short = prompt(&meta(None));
        assert!(short.contains("ego-rec compile 6a1b2c3d -o automations/a-test-2c3d.mjs"));
        assert!(short.contains("Goal: replay the recording."));
        assert!(short.len() <= PROMPT_BUDGET);
        let long = prompt(&meta(Some("결제".repeat(2000))));
        assert!(
            long.len() <= PROMPT_BUDGET,
            "long goal yields {} bytes",
            long.len()
        );
        assert!(long.is_char_boundary(long.len()));
    }
}
