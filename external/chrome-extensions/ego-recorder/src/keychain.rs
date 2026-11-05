//! Secret values. Accounts are `<scope>/<key>`, with `#once` for values a single run consumes.

use anyhow::{Context, Result};
use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

const ITEM_NOT_FOUND: i32 = -25300;
const ONCE_SUFFIX: &str = "#once";
const ONCE_TTL_SECS: u64 = 600;

pub trait Vault {
    fn read(&self, account: &str) -> Result<Option<String>>;
    fn write(&self, account: &str, value: &str) -> Result<()>;
    fn remove(&self, account: &str) -> Result<()>;
    fn accounts(&self) -> Result<Vec<String>>;
}

pub struct Keychain {
    service: String,
}

impl Keychain {
    pub fn from_env() -> Self {
        Self {
            service: std::env::var("EGO_REC_KEYCHAIN_SERVICE")
                .unwrap_or_else(|_| "ego-recorder".into()),
        }
    }
}

impl Vault for Keychain {
    fn read(&self, account: &str) -> Result<Option<String>> {
        match get_generic_password(&self.service, account) {
            Ok(bytes) => Ok(Some(
                String::from_utf8(bytes).context("keychain value is not UTF-8")?,
            )),
            Err(e) if e.code() == ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(e).context("reading from the Keychain"),
        }
    }

    fn write(&self, account: &str, value: &str) -> Result<()> {
        set_generic_password(&self.service, account, value.as_bytes())
            .context("writing to the Keychain")
    }

    fn remove(&self, account: &str) -> Result<()> {
        match delete_generic_password(&self.service, account) {
            Err(e) if e.code() != ITEM_NOT_FOUND => Err(e).context("deleting from the Keychain"),
            _ => Ok(()),
        }
    }

    fn accounts(&self) -> Result<Vec<String>> {
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(&self.service)
            .load_attributes(true)
            .limit(Limit::All)
            .search();
        match found {
            Ok(items) => Ok(items
                .iter()
                .filter_map(|item| item.simplify_dict()?.remove("acct"))
                .collect()),
            Err(e) if e.code() == ITEM_NOT_FOUND => Ok(Vec::new()),
            Err(e) => Err(e).context("listing the Keychain"),
        }
    }
}

fn account(scope: &str, key: &str) -> String {
    format!("{scope}/{key}")
}

fn once_account(scope: &str, key: &str) -> String {
    format!("{scope}/{key}{ONCE_SUFFIX}")
}

pub fn save(vault: &dyn Vault, scope: &str, key: &str, value: &str) -> Result<()> {
    vault.write(&account(scope, key), value)
}

/// The creation time travels with the value because sweeping must not depend on Keychain date formats.
pub fn save_once(
    vault: &dyn Vault,
    scope: &str,
    key: &str,
    value: &str,
    now_secs: u64,
) -> Result<()> {
    vault.write(&once_account(scope, key), &format!("{now_secs}:{value}"))
}

fn once_value(stamped: &str) -> &str {
    stamped.split_once(':').map_or(stamped, |(_, value)| value)
}

pub fn has_once(vault: &dyn Vault, scope: &str, key: &str) -> Result<bool> {
    Ok(vault.read(&once_account(scope, key))?.is_some())
}

pub fn has_saved(vault: &dyn Vault, scope: &str, key: &str) -> Result<bool> {
    Ok(vault.read(&account(scope, key))?.is_some())
}

/// A once-only value wins over a saved one, and reading it consumes it.
pub fn take(vault: &dyn Vault, scope: &str, key: &str) -> Result<Option<String>> {
    let once = once_account(scope, key);
    if let Some(stamped) = vault.read(&once)? {
        vault.remove(&once)?;
        return Ok(Some(once_value(&stamped).to_string()));
    }
    vault.read(&account(scope, key))
}

pub fn forget(vault: &dyn Vault, scope: &str, key: &str) -> Result<()> {
    vault.remove(&account(scope, key))?;
    vault.remove(&once_account(scope, key))
}

pub fn sweep_stale_once(vault: &dyn Vault, now_secs: u64) -> Result<()> {
    for name in vault
        .accounts()?
        .iter()
        .filter(|a| a.ends_with(ONCE_SUFFIX))
    {
        let Some(stamped) = vault.read(name)? else {
            continue;
        };
        let created: u64 = stamped
            .split_once(':')
            .and_then(|(t, _)| t.parse().ok())
            .unwrap_or(0);
        if now_secs.saturating_sub(created) > ONCE_TTL_SECS {
            vault.remove(name)?;
        }
    }
    Ok(())
}

/// Every value held for a scope, for scrubbing child process output.
pub fn scope_values(vault: &dyn Vault, scope: &str) -> Result<Vec<(String, String)>> {
    let prefix = format!("{scope}/");
    let mut out = Vec::new();
    for name in vault.accounts()? {
        let Some(key) = name.strip_prefix(&prefix) else {
            continue;
        };
        let Some(value) = vault.read(&name)? else {
            continue;
        };
        match key.strip_suffix(ONCE_SUFFIX) {
            Some(base) => out.push((base.to_string(), once_value(&value).to_string())),
            None => out.push((key.to_string(), value)),
        }
    }
    Ok(out)
}

#[cfg(test)]
pub mod memory {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    #[derive(Default)]
    pub struct MemoryVault(pub RefCell<BTreeMap<String, String>>);

    impl Vault for MemoryVault {
        fn read(&self, account: &str) -> Result<Option<String>> {
            Ok(self.0.borrow().get(account).cloned())
        }
        fn write(&self, account: &str, value: &str) -> Result<()> {
            self.0.borrow_mut().insert(account.into(), value.into());
            Ok(())
        }
        fn remove(&self, account: &str) -> Result<()> {
            self.0.borrow_mut().remove(account);
            Ok(())
        }
        fn accounts(&self) -> Result<Vec<String>> {
            Ok(self.0.borrow().keys().cloned().collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::memory::MemoryVault;
    use super::*;

    #[test]
    fn once_value_is_preferred_and_consumed() {
        let v = MemoryVault::default();
        save(&v, "a.test", "k", "saved").unwrap();
        save_once(&v, "a.test", "k", "with:colon", 100).unwrap();
        assert_eq!(
            take(&v, "a.test", "k").unwrap().as_deref(),
            Some("with:colon")
        );
        assert_eq!(take(&v, "a.test", "k").unwrap().as_deref(), Some("saved"));
    }

    #[test]
    fn only_expired_once_values_are_swept() {
        let v = MemoryVault::default();
        save(&v, "a.test", "kept", "x").unwrap();
        save_once(&v, "a.test", "old", "x", 100).unwrap();
        save_once(&v, "a.test", "new", "x", 1000).unwrap();
        sweep_stale_once(&v, 1100).unwrap();
        assert!(has_saved(&v, "a.test", "kept").unwrap());
        assert!(!has_once(&v, "a.test", "old").unwrap());
        assert!(has_once(&v, "a.test", "new").unwrap());
    }

    #[test]
    fn scope_values_are_isolated_by_host() {
        let v = MemoryVault::default();
        save(&v, "a.test", "k", "one").unwrap();
        save(&v, "b.test", "k", "two").unwrap();
        save_once(&v, "a.test", "c", "three", 1).unwrap();
        let mut values = scope_values(&v, "a.test").unwrap();
        values.sort();
        assert_eq!(
            values,
            vec![
                ("c".to_string(), "three".to_string()),
                ("k".to_string(), "one".to_string())
            ]
        );
    }
}
