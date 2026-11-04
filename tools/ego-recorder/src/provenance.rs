//! Traces request values back to the earlier response or page value they came from.

use crate::flow::{Dep, DepSource};
use crate::wire::{ActionEvent, CaptureEvent, NetEvent};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use url::Url;

const MIN_VALUE_LEN: usize = 6;
const NOISE_HEADERS: &[&str] = &[
    "cookie",
    "referer",
    "origin",
    "host",
    "user-agent",
    "content-type",
    "content-length",
];

/// One raw spool line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spooled {
    pub seq: u64,
    pub event: CaptureEvent,
}

pub fn net_id(seq: u64) -> String {
    format!("n{seq}")
}

/// Request dependencies per `seq`. Expects events in time order.
pub fn compute(events: &[Spooled]) -> HashMap<u64, Vec<Dep>> {
    let mut sources: HashMap<String, DepSource> = HashMap::new();
    let mut deps = HashMap::new();
    for line in events {
        match &line.event {
            CaptureEvent::Action(action) => record_hidden(action, &mut sources),
            CaptureEvent::Net(net) => {
                let found = match_request(net, &sources);
                if !found.is_empty() {
                    deps.insert(line.seq, found);
                }
                record_response(line.seq, net, &mut sources);
            }
            _ => {}
        }
    }
    deps
}

fn record_hidden(action: &ActionEvent, sources: &mut HashMap<String, DepSource>) {
    for field in &action.hidden {
        if field.value.len() >= MIN_VALUE_LEN {
            let source = DepSource {
                id: "dom".into(),
                path: format!("hidden:{}", field.name),
            };
            sources.insert(field.value.clone(), source);
        }
    }
}

fn record_response(seq: u64, net: &NetEvent, sources: &mut HashMap<String, DepSource>) {
    let id = net_id(seq);
    for (name, value) in &net.res_headers {
        if name.eq_ignore_ascii_case("set-cookie") {
            for line in value.lines() {
                let Some((cookie, rest)) = line.split_once('=') else {
                    continue;
                };
                let cookie_value = rest.split(';').next().unwrap_or("");
                if cookie_value.len() >= MIN_VALUE_LEN {
                    let source = DepSource {
                        id: id.clone(),
                        path: format!("set-cookie:{}", cookie.trim()),
                    };
                    sources.insert(cookie_value.to_string(), source);
                }
            }
        }
    }
    let Some(body) = net.body.as_deref().filter(|_| !net.body_base64) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return;
    };
    let mut leaves = Vec::new();
    json_leaves(&json, "", &mut leaves);
    for (path, value) in leaves {
        if value.len() >= MIN_VALUE_LEN {
            sources.insert(
                value,
                DepSource {
                    id: id.clone(),
                    path,
                },
            );
        }
    }
}

fn json_leaves(value: &Value, path: &str, out: &mut Vec<(String, String)>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map {
                let next = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                json_leaves(item, &next, out);
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                json_leaves(item, &format!("{path}[{i}]"), out);
            }
        }
        Value::String(s) => out.push((path.to_string(), s.clone())),
        Value::Number(n) => out.push((path.to_string(), n.to_string())),
        _ => {}
    }
}

