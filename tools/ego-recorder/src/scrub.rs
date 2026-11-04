//! Removes secret values, in every encoding they travel in, from recorded data.

use crate::flow::FieldKind;
use aho_corasick::{AhoCorasick, MatchKind};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::Value;
use std::collections::BTreeMap;

const MIN_SECRET_LEN: usize = 3;
const MIN_SESSION_LEN: usize = 6;

/// Encoders disagree on which punctuation stays literal, and a secret with a `.` shows the difference.
const PERCENT_SETS: [&AsciiSet; 5] = [
    NON_ALPHANUMERIC,
    // RFC 3986 unreserved.
    &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~'),
    // JavaScript encodeURIComponent.
    &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~')
        .remove(b'!')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')'),
    // URLSearchParams and HTML forms, which also turn a space into `+`.
    &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'*'),
    // JavaScript encodeURI, for a secret that travels in a whole URL.
    &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~')
        .remove(b'!')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')')
        .remove(b';')
        .remove(b'/')
        .remove(b'?')
        .remove(b':')
        .remove(b'@')
        .remove(b'&')
        .remove(b'=')
        .remove(b'+')
        .remove(b'$')
        .remove(b',')
        .remove(b'#'),
];

#[derive(Debug, Clone, Default)]
pub struct SecretTable {
    /// Plaintext form to the token that replaces it.
    values: BTreeMap<String, String>,
}

pub fn secret_token(key: &str) -> String {
    format!("{{{{secret:{key}}}}}")
}

pub fn session_token(name: &str) -> String {
    format!("{{{{session:{name}}}}}")
}

impl SecretTable {
    pub fn add_secret(&mut self, key: &str, value: &str, kind: FieldKind) {
        let token = secret_token(key);
        self.add(value, &token, MIN_SECRET_LEN);
        if matches!(kind, FieldKind::CardNumber | FieldKind::CardExp) {
            // Sites normalize `4242 4242` and `12/30` before sending them.
            let digits: String = value.chars().filter(char::is_ascii_digit).collect();
            self.add(&digits, &token, MIN_SECRET_LEN);
        }
    }

    pub fn add_session(&mut self, name: &str, value: &str) {
        self.add(value, &session_token(name), MIN_SESSION_LEN);
    }

    fn add(&mut self, value: &str, token: &str, min_len: usize) {
        if value.len() >= min_len {
            self.values.insert(value.to_string(), token.to_string());
        }
    }

    pub fn scrubber(&self) -> Scrubber {
        let mut pairs: BTreeMap<Vec<u8>, String> = BTreeMap::new();
        for (value, token) in &self.values {
            for variant in variants(value) {
                pairs.entry(variant).or_insert_with(|| token.clone());
            }
        }
        let (patterns, tokens): (Vec<_>, Vec<_>) = pairs.into_iter().unzip();
        let matcher = AhoCorasick::builder()
            .match_kind(MatchKind::LeftmostLongest)
            .build(&patterns)
            .expect("patterns are small literals");
        Scrubber { matcher, tokens }
    }
}

fn variants(value: &str) -> Vec<Vec<u8>> {
    let bytes = value.as_bytes();
    let mut out: Vec<Vec<u8>> = vec![
        bytes.to_vec(),
        value.to_lowercase().into_bytes(),
        json_escaped(value).into_bytes(),
        json_ascii_escaped(value).into_bytes(),
        html_escaped(value).into_bytes(),
    ];
    for set in PERCENT_SETS {
        let encoded = utf8_percent_encode(value, set).to_string();
        out.push(lowercase_hex(&encoded).into_bytes());
        out.push(encoded.replace("%20", "+").into_bytes());
        out.push(encoded.into_bytes());
    }
    for engine in [&STANDARD, &URL_SAFE] {
        out.push(engine.encode(bytes).into_bytes());
    }
    for engine in [&STANDARD_NO_PAD, &URL_SAFE_NO_PAD] {
        out.push(engine.encode(bytes).into_bytes());
        out.extend(embedded_base64(bytes, engine));
    }
    out.retain(|v| !v.is_empty());
    out
}

/// The stable middle of the base64 of `secret` when it sits inside a longer plaintext,
/// such as a JSON document that is base64 encoded as a whole.
fn embedded_base64(bytes: &[u8], engine: &base64::engine::GeneralPurpose) -> Vec<Vec<u8>> {
    if bytes.len() < 6 {
        return Vec::new();
    }
    (1..=2)
        .map(|pad| {
            let mut buf = vec![0u8; pad];
            buf.extend_from_slice(bytes);
            let encoded = engine.encode(&buf);
            let skip = (pad * 8).div_ceil(6);
            let keep = (buf.len() * 8) / 6;
            encoded.as_bytes()[skip..keep].to_vec()
        })
        .collect()
}

