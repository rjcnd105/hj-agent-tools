//! Turns a Flow into a script that runs with no edits.

use crate::flow::{Flow, Meta, Step};
use crate::install::EXT_ID;
use crate::view::{slug, start_keys};
use anyhow::Result;
use std::fmt::Write;

const RUNTIME: &str = include_str!("runtime.mjs");

/// `test` must not trigger anything irreversible. Without a recognized payment step it stops
/// before the last state-changing step, since recognition can miss a payment.
pub fn test_stop_step(flow: &Flow) -> Option<u32> {
    if let Some(step) = flow.steps.iter().find(|s| s.at_most_once) {
        return Some(step.n);
    }
    let mutates = |s: &&Step| {
        s.api
            .iter()
            .any(|id| flow.api.iter().any(|a| a.id == *id && a.method != "GET"))
    };
    flow.steps.iter().rev().find(mutates).map(|s| s.n)
}

fn comment_text(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

fn json<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

pub fn header(meta: &Meta, flow: &Flow) -> Result<String> {
    let mut out = String::new();
    writeln!(
        out,
        "// ego-rec compile {}: {}",
        flow.rec,
        comment_text(&flow.title)
    )?;
    writeln!(
        out,
        "// Run with `ego-rec test <file>` (stops before payment) or `ego-rec run <file>` (real payment)."
    )?;
    writeln!(out, "const REC = {};", json(&flow.rec)?)?;
    writeln!(out, "const SCRIPT = {};", json(&slug(meta))?)?;
    writeln!(
        out,
        "if (!globalThis.__egoRec) throw new Error(\"Run through `ego-rec test` or `ego-rec run`.\");"
    )?;
    writeln!(out, "const ARGS = globalThis.__egoRec.args;")?;
    writeln!(
        out,
        "const STOP_BEFORE_AT_MOST_ONCE = globalThis.__egoRec.stopBeforeAtMostOnce;"
    )?;
    writeln!(out, "const EXT_ID = {};", json(&EXT_ID)?)?;
    writeln!(out, "const PARAMS = {{")?;
    for param in &flow.params {
        writeln!(out, "  // TODO(param) {}", comment_text(&param.label))?;
        writeln!(
            out,
            "  {}: ARGS[{}] ?? {},",
            json(&param.name)?,
            json(&param.name)?,
            json(&param.recorded_value)?
        )?;
    }
    writeln!(out, "}};")?;
    writeln!(out, "const START_INPUTS = {};", json(&start_keys(flow))?)?;
    writeln!(out, "const LOGIN = {};", json(&flow.login)?)?;
    writeln!(
        out,
        "const TEST_STOP_STEP = {};",
        json(&test_stop_step(flow))?
    )?;
    writeln!(out, "const STEPS = [")?;
    for step in &flow.steps {
        writeln!(out, "  {},", step_json(step)?)?;
    }
    writeln!(out, "];")?;
    Ok(out)
}

fn step_json(step: &Step) -> Result<String> {
    let mut object = serde_json::Map::new();
    object.insert("n".into(), step.n.into());
    object.insert("kind".into(), serde_json::to_value(step.kind)?);
    if step.tab > 0 {
        object.insert("tab".into(), step.tab.into());
    }
    if !step.locators.is_empty() {
        object.insert("locators".into(), serde_json::to_value(&step.locators)?);
    }
    if let Some(value) = &step.value {
        object.insert("value".into(), serde_json::to_value(value)?);
    }
    if let Some(expect) = &step.expect {
        object.insert("expect".into(), serde_json::to_value(expect)?);
    }
    if step.at_most_once {
        object.insert("at_most_once".into(), true.into());
    }
    Ok(serde_json::Value::Object(object).to_string())
}

pub fn compile(meta: &Meta, flow: &Flow) -> Result<String> {
    Ok(format!("{}{RUNTIME}", header(meta, flow)?))
}

/// The recording a compiled script belongs to, read back from its header.
pub fn script_rec(script: &str) -> Option<&str> {
    script
        .lines()
        .find_map(|line| line.strip_prefix("const REC = \"")?.strip_suffix("\";"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::*;
    use std::fs;
    use std::path::Path;

    fn fixture() -> (Meta, Flow) {
        let meta = Meta {
            id: "6a1b2c3d".into(),
            title: "Shop\ncheckout".into(),
            goal: None,
            start_url: "https://shop.test/login".into(),
            scope: "shop.test".into(),
            created_at: 0.0,
            schema: SCHEMA,
        };
        let step = |n: u32, kind: StepKind, locators: &[&str], value: Option<StepValue>| Step {
            n,
            kind,
            tab: 0,
            locators: locators.iter().map(|l| l.to_string()).collect(),
            value,
            expect: None,
            api: vec![],
            at_most_once: false,
            shot: None,
        };
        let mut pay = step(
            5,
            StepKind::Click,
            &["loc=role:button[name='결제하기']"],
            None,
        );
        pay.at_most_once = true;
        pay.api = vec!["n9".into()];
        pay.expect = Some(Expect::Response {
            id: "n9".into(),
            method: "POST".into(),
            url: "https://shop.test/api/charge".into(),
        });
        let mut login = step(3, StepKind::Click, &["loc=role:button[name='Login']"], None);
        login.expect = Some(Expect::Url("https://shop.test/checkout".into()));
        let flow = Flow {
            schema: SCHEMA,
            rec: meta.id.clone(),
            title: meta.title.clone(),
            goal: None,
            start_url: meta.start_url.clone(),
            scope: meta.scope.clone(),
            inputs: vec![InputSpec {
                key: "login.password".into(),
                kind: FieldKind::Password,
                label: "비밀번호".into(),
                when: When::Start,
                storage: Storage::Keychain,
            }],
            params: vec![Param {
                name: "qty".into(),
                label: "수량\ninjected".into(),
                recorded_value: "2\"".into(),
            }],
            steps: vec![
                step(
                    1,
                    StepKind::Goto,
                    &[],
                    Some(StepValue::Literal(meta.start_url.clone())),
                ),
                step(
                    2,
                    StepKind::Fill,
                    &["loc=css:#p"],
                    Some(StepValue::Secret("login.password".into())),
                ),
                login,
                step(
                    4,
                    StepKind::Fill,
                    &["loc=css:#q"],
                    Some(StepValue::Param("qty".into())),
                ),
                pay,
            ],
            api: vec![],
            login: Some(LoginBlock {
                from: 2,
                to: 3,
                post_url: Some("https://shop.test/checkout".into()),
            }),
        };
        (meta, flow)
    }

    #[test]
    fn generated_header_matches_golden() {
        let (meta, flow) = fixture();
        let actual = header(&meta, &flow).unwrap();
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/header.mjs");
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            fs::write(&path, &actual).unwrap();
        }
        assert_eq!(
            actual,
            fs::read_to_string(&path).unwrap(),
            "rerun with UPDATE_GOLDEN=1 if this change is intended"
        );
    }

    #[test]
    fn script_names_its_recording() {
        let (meta, flow) = fixture();
        assert_eq!(
            script_rec(&compile(&meta, &flow).unwrap()),
            Some("6a1b2c3d")
        );
    }

    #[test]
    fn test_mode_stops_at_payment_or_else_at_the_last_mutation() {
        let (_, mut flow) = fixture();
        assert_eq!(test_stop_step(&flow), Some(5));
        flow.steps[4].at_most_once = false;
        assert_eq!(
            test_stop_step(&flow),
            None,
            "no call in the fixture changes state"
        );
        flow.api.push(ApiCall {
            id: "n9".into(),
            step: 5,
            method: "POST".into(),
            url_template: "https://shop.test/x".into(),
            status: None,
            top: true,
            req_shape: None,
            res_shape: None,
            deps: vec![],
        });
        assert_eq!(test_stop_step(&flow), Some(5));
    }
}
