//! Pure derivation of the agent-facing Flow from scrubbed events.

use crate::classify::spec_for_key;
use crate::flow::*;
use crate::wire::{ActionEvent, ActionKind, Target};
use url::Url;

const ANALYTICS_HOSTS: &[&str] = &[
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "facebook.com",
    "facebook.net",
    "segment.io",
    "segment.com",
    "sentry.io",
    "amplitude.com",
    "mixpanel.com",
    "hotjar.com",
    "datadoghq.com",
    "newrelic.com",
    "clarity.ms",
    "analytics.naver.com",
    "wcs.naver.net",
    "channel.io",
];
const STATIC_EXTENSIONS: &[&str] = &[
    "js", "mjs", "css", "map", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "woff",
    "woff2", "ttf", "otf", "eot", "mp4", "webm", "mp3",
];
const API_TYPES: &[&str] = &["XHR", "Fetch", "Document"];
const PAYMENT_WORDS_KO: &[&str] = &["결제", "구매", "주문"];
const PAYMENT_WORDS: &[&str] = &[
    "pay",
    "pays",
    "payment",
    "payments",
    "checkout",
    "purchase",
    "purchases",
    "order",
    "orders",
];

struct Draft {
    t: f64,
    seq: u64,
    tab: i32,
    kind: StepKind,
    target: Option<Target>,
    value: Option<String>,
    expect_url: Option<String>,
}

impl Draft {
    fn is_same_field(&self, target: &Target) -> bool {
        self.target
            .as_ref()
            .is_some_and(|t| t.css == target.css && t.frame_url == target.frame_url)
    }
}

pub fn derive(meta: &Meta, events: &[Stored], shots: &[u64]) -> Flow {
    let mut ordered: Vec<&Stored> = events.iter().collect();
    ordered.sort_by(|a, b| a.t().total_cmp(&b.t()));

    let drafts = draft_steps(meta, &ordered);
    let mut tab_index: Vec<i32> = Vec::new();
    let mut api: Vec<ApiCall> = Vec::new();
    let mut step_api: Vec<Vec<usize>> = vec![Vec::new(); drafts.len()];
    for event in &ordered {
        if let Stored::Net(net) = event
            && is_significant(net)
        {
            let index = drafts.iter().rposition(|d| d.t <= net.t).unwrap_or(0);
            step_api[index].push(api.len());
            api.push(ApiCall {
                id: net.id.clone(),
                step: index as u32 + 1,
                method: net.method.clone(),
                url_template: url_template(&net.url),
                status: net.status,
                top: net.top,
                req_shape: net.req_shape.clone(),
                res_shape: net.res_shape.clone(),
                deps: net.deps.clone(),
            });
        }
    }

    let once = at_most_once_steps(&drafts, &step_api, &api);
    let mut params: Vec<Param> = Vec::new();
    let mut inputs: Vec<InputSpec> = Vec::new();
    let mut steps = Vec::with_capacity(drafts.len());
    for (i, draft) in drafts.iter().enumerate() {
        if !tab_index.contains(&draft.tab) {
            tab_index.push(draft.tab);
        }
        let value = step_value(draft, &mut inputs, &mut params);
        let is_once = once.contains(&i);
        let expect = draft.expect_url.clone().map(Expect::Url).or_else(|| {
            is_once
                .then(|| payment_response(&step_api[i], &api))
                .flatten()
        });
        let next_seq = drafts.get(i + 1).map_or(u64::MAX, |d| d.seq);
        steps.push(Step {
            n: i as u32 + 1,
            kind: draft.kind,
            tab: tab_index.iter().position(|t| *t == draft.tab).unwrap_or(0) as u32,
            locators: draft.target.as_ref().map(locators).unwrap_or_default(),
            value,
            expect,
            api: step_api[i].iter().map(|a| api[*a].id.clone()).collect(),
            at_most_once: is_once,
            shot: shots
                .iter()
                .copied()
                .find(|s| *s > draft.seq && *s < next_seq),
        });
    }
    let login = login_block(&steps);

    Flow {
        schema: SCHEMA,
        rec: meta.id.clone(),
        title: meta.title.clone(),
        goal: meta.goal.clone(),
        start_url: meta.start_url.clone(),
        scope: meta.scope.clone(),
        inputs,
        params,
        steps,
        api,
        login,
    }
}