fn match_request(net: &NetEvent, sources: &HashMap<String, DepSource>) -> Vec<Dep> {
    let mut fields: Vec<(String, String)> = Vec::new();
    if let Ok(url) = Url::parse(&net.url) {
        for (key, value) in url.query_pairs() {
            fields.push((format!("query.{key}"), value.into_owned()));
        }
        for (i, segment) in url.path_segments().into_iter().flatten().enumerate() {
            let decoded = percent_decode_str(segment).decode_utf8_lossy().into_owned();
            fields.push((format!("path[{i}]"), decoded));
        }
    }
    for (name, value) in &net.req_headers {
        let lower = name.to_ascii_lowercase();
        if !NOISE_HEADERS.contains(&lower.as_str())
            && !lower.starts_with("sec-")
            && !lower.starts_with("accept")
        {
            fields.push((format!("header.{lower}"), value.clone()));
        }
    }
    if let Some(body) = &net.post_data {
        match serde_json::from_str::<Value>(body) {
            Ok(json) => {
                let mut leaves = Vec::new();
                json_leaves(&json, "", &mut leaves);
                fields.extend(
                    leaves
                        .into_iter()
                        .map(|(path, value)| (format!("body.{path}"), value)),
                );
            }
            Err(_) => {
                for (key, value) in url::form_urlencoded::parse(body.as_bytes()) {
                    fields.push((format!("body.{key}"), value.into_owned()));
                }
            }
        }
    }

    let mut deps: Vec<Dep> = Vec::new();
    for (field, value) in fields {
        let tokens = std::iter::once(value.as_str())
            .chain(value.split(|c: char| c.is_whitespace() || ",;:".contains(c)));
        for token in tokens {
            if token.len() < MIN_VALUE_LEN {
                continue;
            }
            if let Some(source) = sources.get(token)
                && !deps.iter().any(|d| d.field == field)
            {
                deps.push(Dep {
                    field: field.clone(),
                    from: source.clone(),
                });
            }
        }
    }
    deps
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{ActionKind, HiddenField, Target};

    fn net(seq: u64, f: impl FnOnce(&mut NetEvent)) -> Spooled {
        let mut event = NetEvent {
            method: "GET".into(),
            url: "https://a.test/x".into(),
            ..Default::default()
        };
        f(&mut event);
        Spooled {
            seq,
            event: CaptureEvent::Net(event),
        }
    }

    #[test]
    fn json_leaf_flows_into_later_post_body() {
        let events = vec![
            net(1, |n| {
                n.body = Some(r#"{"data":{"csrf":"tok-abcdef"}}"#.into())
            }),
            net(2, |n| {
                n.method = "POST".into();
                n.post_data = Some(r#"{"csrf":"tok-abcdef","qty":1}"#.into());
            }),
        ];
        let deps = compute(&events);
        assert_eq!(
            deps[&2],
            vec![Dep {
                field: "body.csrf".into(),
                from: DepSource {
                    id: "n1".into(),
                    path: "data.csrf".into()
                }
            }]
        );
    }

    #[test]
    fn value_used_before_it_was_issued_is_not_a_dependency() {
        let events = vec![
            net(1, |n| n.post_data = Some(r#"{"t":"token-123"}"#.into())),
            net(2, |n| n.body = Some(r#"{"t":"token-123"}"#.into())),
        ];
        assert!(compute(&events).is_empty());
    }

    #[test]
    fn set_cookie_and_bearer_header_and_query_are_traced() {
        let events = vec![
            net(1, |n| {
                n.res_headers = vec![(
                    "Set-Cookie".into(),
                    "xsrf=cookie-val-1; Path=/\nother=short".into(),
                )];
                n.body = Some(r#"{"access":"jwt-token-9"}"#.into());
            }),
            net(2, |n| {
                n.url = "https://a.test/x?x=cookie-val-1".into();
                n.req_headers = vec![("Authorization".into(), "Bearer jwt-token-9".into())];
            }),
        ];
        let deps = compute(&events);
        let by_field: HashMap<_, _> = deps[&2]
            .iter()
            .map(|d| (d.field.as_str(), d.from.path.as_str()))
            .collect();
        assert_eq!(by_field["query.x"], "set-cookie:xsrf");
        assert_eq!(by_field["header.authorization"], "access");
    }

    #[test]
    fn hidden_input_flows_into_form_body() {
        let action = ActionEvent {
            t: 0.0,
            tab: 1,
            kind: ActionKind::Submit,
            target: Target::default(),
            value: None,
            key: None,
            hidden: vec![HiddenField {
                name: "_csrf".into(),
                value: "hidden-token".into(),
            }],
        };
        let events = vec![
            Spooled {
                seq: 1,
                event: CaptureEvent::Action(action),
            },
            net(2, |n| n.post_data = Some("a=1&_csrf=hidden-token".into())),
        ];
        let deps = compute(&events);
        assert_eq!(deps[&2][0].from.path, "hidden:_csrf");
        assert_eq!(deps[&2][0].field, "body._csrf");
    }

    #[test]
    fn short_values_do_not_create_false_links() {
        let events = vec![
            net(1, |n| n.body = Some(r#"{"n":"12345"}"#.into())),
            net(2, |n| n.url = "https://a.test/12345".into()),
        ];
        assert!(compute(&events).is_empty());
    }
}
