//! Maps a DOM field to its sensitivity class. The one registry of field kinds.

use crate::flow::{FieldKind, Storage, When};
use crate::wire::Target;

pub struct FieldSpec {
    pub kind: FieldKind,
    pub key: &'static str,
    pub label: &'static str,
    pub storage: Storage,
    pub when: When,
    pub autocomplete: &'static [&'static str],
    /// Matched against the field's descriptors with case and separators removed.
    pub keywords: &'static [&'static str],
}

// Order is priority: a card PIN is `type=password` and says 비밀번호, so card kinds precede Password.
pub const REGISTRY: &[FieldSpec] = &[
    FieldSpec {
        kind: FieldKind::CardCvc,
        key: "card.cvc",
        label: "보안코드(CVC)",
        storage: Storage::Ask,
        when: When::Start,
        autocomplete: &["cc-csc"],
        keywords: &[
            "cvc",
            "cvv",
            "csc",
            "cvn",
            "보안코드",
            "보안번호",
            "securitycode",
            "cardcode",
        ],
    },
    FieldSpec {
        kind: FieldKind::CardPin,
        key: "card.pin",
        label: "카드 비밀번호",
        storage: Storage::Ask,
        when: When::Start,
        autocomplete: &[],
        keywords: &["카드비밀번호", "cardpassword", "cardpin", "cardpw"],
    },
    FieldSpec {
        kind: FieldKind::Otp,
        key: "otp",
        label: "인증번호",
        storage: Storage::Ask,
        when: When::Step,
        autocomplete: &["one-time-code"],
        keywords: &[
            "otp",
            "인증번호",
            "인증코드",
            "onetime",
            "verificationcode",
            "smscode",
            "authcode",
        ],
    },
    FieldSpec {
        kind: FieldKind::CardNumber,
        key: "card.number",
        label: "카드번호",
        storage: Storage::Keychain,
        when: When::Start,
        autocomplete: &["cc-number"],
        keywords: &[
            "cardnumber",
            "cardno",
            "cardnum",
            "ccnumber",
            "ccnum",
            "카드번호",
        ],
    },
    FieldSpec {
        kind: FieldKind::CardExp,
        key: "card.exp",
        label: "유효기간",
        storage: Storage::Keychain,
        when: When::Start,
        autocomplete: &["cc-exp", "cc-exp-month", "cc-exp-year"],
        keywords: &[
            "expiry",
            "expiration",
            "expdate",
            "cardexp",
            "ccexp",
            "expmonth",
            "expyear",
            "mmyy",
            "유효기간",
            "만료",
        ],
    },
    FieldSpec {
        kind: FieldKind::CardName,
        key: "card.name",
        label: "카드 소유자",
        storage: Storage::Keychain,
        when: When::Start,
        autocomplete: &["cc-name"],
        keywords: &[
            "cardholder",
            "cardname",
            "nameoncard",
            "ccname",
            "카드소유자",
            "소유자명",
        ],
    },
    FieldSpec {
        kind: FieldKind::Password,
        key: "login.password",
        label: "비밀번호",
        storage: Storage::Keychain,
        when: When::Start,
        autocomplete: &["current-password", "new-password"],
        keywords: &["password", "passwd", "pwd", "비밀번호", "패스워드"],
    },
    FieldSpec {
        kind: FieldKind::Username,
        key: "login.username",
        label: "아이디/이메일",
        storage: Storage::Keychain,
        when: When::Start,
        autocomplete: &["username", "email"],
        keywords: &["email", "username", "userid", "loginid", "이메일", "아이디"],
    },
];

pub fn spec(kind: FieldKind) -> Option<&'static FieldSpec> {
    REGISTRY.iter().find(|s| s.kind == kind)
}

/// Resolves `card.number` and the `card.number.2` form used for split fields.
pub fn spec_for_key(key: &str) -> Option<&'static FieldSpec> {
    let base = key
        .rsplit_once('.')
        .filter(|(_, n)| n.parse::<u32>().is_ok())
        .map_or(key, |(b, _)| b);
    REGISTRY.iter().find(|s| s.key == base)
}

pub fn classify(target: &Target) -> FieldKind {
    let autocomplete = target.autocomplete.as_deref().unwrap_or("").to_lowercase();
    let tokens: Vec<&str> = autocomplete.split_whitespace().collect();
    if let Some(found) = REGISTRY
        .iter()
        .find(|s| s.autocomplete.iter().any(|a| tokens.contains(a)))
    {
        return found.kind;
    }

    let haystack: String = [
        &target.name_attr,
        &target.id,
        &target.label,
        &target.placeholder,
        &target.name,
    ]
    .iter()
    .filter_map(|v| v.as_deref())
    .flat_map(|v| v.chars())
    .filter(|c| c.is_alphanumeric())
    .flat_map(char::to_lowercase)
    .collect();
    if let Some(found) = REGISTRY
        .iter()
        .find(|s| s.keywords.iter().any(|k| haystack.contains(k)))
    {
        return found.kind;
    }

    match target.input_type.as_deref() {
        Some("password") => FieldKind::Password,
        Some("email") => FieldKind::Username,
        _ => FieldKind::Plain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(f: impl FnOnce(&mut Target)) -> Target {
        let mut t = Target {
            tag: "input".into(),
            ..Default::default()
        };
        f(&mut t);
        t
    }

    #[test]
    fn autocomplete_wins_over_misleading_names() {
        let t = field(|t| {
            t.autocomplete = Some("section-a cc-number".into());
            t.name_attr = Some("password".into());
        });
        assert_eq!(classify(&t), FieldKind::CardNumber);
    }

    #[test]
    fn korean_labels_classify() {
        let cases = [
            ("비밀번호", FieldKind::Password),
            ("카드번호", FieldKind::CardNumber),
            ("유효기간", FieldKind::CardExp),
            ("인증번호", FieldKind::Otp),
            ("보안코드", FieldKind::CardCvc),
            ("이메일", FieldKind::Username),
            ("아이디", FieldKind::Username),
        ];
        for (label, want) in cases {
            assert_eq!(
                classify(&field(|t| t.label = Some(label.into()))),
                want,
                "{label}"
            );
        }
    }

    #[test]
    fn card_pin_never_becomes_the_login_password() {
        let t = field(|t| {
            t.input_type = Some("password".into());
            t.label = Some("카드 비밀번호 앞 2자리".into());
        });
        assert_eq!(classify(&t), FieldKind::CardPin);
    }

    #[test]
    fn cvc_with_password_type_stays_ask_only() {
        let t = field(|t| {
            t.input_type = Some("password".into());
            t.name_attr = Some("card_cvv".into());
        });
        let kind = classify(&t);
        assert_eq!(kind, FieldKind::CardCvc);
        assert_eq!(spec(kind).unwrap().storage, Storage::Ask);
    }

    #[test]
    fn password_type_alone_is_sensitive() {
        let t = field(|t| t.input_type = Some("password".into()));
        assert_eq!(classify(&t), FieldKind::Password);
    }

    #[test]
    fn ordinary_fields_stay_plain() {
        for name in ["quantity", "q", "export_format", "address", "coupon"] {
            assert_eq!(
                classify(&field(|t| t.name_attr = Some(name.into()))),
                FieldKind::Plain,
                "{name}"
            );
        }
    }

    #[test]
    fn split_field_keys_resolve_to_their_spec() {
        assert_eq!(
            spec_for_key("card.number.2").unwrap().kind,
            FieldKind::CardNumber
        );
        assert_eq!(spec_for_key("otp").unwrap().kind, FieldKind::Otp);
        assert!(spec_for_key("nope").is_none());
    }
}