fn draft_steps(meta: &Meta, ordered: &[&Stored]) -> Vec<Draft> {
    let mut drafts: Vec<Draft> = Vec::new();
    let first_tab = ordered.first().map(|e| match e {
        Stored::Action { event, .. } => event.tab,
        Stored::Nav { event, .. } => event.tab,
        Stored::Net(net) => net.tab,
    });
    if meta.start_url.starts_with("http") {
        drafts.push(goto_draft(
            f64::NEG_INFINITY,
            0,
            first_tab.unwrap_or(0),
            &meta.start_url,
        ));
    }
    for event in ordered {
        match event {
            Stored::Action { seq, event } => apply_action(&mut drafts, *seq, event),
            Stored::Nav { seq, event } => {
                if is_user_navigation(&event.transition) {
                    let repeats = matches!(drafts.last(), Some(d) if d.kind == StepKind::Goto && d.value.as_deref() == Some(&event.url));
                    if !repeats {
                        drafts.push(goto_draft(event.t, *seq, event.tab, &event.url));
                    }
                } else if event.transition != "reload"
                    && let Some(last) = drafts.iter_mut().rev().find(|d| d.tab == event.tab)
                    && matches!(
                        last.kind,
                        StepKind::Click | StepKind::Press | StepKind::Select
                    )
                {
                    last.expect_url = Some(
                        url_template(&event.url)
                            .split('?')
                            .next()
                            .unwrap_or("")
                            .to_string(),
                    );
                }
            }
            Stored::Net(_) => {}
        }
    }
    drop_tabs_that_only_move_focus(&mut drafts);
    drafts
}

fn goto_draft(t: f64, seq: u64, tab: i32, url: &str) -> Draft {
    Draft {
        t,
        seq,
        tab,
        kind: StepKind::Goto,
        target: None,
        value: Some(url.to_string()),
        expect_url: None,
    }
}

fn is_user_navigation(transition: &str) -> bool {
    matches!(
        transition,
        "typed" | "auto_bookmark" | "generated" | "keyword" | "start_page"
    )
}

fn apply_action(drafts: &mut Vec<Draft>, seq: u64, event: &ActionEvent) {
    let target = &event.target;
    match event.kind {
        ActionKind::Click => {
            if !is_text_entry(target) {
                drafts.push(action_draft(event, seq, StepKind::Click, None));
            }
        }
        ActionKind::Input | ActionKind::Change => {
            // The browser fires change on blur, after the Tab or Enter step, repeating the fill's value.
            let repeats_the_fill = event.kind == ActionKind::Change
                && drafts
                    .iter()
                    .rev()
                    .filter(|d| matches!(d.kind, StepKind::Fill | StepKind::Select))
                    .find(|d| d.is_same_field(target))
                    .is_some_and(|d| d.value == event.value);
            if repeats_the_fill {
                return;
            }
            let kind = if target.tag == "select" {
                StepKind::Select
            } else {
                StepKind::Fill
            };
            let earlier = drafts
                .iter_mut()
                .rev()
                .take_while(|d| matches!(d.kind, StepKind::Fill | StepKind::Select))
                .find(|d| d.is_same_field(target));
            match earlier {
                Some(draft) => draft.value = event.value.clone(),
                None => drafts.push(action_draft(event, seq, kind, event.value.clone())),
            }
        }
        ActionKind::Key => {
            let key = event.key.as_deref().unwrap_or("");
            let triggers_click = matches!(target.tag.as_str(), "button" | "a");
            let inserts_newline = key == "Enter" && target.tag == "textarea";
            if !(key == "Enter" && triggers_click) && !inserts_newline {
                drafts.push(action_draft(event, seq, StepKind::Press, event.key.clone()));
            }
        }
        // A submit is the effect of the click or Enter already recorded as a step.
        ActionKind::Submit => {}
    }
}