fn lowercase_hex(encoded: &str) -> String {
    let mut parts = encoded.split('%');
    let mut out = parts.next().unwrap_or_default().to_string();
    for part in parts {
        let hex = part.get(..2).unwrap_or(part);
        out.push('%');
        out.push_str(&hex.to_lowercase());
        out.push_str(&part[hex.len()..]);
    }
    out
}

fn json_escaped(value: &str) -> String {
    let quoted = serde_json::to_string(value).expect("strings serialize");
    quoted[1..quoted.len() - 1].to_string()
}

fn json_ascii_escaped(value: &str) -> String {
    let mut out = String::new();
    for c in json_escaped(value).chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

fn html_escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub struct Scrubber {
    matcher: AhoCorasick,
    tokens: Vec<String>,
}

impl Scrubber {
    pub fn bytes(&self, input: &[u8]) -> Vec<u8> {
        self.matcher.replace_all_bytes(input, &self.tokens)
    }

    pub fn text(&self, input: &str) -> String {
        self.matcher.replace_all(input, &self.tokens)
    }

    pub fn json(&self, value: &mut Value) {
        match value {
            Value::String(s) => *s = self.text(s),
            Value::Array(items) => items.iter_mut().for_each(|v| self.json(v)),
            Value::Object(map) => {
                let taken = std::mem::take(map);
                for (key, mut item) in taken {
                    self.json(&mut item);
                    map.insert(self.text(&key), item);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64;

    fn scrubber(value: &str, kind: FieldKind) -> Scrubber {
        let mut table = SecretTable::default();
        table.add_secret("k", value, kind);
        table.scrubber()
    }

    #[test]
    fn removes_every_encoding_of_a_secret() {
        let secret = "C@nary Pass/77";
        let s = scrubber(secret, FieldKind::Password);
        let encoded = utf8_percent_encode(secret, NON_ALPHANUMERIC).to_string();
        for form in [
            secret.to_string(),
            encoded.clone(),
            encoded.replace("%20", "+"),
            B64.encode(secret),
            URL_SAFE_NO_PAD.encode(secret),
            serde_json::to_string(secret).unwrap(),
        ] {
            let out = s.text(&format!("before {form} after"));
            assert!(!out.contains(&form), "{form} survived in {out}");
            assert!(out.contains("{{secret:k}}"), "{out}");
        }
    }

    #[test]
    fn secret_inside_a_base64_document_is_removed() {
        let secret = "topsecretvalue";
        let s = scrubber(secret, FieldKind::Password);
        for prefix in ["{\"a\":\"", "{\"ab\":\"", "{\"abc\":\""] {
            let doc = B64.encode(format!("{prefix}{secret}\"}}"));
            let out = s.text(&doc);
            assert_ne!(out, doc, "alignment of {prefix} was not scrubbed");
        }
    }

    #[test]
    fn korean_secret_matches_unicode_escaped_json() {
        let s = scrubber("홍길동", FieldKind::CardName);
        let out = s.text(r#"{"holder":"홍길동"}"#);
        assert_eq!(out, r#"{"holder":"{{secret:k}}"}"#);
    }

    #[test]
    fn card_numbers_match_when_normalized() {
        let s = scrubber("4242 4242 4242 4242", FieldKind::CardNumber);
        assert_eq!(s.text("pan=4242424242424242"), "pan={{secret:k}}");
    }

    #[test]
    fn numbers_in_json_keep_their_type_and_keys_are_scrubbed() {
        let s = scrubber("913", FieldKind::CardCvc);
        let mut v = serde_json::json!({"t": 1762913000, "913": "x913y"});
        s.json(&mut v);
        assert_eq!(
            v,
            serde_json::json!({"t": 1762913000, "{{secret:k}}": "x{{secret:k}}y"})
        );
    }

    #[test]
    fn short_session_values_are_not_global_scrub_terms() {
        let mut table = SecretTable::default();
        table.add_session("lang", "en");
        table.add_session("sid", "abcdef123");
        let s = table.scrubber();
        assert_eq!(s.text("en abcdef123"), "en {{session:sid}}");
    }

    #[test]
    fn scrubs_every_common_percent_encoding_of_a_value_with_punctuation() {
        let mut table = SecretTable::default();
        table.add_secret("login.username", "Me.you+a b@x.test", FieldKind::Username);
        let scrubber = table.scrubber();
        for encoded in [
            "Me.you%2Ba%20b%40x.test",
            "Me.you%2ba%20b%40x.test",
            "Me.you%2Ba+b%40x.test",
            "Me%2Eyou%2Ba%20b%40x%2Etest",
            "Me.you+a%20b@x.test",
        ] {
            assert_eq!(
                scrubber.text(&format!("u={encoded}&z=1")),
                "u={{secret:login.username}}&z=1",
                "{encoded} must be scrubbed"
            );
        }
    }
}