fn action_draft(event: &ActionEvent, seq: u64, kind: StepKind, value: Option<String>) -> Draft {
    Draft {
        t: event.t,
        seq,
        tab: event.tab,
        kind,
        target: Some(event.target.clone()),
        value,
        expect_url: None,
    }
}

fn is_text_entry(target: &Target) -> bool {
    match target.tag.as_str() {
        "textarea" | "select" => true,
        "input" => !matches!(
            target.input_type.as_deref(),
            Some("button" | "submit" | "reset" | "checkbox" | "radio" | "image" | "file")
        ),
        _ => false,
    }
}

fn drop_tabs_that_only_move_focus(drafts: &mut Vec<Draft>) {
    let mut i = 0;
    while i < drafts.len() {
        let is_tab = drafts[i].kind == StepKind::Press && drafts[i].value.as_deref() == Some("Tab");
        let moves_on = drafts
            .get(i + 1)
            .is_some_and(|d| matches!(d.kind, StepKind::Fill | StepKind::Select | StepKind::Click));
        if is_tab && moves_on {
            drafts.remove(i);
        } else {
            i += 1;
        }
    }
}

fn is_significant(net: &StoredNet) -> bool {
    if !API_TYPES.contains(&net.resource_type.as_str()) {
        return false;
    }
    let Ok(url) = Url::parse(&net.url) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    if ANALYTICS_HOSTS
        .iter()
        .any(|a| host == *a || host.ends_with(&format!(".{a}")))
    {
        return false;
    }
    let extension = url
        .path()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase());
    !extension.is_some_and(|e| STATIC_EXTENSIONS.contains(&e.as_str()))
}

fn at_most_once_steps(drafts: &[Draft], step_api: &[Vec<usize>], api: &[ApiCall]) -> Vec<usize> {
    let mut matches: Vec<(usize, Vec<String>)> = Vec::new();
    for (i, draft) in drafts.iter().enumerate() {
        if !matches!(draft.kind, StepKind::Click | StepKind::Press) {
            continue;
        }
        let posts: Vec<&ApiCall> = step_api[i]
            .iter()
            .map(|a| &api[*a])
            .filter(|c| c.method != "GET")
            .collect();
        if posts.is_empty() {
            continue;
        }
        let text = draft.target.as_ref().map_or(String::new(), button_text);
        let text_matches = has_payment_word(&text);
        let paying: Vec<String> = posts
            .iter()
            .filter(|c| text_matches || has_payment_word(&c.url_template))
            .map(|c| format!("{} {}", c.method, c.url_template))
            .collect();
        if !paying.is_empty() {
            matches.push((i, paying));
        }
    }
    let mut distinct: Vec<&String> = Vec::new();
    for (_, posts) in &matches {
        // A step's own window may hold several calls; its last one stands for the step.
        if let Some(post) = posts.last().filter(|p| !distinct.contains(p)) {
            distinct.push(post);
        }
    }
    if distinct.len() > 1 {
        matches.iter().map(|(i, _)| *i).collect()
    } else {
        matches.last().map(|(i, _)| *i).into_iter().collect()
    }
}

fn button_text(target: &Target) -> String {
    [&target.name, &target.text, &target.label]
        .iter()
        .filter_map(|v| v.as_deref())
        .collect::<Vec<_>>()
        .join(" ")
}

fn has_payment_word(text: &str) -> bool {
    if PAYMENT_WORDS_KO.iter().any(|w| text.contains(w)) {
        return true;
    }
    let lower = text.to_lowercase();
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| PAYMENT_WORDS.contains(&word))
}

fn payment_response(calls: &[usize], api: &[ApiCall]) -> Option<Expect> {
    let top_posts: Vec<&ApiCall> = calls
        .iter()
        .map(|a| &api[*a])
        .filter(|c| c.method != "GET" && c.top)
        .collect();
    let call = top_posts
        .iter()
        .rev()
        .find(|c| has_payment_word(&c.url_template))
        .or(top_posts.last())?;
    Some(Expect::Response {
        id: call.id.clone(),
        method: call.method.clone(),
        url: call
            .url_template
            .split('?')
            .next()
            .unwrap_or("")
            .to_string(),
    })
}

fn step_value(
    draft: &Draft,
    inputs: &mut Vec<InputSpec>,
    params: &mut Vec<Param>,
) -> Option<StepValue> {
    let value = draft.value.as_ref()?;
    if !matches!(draft.kind, StepKind::Fill | StepKind::Select) {
        return Some(StepValue::Literal(value.clone()));
    }
    if let Some(key) = value
        .strip_prefix("{{secret:")
        .and_then(|v| v.strip_suffix("}}"))
    {
        if !inputs.iter().any(|i| i.key == key)
            && let Some(spec) = spec_for_key(key)
        {
            let suffix = key.strip_prefix(spec.key).unwrap_or("").replace('.', " ");
            inputs.push(InputSpec {
                key: key.to_string(),
                kind: spec.kind,
                label: format!("{}{suffix}", spec.label),
                when: spec.when,
                storage: spec.storage,
            });
        }
        return Some(StepValue::Secret(key.to_string()));
    }
    let target = draft.target.as_ref()?;
    let name = param_name(target, params);
    let label = [
        &target.label,
        &target.placeholder,
        &target.name_attr,
        &target.id,
    ]
    .iter()
    .find_map(|v| (*v).clone())
    .unwrap_or_else(|| name.clone());
    params.push(Param {
        name: name.clone(),
        label,
        recorded_value: value.clone(),
    });
    Some(StepValue::Param(name))
}

fn param_name(target: &Target, params: &[Param]) -> String {
    let source = [
        &target.name_attr,
        &target.id,
        &target.label,
        &target.placeholder,
    ]
    .iter()
    .find_map(|v| v.as_deref())
    .unwrap_or("field");
    let base: String = source
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_lowercase();
    let base = if base.is_empty() {
        "field".to_string()
    } else {
        base
    };
    let taken = |n: &str| params.iter().any(|p| p.name == n);
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}_{n}"))
        .find(|n| !taken(n))
        .expect("unbounded range")
}

fn login_block(steps: &[Step]) -> Option<LoginBlock> {
    let is_login =
        |s: &Step| matches!(&s.value, Some(StepValue::Secret(k)) if k.starts_with("login."));
    let first = steps.iter().position(is_login)?;
    let last = steps.iter().rposition(is_login)?;
    let submit = steps[last + 1..]
        .iter()
        .find(|s| matches!(s.kind, StepKind::Click | StepKind::Press))?;
    let post_url = match &submit.expect {
        Some(Expect::Url(url)) => Some(url.clone()),
        _ => None,
    };
    Some(LoginBlock {
        from: steps[first].n,
        to: submit.n,
        post_url,
    })
}

fn locators(target: &Target) -> Vec<String> {
    let u = &target.unique;
    let mut out = Vec::new();
    if let Some(testid) = target.testid.as_deref().filter(|_| u.testid) {
        out.push(format!("loc=css:[data-testid=\"{}\"]", css_string(testid)));
    }
    if let (Some(role), Some(name)) = (
        target.role.as_deref(),
        target.name.as_deref().filter(|_| u.role),
    ) {
        out.extend(role_locator(role, name));
    }
    if let Some(id) = target
        .id
        .as_deref()
        .filter(|id| u.id && !is_generated_id(id))
    {
        out.push(format!("loc=css:[id=\"{}\"]", css_string(id)));
    }
    if let Some(name) = target.name_attr.as_deref().filter(|_| u.name_attr) {
        out.push(format!(
            "loc=css:{}[name=\"{}\"]",
            target.tag,
            css_string(name)
        ));
    }
    if let (Some(role), Some(label)) = (
        target.role.as_deref(),
        target.label.as_deref().filter(|_| u.label),
    ) && target.name.as_deref() != Some(label)
    {
        out.extend(role_locator(role, label));
    }
    if !target.css.is_empty() {
        out.push(format!("loc=css:{}", target.css));
    }
    out.retain(|l| !l.contains("{{"));
    out
}

fn role_locator(role: &str, name: &str) -> Option<String> {
    match (name.contains('\''), name.contains('"')) {
        (false, _) => Some(format!("loc=role:{role}[name='{name}']")),
        (true, false) => Some(format!("loc=role:{role}[name=\"{name}\"]")),
        (true, true) => None,
    }
}

fn css_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Framework-assigned ids change between page loads, so they make brittle locators.
fn is_generated_id(id: &str) -> bool {
    let digits = id.chars().filter(char::is_ascii_digit).count();
    let longest_digit_run = id
        .split(|c: char| !c.is_ascii_digit())
        .map(str::len)
        .max()
        .unwrap_or(0);
    id.contains(':')
        || longest_digit_run >= 3
        || (id.len() >= 8 && digits * 3 >= id.len())
        || ["ember", "react-", "mui-", "radix-", "headlessui-", "__next"]
            .iter()
            .any(|p| id.starts_with(p))
}

/// Replaces per-run path segments and all query values with `{}`.
pub fn url_template(raw: &str) -> String {
    let Ok(url) = Url::parse(raw) else {
        return raw.to_string();
    };
    let origin = url.origin().ascii_serialization();
    let path: Vec<String> = url
        .path_segments()
        .into_iter()
        .flatten()
        .map(|segment| {
            if is_opaque_segment(segment) {
                "{}".to_string()
            } else {
                segment.to_string()
            }
        })
        .collect();
    let mut query: Vec<String> = url
        .query_pairs()
        .map(|(k, _)| format!("{k}={{}}"))
        .collect();
    query.dedup();
    let suffix = if query.is_empty() {
        String::new()
    } else {
        format!("?{}", query.join("&"))
    };
    format!("{origin}/{}{suffix}", path.join("/"))
}

fn is_opaque_segment(segment: &str) -> bool {
    let digits = segment.chars().filter(char::is_ascii_digit).count();
    let all_hex = segment.len() >= 16 && segment.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    (!segment.is_empty() && digits == segment.len())
        || all_hex
        || segment.contains("{{")
        || segment.contains("%7B%7B")
}

/// JSON type shape with no values.
pub fn json_shape(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::{Value, json};
    match value {
        Value::Null => json!("null"),
        Value::Bool(_) => json!("bool"),
        Value::Number(_) => json!("number"),
        Value::String(_) => json!("string"),
        Value::Array(items) => match items.first() {
            Some(first) => json!([json_shape(first)]),
            None => json!([]),
        },
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), json_shape(v)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{NavEvent, Unique};

    fn meta() -> Meta {
        Meta {
            id: "r1".into(),
            title: "t".into(),
            goal: None,
            start_url: "https://shop.test/login".into(),
            scope: "shop.test".into(),
            created_at: 0.0,
            schema: SCHEMA,
        }
    }

    fn target(css: &str, f: impl FnOnce(&mut Target)) -> Target {
        let mut t = Target {
            tag: "input".into(),
            css: css.into(),
            frame_url: "https://shop.test/".into(),
            ..Default::default()
        };
        f(&mut t);
        t
    }

    fn action(seq: u64, t: f64, kind: ActionKind, target: Target, value: Option<&str>) -> Stored {
        Stored::Action {
            seq,
            event: ActionEvent {
                t,
                tab: 1,
                kind,
                target,
                value: value.map(Into::into),
                key: None,
                hidden: vec![],
            },
        }
    }

    fn button(css: &str, name: &str) -> Target {
        target(css, |t| {
            t.tag = "button".into();
            t.role = Some("button".into());
            t.name = Some(name.into());
            t.unique = Unique {
                role: true,
                css: true,
                ..Default::default()
            };
        })
    }

    fn nav(seq: u64, t: f64, url: &str, transition: &str) -> Stored {
        Stored::Nav {
            seq,
            event: NavEvent {
                t,
                tab: 1,
                url: url.into(),
                transition: transition.into(),
            },
        }
    }

    fn net(seq: u64, t: f64, method: &str, url: &str) -> Stored {
        Stored::Net(StoredNet {
            id: format!("n{seq}"),
            seq,
            t,
            tab: 1,
            top: true,
            method: method.into(),
            url: url.into(),
            resource_type: "Fetch".into(),
            req_headers: vec![],
            post_data: None,
            status: Some(200),
            mime: None,
            res_headers: vec![],
            blob: None,
            truncated: false,
            failed: None,
            req_shape: None,
            res_shape: None,
            deps: vec![],
        })
    }

    #[test]
    fn repeated_input_events_merge_into_one_final_fill() {
        let qty = target("#q", |t| t.name_attr = Some("qty".into()));
        let events = vec![
            action(1, 1.0, ActionKind::Click, qty.clone(), None),
            action(2, 2.0, ActionKind::Input, qty.clone(), Some("1")),
            action(3, 3.0, ActionKind::Input, qty.clone(), Some("12")),
            action(4, 4.0, ActionKind::Change, qty, Some("123")),
        ];
        let flow = derive(&meta(), &events, &[]);
        let kinds: Vec<StepKind> = flow.steps.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec![StepKind::Goto, StepKind::Fill]);
        assert_eq!(flow.steps[1].value, Some(StepValue::Param("qty".into())));
        assert_eq!(flow.params[0].recorded_value, "123");
    }

    #[test]
    fn navigation_attaches_to_its_causing_click_as_expect() {
        let events = vec![
            action(1, 1.0, ActionKind::Click, button("#go", "Next"), None),
            nav(2, 2.0, "https://shop.test/a?x=1", "form_submit"),
            nav(3, 3.0, "https://shop.test/b/123?x=1", "link"),
        ];
        let flow = derive(&meta(), &events, &[]);
        assert_eq!(flow.steps.len(), 2);
        assert_eq!(
            flow.steps[1].expect,
            Some(Expect::Url("https://shop.test/b/{}".into()))
        );
    }

    #[test]
    fn typed_navigation_becomes_goto_and_start_url_is_not_duplicated() {
        let events = vec![
            nav(1, 1.0, "https://shop.test/login", "typed"),
            nav(2, 2.0, "https://shop.test/x", "typed"),
        ];
        let flow = derive(&meta(), &events, &[]);
        assert_eq!(
            flow.steps
                .iter()
                .filter(|s| s.kind == StepKind::Goto)
                .count(),
            2
        );
        assert_eq!(
            flow.steps[1].value,
            Some(StepValue::Literal("https://shop.test/x".into()))
        );
    }

    #[test]
    fn analytics_and_static_calls_are_not_api() {
        let events = vec![
            net(1, 1.0, "POST", "https://www.google-analytics.com/g/collect"),
            net(2, 1.0, "GET", "https://shop.test/app.js"),
            net(3, 1.0, "POST", "https://shop.test/api/cart"),
        ];
        let flow = derive(&meta(), &events, &[]);
        let ids: Vec<&str> = flow.api.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["n3"]);
    }

    #[test]
    fn only_the_last_payment_click_is_at_most_once_when_posts_repeat() {
        let events = vec![
            action(1, 1.0, ActionKind::Click, button("#a", "결제하기"), None),
            net(2, 1.5, "POST", "https://shop.test/api/charge"),
            action(3, 2.0, ActionKind::Click, button("#b", "결제하기"), None),
            net(4, 2.5, "POST", "https://shop.test/api/charge"),
        ];
        let flow = derive(&meta(), &events, &[]);
        let once: Vec<u32> = flow
            .steps
            .iter()
            .filter(|s| s.at_most_once)
            .map(|s| s.n)
            .collect();
        assert_eq!(once, vec![3]);
    }

    #[test]
    fn distinct_payment_posts_are_all_at_most_once() {
        let events = vec![
            action(1, 1.0, ActionKind::Click, button("#a", "Next"), None),
            net(2, 1.5, "POST", "https://shop.test/api/order"),
            action(3, 2.0, ActionKind::Click, button("#b", "Confirm"), None),
            net(4, 2.5, "POST", "https://shop.test/api/payments"),
        ];
        let flow = derive(&meta(), &events, &[]);
        let once: Vec<u32> = flow
            .steps
            .iter()
            .filter(|s| s.at_most_once)
            .map(|s| s.n)
            .collect();
        assert_eq!(once, vec![2, 3]);
    }

    #[test]
    fn payment_words_need_a_non_get_request_and_real_word_boundaries() {
        let events = vec![
            action(
                1,
                1.0,
                ActionKind::Click,
                button("#a", "결제 내역 보기"),
                None,
            ),
            net(2, 1.5, "GET", "https://shop.test/api/history"),
            action(3, 2.0, ActionKind::Click, button("#b", "Save"), None),
            net(4, 2.5, "POST", "https://shop.test/api/payload/border"),
        ];
        let flow = derive(&meta(), &events, &[]);
        assert!(flow.steps.iter().all(|s| !s.at_most_once));
    }

    #[test]
    fn payment_expect_is_the_top_frame_post_response() {
        let mut iframe = net(2, 1.2, "POST", "https://pg.test/tokenize");
        if let Stored::Net(n) = &mut iframe {
            n.top = false;
        }
        let events = vec![
            action(1, 1.0, ActionKind::Click, button("#pay", "Pay"), None),
            iframe,
            net(3, 1.4, "POST", "https://shop.test/api/charge?x=1"),
        ];
        let flow = derive(&meta(), &events, &[]);
        let step = &flow.steps[1];
        assert!(step.at_most_once);
        assert_eq!(step.api, vec!["n2", "n3"]);
        assert_eq!(
            step.expect,
            Some(Expect::Response {
                id: "n3".into(),
                method: "POST".into(),
                url: "https://shop.test/api/charge".into()
            })
        );
    }

    #[test]
    fn locators_rank_stable_candidates_and_reject_generated_ids() {
        let t = target("div > input", |t| {
            t.testid = Some("email".into());
            t.role = Some("textbox".into());
            t.name = Some("Email".into());
            t.id = Some("input-8123".into());
            t.name_attr = Some("email".into());
            t.unique = Unique {
                testid: true,
                role: true,
                id: true,
                name_attr: true,
                label: false,
                css: true,
            };
        });
        assert_eq!(
            locators(&t),
            vec![
                "loc=css:[data-testid=\"email\"]",
                "loc=role:textbox[name='Email']",
                "loc=css:input[name=\"email\"]",
                "loc=css:div > input",
            ]
        );
        for generated in [
            ":r1:",
            "ember123",
            "input-8123",
            "a1b2c3d4e5",
            "react-select-2",
        ] {
            assert!(is_generated_id(generated), "{generated}");
        }
        for stable in ["login-email", "cardNumber", "step2"] {
            assert!(!is_generated_id(stable), "{stable}");
        }
    }

    #[test]
    fn non_unique_candidates_are_skipped() {
        let t = target("form input", |t| {
            t.role = Some("textbox".into());
            t.name = Some("Email".into());
            t.name_attr = Some("email".into());
            t.unique.name_attr = true;
        });
        assert_eq!(
            locators(&t),
            vec!["loc=css:input[name=\"email\"]", "loc=css:form input"]
        );
    }

    #[test]
    fn login_block_spans_first_login_fill_through_submit() {
        let email = target("#e", |t| t.name_attr = Some("email".into()));
        let pw = target("#p", |t| t.name_attr = Some("password".into()));
        let events = vec![
            action(
                1,
                1.0,
                ActionKind::Input,
                email,
                Some("{{secret:login.username}}"),
            ),
            action(
                2,
                2.0,
                ActionKind::Input,
                pw,
                Some("{{secret:login.password}}"),
            ),
            action(3, 3.0, ActionKind::Click, button("#l", "Login"), None),
            nav(4, 4.0, "https://shop.test/checkout", "link"),
        ];
        let flow = derive(&meta(), &events, &[]);
        assert_eq!(
            flow.login,
            Some(LoginBlock {
                from: 2,
                to: 4,
                post_url: Some("https://shop.test/checkout".into())
            })
        );
        assert_eq!(
            flow.inputs
                .iter()
                .map(|i| i.key.as_str())
                .collect::<Vec<_>>(),
            vec!["login.username", "login.password"]
        );
    }

    #[test]
    fn split_card_fields_keep_their_own_input() {
        let a = target("#c1", |t| t.name_attr = Some("card1".into()));
        let b = target("#c2", |t| t.name_attr = Some("card2".into()));
        let events = vec![
            action(1, 1.0, ActionKind::Input, a, Some("{{secret:card.number}}")),
            action(
                2,
                2.0,
                ActionKind::Input,
                b,
                Some("{{secret:card.number.2}}"),
            ),
        ];
        let flow = derive(&meta(), &events, &[]);
        assert_eq!(flow.inputs.len(), 2);
        assert_eq!(flow.inputs[1].label, "카드번호 2");
    }

    #[test]
    fn change_after_tab_does_not_repeat_the_fill() {
        let qty = target("#q", |t| t.name_attr = Some("qty".into()));
        let mut tab = action(2, 2.0, ActionKind::Key, qty.clone(), None);
        if let Stored::Action { event, .. } = &mut tab {
            event.key = Some("Tab".into());
        }
        let flow = derive(
            &meta(),
            &[
                action(1, 1.0, ActionKind::Input, qty.clone(), Some("3")),
                tab,
                action(3, 3.0, ActionKind::Change, qty, Some("3")),
            ],
            &[],
        );
        assert_eq!(flow.params.len(), 1);
        let fills = flow
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Fill)
            .count();
        assert_eq!(fills, 1);
    }

    #[test]
    fn tab_is_dropped_only_when_it_just_moves_focus() {
        let field = target("#a", |t| t.name_attr = Some("a".into()));
        let mut tab = action(2, 2.0, ActionKind::Key, field.clone(), None);
        if let Stored::Action { event, .. } = &mut tab {
            event.key = Some("Tab".into());
        }
        let events = vec![
            action(1, 1.0, ActionKind::Input, field.clone(), Some("x")),
            tab,
            action(3, 3.0, ActionKind::Click, button("#b", "Go"), None),
        ];
        let flow = derive(&meta(), &events, &[]);
        assert!(flow.steps.iter().all(|s| s.kind != StepKind::Press));
    }

    #[test]
    fn shapes_hold_no_values() {
        let shape = json_shape(&serde_json::json!({"a": "secret", "b": [{"c": 1}], "d": null}));
        assert_eq!(
            shape,
            serde_json::json!({"a": "string", "b": [{"c": "number"}], "d": "null"})
        );
    }

    #[test]
    fn templates_mask_ids_and_query_values() {
        assert_eq!(
            url_template("https://a.test/o/123/x?k=v&z=1"),
            "https://a.test/o/{}/x?k={}&z={}"
        );
    }
}
